// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported Overview, ANIMATION_TIME */

const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;
const Signals = imports.misc.signals;

// Time for initial animation going into Overview mode;
// this is defined here to make it available in imports.
var ANIMATION_TIME = 250;

const DND = imports.ui.dnd;
const EdgeDragAction = imports.ui.edgeDragAction;
const LayoutManager = imports.ui.layout;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const OverviewControls = imports.ui.overviewControls;
const Params = imports.misc.params;
const SwipeTracker = imports.ui.swipeTracker;
const WindowManager = imports.ui.windowManager;
const WindowPreview = imports.ui.windowPreview;
const WorkspaceThumbnail = imports.ui.workspaceThumbnail;

var DND_WINDOW_SWITCH_TIMEOUT = 750;

var OVERVIEW_ACTIVATION_TIMEOUT = 0.5;

var ShellInfo = class {
    constructor() {
        this._source = null;
    }

    setMessage(text, options) {
        options = Params.parse(options, {
            undoCallback: null,
            forFeedback: false,
        });

        let undoCallback = options.undoCallback;
        let forFeedback = options.forFeedback;

        if (this._source == null) {
            this._source = new MessageTray.SystemNotificationSource();
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }

        let notification = null;
        if (this._source.notifications.length == 0) {
            notification = new MessageTray.Notification(this._source, text, null);
            notification.setTransient(true);
            notification.setForFeedback(forFeedback);
        } else {
            notification = this._source.notifications[0];
            notification.update(text, null, { clear: true });
        }

        if (undoCallback)
            notification.addAction(_('Undo'), () => undoCallback());

        this._source.showNotification(notification);
    }
};

var OverviewActor = GObject.registerClass(
class OverviewActor extends St.BoxLayout {
    _init() {
        super._init({
            name: 'overview',
            /* Translators: This is the main view to select
                activities. See also note for "Activities" string. */
            accessible_name: _("Overview"),
            vertical: true,
        });

        this.add_constraint(new LayoutManager.MonitorConstraint({ primary: true }));

        this._controls = new OverviewControls.ControlsManager();
        this.add_child(this._controls);
    }

    animateToOverview(state, callback) {
        this._controls.animateToOverview(state, callback);
    }

    animateFromOverview(callback) {
        this._controls.animateFromOverview(callback);
    }

    runStartupAnimation(callback) {
        this._controls.runStartupAnimation(callback);
    }

    get dash() {
        return this._controls.dash;
    }

    get searchEntry() {
        return this._controls.searchEntry;
    }

    get controls() {
        return this._controls;
    }
});

var Overview = class extends Signals.EventEmitter {
    constructor() {
        super();

        this._initCalled = false;
        this._visible = false;

        Main.sessionMode.connect('updated', this._sessionUpdated.bind(this));
        this._sessionUpdated();
    }

    get dash() {
        return this._overview.dash;
    }

    get dashIconSize() {
        logError(new Error('Usage of Overview.\'dashIconSize\' is deprecated, ' +
            'use \'dash.iconSize\' property instead'));
        return this.dash.iconSize;
    }

    get animationInProgress() {
        return this._animationInProgress;
    }

    get visible() {
        return this._visible;
    }

    get visibleTarget() {
        return this._visibleTarget;
    }

    get closing() {
        return this._animationInProgress && !this._visibleTarget;
    }

    _createOverview() {
        if (this._overview)
            return;

        if (this.isDummy)
            return;

        this._activationTime = 0;

        this._visible = false;          // animating to overview, in overview, animating out
        this._shown = false;            // show() and not hide()
        this._modal = false;            // have a modal grab
        this._animationInProgress = false;
        this._visibleTarget = false;

        // During transitions, we raise this to the top to avoid having the overview
        // area be reactive; it causes too many issues such as double clicks on
        // Dash elements, or mouseover handlers in the workspaces.
        this._coverPane = new Clutter.Actor({
            opacity: 0,
            reactive: true,
        });
        Main.layoutManager.overviewGroup.add_child(this._coverPane);
        this._coverPane.connect('event', (_actor, event) => {
            return event.type() === Clutter.EventType.ENTER ||
                event.type() === Clutter.EventType.LEAVE
                ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
        });
        this._coverPane.hide();

        // XDND
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };


        Main.layoutManager.overviewGroup.connect('scroll-event',
                                                 this._onScrollEvent.bind(this));
        Main.xdndHandler.connect('drag-begin', this._onDragBegin.bind(this));
        Main.xdndHandler.connect('drag-end', this._onDragEnd.bind(this));

        global.display.connect('restacked', this._onRestacked.bind(this));

        this._windowSwitchTimeoutId = 0;
        this._windowSwitchTimestamp = 0;
        this._lastActiveWorkspaceIndex = -1;
        this._lastHoveredWindow = null;

        if (this._initCalled)
            this.init();
    }

    _sessionUpdated() {
        const { hasOverview } = Main.sessionMode;
        if (!hasOverview)
            this.hide();

        this.isDummy = !hasOverview;
        this._createOverview();
    }

    // The members we construct that are implemented in JS might
    // want to access the overview as Main.overview to connect
    // signal handlers and so forth. So we create them after
    // construction in this init() method.
    init() {
        this._initCalled = true;

        if (this.isDummy)
            return;

        this._overview = new OverviewActor();
        this._overview._delegate = this;
        Main.layoutManager.overviewGroup.add_child(this._overview);

        this._shellInfo = new ShellInfo();

        Main.layoutManager.connect('monitors-changed', this._relayout.bind(this));
        this._relayout();

        Main.wm.addKeybinding(
            'toggle-overview',
            new Gio.Settings({ schema_id: WindowManager.SHELL_KEYBINDINGS_SCHEMA }),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this.toggle.bind(this));

        const threeFingerOverviewGesture = new SwipeTracker.SwipeTracker(
            Clutter.Orientation.VERTICAL,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            { allowDrag: false, allowScroll: false });
        threeFingerOverviewGesture.connect('begin', this._overviewGestureBegin.bind(this));
        threeFingerOverviewGesture.connect('update', this._overviewGestureUpdate.bind(this));
        threeFingerOverviewGesture.connect('end', this._overviewGestureEnd.bind(this));
        global.stage.add_action_full('Three finger overview gesture',
            Clutter.EventPhase.CAPTURE, threeFingerOverviewGesture);
        this._threeFingerOverviewGesture = threeFingerOverviewGesture;

        const threeFingerWorkspacesGesture = new SwipeTracker.SwipeTracker(
            Clutter.Orientation.HORIZONTAL,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            { allowDrag: false });
        threeFingerWorkspacesGesture.connect('begin', this._workspacesGestureBegin.bind(this));
        threeFingerWorkspacesGesture.connect('update', this._workspacesGestureUpdate.bind(this));
        threeFingerWorkspacesGesture.connect('end', this._workspacesGestureEnd.bind(this));
        global.stage.add_action_full('Three finger workspaces gesture',
            Clutter.EventPhase.CAPTURE, threeFingerWorkspacesGesture);
        this._threeFingerWorkspacesGesture = threeFingerWorkspacesGesture;

        global.display.bind_property('compositor-modifiers',
            this._threeFingerWorkspacesGesture, 'scroll-modifiers',
            GObject.BindingFlags.SYNC_CREATE);

        this._threeFingerOverviewGesture.make2d(this._threeFingerWorkspacesGesture);

        const singleFingerOverviewGesture = new EdgeDragAction.EdgeSwipeTracker(
            St.Side.BOTTOM,
            Clutter.Orientation.VERTICAL,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            { allowScroll: false });
        singleFingerOverviewGesture.connect('begin', this._overviewGestureBegin.bind(this));
        singleFingerOverviewGesture.connect('update', this._overviewGestureUpdate.bind(this));
        singleFingerOverviewGesture.connect('end', this._overviewGestureEnd.bind(this));
        global.stage.add_action_full('Single finger overview gesture',
            Clutter.EventPhase.BUBBLE, singleFingerOverviewGesture);
        this._singleFingerOverviewGesture = singleFingerOverviewGesture;

        Main.wm.workspaceTracker.connect('notify::zero-open-windows', () => {
            this._threeFingerOverviewGesture.enabled = !Main.wm.workspaceTracker.zeroOpenWindows;
            this._singleFingerOverviewGesture.enabled = !Main.wm.workspaceTracker.zeroOpenWindows;
        });

        this._threeFingerOverviewGesture.enabled = !Main.wm.workspaceTracker.zeroOpenWindows;
        this._singleFingerOverviewGesture.enabled = !Main.wm.workspaceTracker.zeroOpenWindows;

        const singleFingerWorkspacesGesture = new EdgeDragAction.EdgeSwipeTracker(
            St.Side.BOTTOM,
            Clutter.Orientation.HORIZONTAL,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        singleFingerWorkspacesGesture.connect('begin', this._workspacesGestureBegin.bind(this));
        singleFingerWorkspacesGesture.connect('update', this._workspacesGestureUpdate.bind(this));
        singleFingerWorkspacesGesture.connect('end', this._workspacesGestureEnd.bind(this));
        global.stage.add_action_full('Single finger workspaces gesture',
            Clutter.EventPhase.BUBBLE, singleFingerWorkspacesGesture);
        this._singleFingerWorkspacesGesture = singleFingerWorkspacesGesture;

        this._singleFingerOverviewGesture.make2d(this._singleFingerWorkspacesGesture);

        const workspaceManager = global.workspace_manager;

        workspaceManager.connectObject('notify::layout-rows', () => {
            this._threeFingerWorkspacesGesture.enabled =
                workspaceManager.layoutRows !== -1;
            this._singleFingerWorkspacesGesture.enabled =
                workspaceManager.layoutRows !== -1;
        }, this);

        this._threeFingerWorkspacesGesture.enabled =
            workspaceManager.layoutRows !== -1;
        this._singleFingerWorkspacesGesture.enabled =
            workspaceManager.layoutRows !== -1;
    }

    //
    // options:
    //  - undoCallback (function): the callback to be called if undo support is needed
    //  - forFeedback (boolean): whether the message is for direct feedback of a user action
    //
    setMessage(text, options) {
        if (this.isDummy)
            return;

        this._shellInfo.setMessage(text, options);
    }

    _onDragBegin() {
        this._inXdndDrag = true;

        DND.addDragMonitor(this._dragMonitor);
        // Remember the workspace we started from
        let workspaceManager = global.workspace_manager;
        this._lastActiveWorkspaceIndex = workspaceManager.get_active_workspace_index();
    }

    _onDragEnd() {
        this._inXdndDrag = false;

        // In case the drag was canceled while in the overview
        // we have to go back to where we started and hide
        // the overview
        if (this._shown) {
            let workspaceManager = global.workspace_manager;
            workspaceManager.get_workspace_by_index(this._lastActiveWorkspaceIndex)
                .activate(global.get_current_time());
            this.hide();
        }
        this._resetWindowSwitchTimeout();
        this._lastHoveredWindow = null;
        DND.removeDragMonitor(this._dragMonitor);
        this.endItemDrag();
    }

    _resetWindowSwitchTimeout() {
        if (this._windowSwitchTimeoutId != 0) {
            GLib.source_remove(this._windowSwitchTimeoutId);
            this._windowSwitchTimeoutId = 0;
        }
    }

    _onDragMotion(dragEvent) {
        let targetIsWindow = dragEvent.targetActor &&
                             dragEvent.targetActor._delegate &&
                             dragEvent.targetActor._delegate.metaWindow &&
                             !(dragEvent.targetActor._delegate instanceof WorkspaceThumbnail.WindowClone);

        this._windowSwitchTimestamp = global.get_current_time();

        if (targetIsWindow &&
            dragEvent.targetActor._delegate.metaWindow == this._lastHoveredWindow)
            return DND.DragMotionResult.CONTINUE;

        this._lastHoveredWindow = null;

        this._resetWindowSwitchTimeout();

        if (targetIsWindow) {
            this._lastHoveredWindow = dragEvent.targetActor._delegate.metaWindow;
            this._windowSwitchTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                DND_WINDOW_SWITCH_TIMEOUT,
                () => {
                    this._windowSwitchTimeoutId = 0;
                    Main.activateWindow(dragEvent.targetActor._delegate.metaWindow,
                                        this._windowSwitchTimestamp);
                    this.hide();
                    this._lastHoveredWindow = null;
                    return GLib.SOURCE_REMOVE;
                });
            GLib.Source.set_name_by_id(this._windowSwitchTimeoutId, '[gnome-shell] Main.activateWindow');
        }

        return DND.DragMotionResult.CONTINUE;
    }

    _onScrollEvent(actor, event) {
        this.emit('scroll-event', event);
        return Clutter.EVENT_PROPAGATE;
    }

    _relayout() {
        // To avoid updating the position and size of the workspaces
        // we just hide the overview. The positions will be updated
        // when it is next shown.
        this.hide();

        this._coverPane.set_position(0, 0);
        this._coverPane.set_size(global.screen_width, global.screen_height);
    }

    _onRestacked() {
        let stack = global.get_window_actors();
        let stackIndices = {};

        for (let i = 0; i < stack.length; i++) {
            // Use the stable sequence for an integer to use as a hash key
            stackIndices[stack[i].get_meta_window().get_stable_sequence()] = i;
        }

        this.emit('windows-restacked', stackIndices);
    }

    _overviewGestureBegin(tracker) {
        const hidden = !this._shown;
        if (hidden) {
imports.gi.Cogl.trace_generic_begin("_overviewGestureBegin unredi ");
            Meta.disable_unredirect_for_display(global.display);
imports.gi.Cogl.trace_generic_end();
            this._shown = true;
            this._visible = true;
            this._visibleTarget = true;
            this._animationInProgress = true;

            Main.layoutManager.showOverview();
imports.gi.Cogl.trace_generic_begin("_overviewGestureBegin sync grab ");
            this._syncGrab();
imports.gi.Cogl.trace_generic_end();
        }

        delete this._shownForWorkspacesGesture;
        this._visible = true; // FIXME: do we really need this
        this._visibleTarget = true;// FIXME: do we really need this?


        this._overview.controls.overviewGestureBegin(tracker);
imports.gi.Cogl.trace_generic_begin("_overviewGestureBegin emitting showing");
        if (hidden)
            this.emit('showing');
imports.gi.Cogl.trace_generic_end();
        this._singleFingerOverviewGesture.allowSwipeAnywhere = true;
    }

    _overviewGestureUpdate(tracker, progress) {
        this._overview.controls.overviewGestureProgress(tracker, progress);
    }

    _overviewGestureEnd(tracker, duration, endProgress, endCb) {
        let onStopped;
        if (endProgress === 0) {
            this._animationInProgress = true;
            this._shown = false;
            this._visibleTarget = false;
            this.emit('hiding');
            Main.panel.style = `transition-duration: ${duration}ms;`;
            onStopped = (finished) => {
                endCb();
                if (finished)
                    this._hideDone();
            };
        } else {
            onStopped = (finished) => {
                endCb();
                if (finished)
                    this._showDone();
            }
        }

        this._overview.controls.overviewGestureEnd(endProgress, duration, onStopped);
    }

    _workspacesGestureBegin(tracker, monitor) {
        const hidden = !this._shown;
        if (hidden) {
            this._shownForWorkspacesGesture = true;

            Meta.disable_unredirect_for_display(global.display);

            this._shown = true;
            this._animationInProgress = true;

            Main.layoutManager.showOverview();
            this._syncGrab();
        }

        this._overview.controls.workspacesGestureBegin(tracker, monitor);

        if (hidden)
            this.emit('showing');
    }

    _workspacesGestureUpdate(tracker, progress) {
        this._overview.controls.workspacesGestureProgress(tracker, progress);
    }

    _workspacesGestureEnd(tracker, duration, endProgress, endCb) {
        let onStopped = (finished) => {
            endCb();
        };

        if (this._shownForWorkspacesGesture) {
            this._animationInProgress = true;
            this._shown = false;
            this.emit('hiding');
            Main.panel.style = `transition-duration: ${duration}ms;`;

            onStopped = (finished) => {
                endCb();

                if (finished) {
                    this._hideDone();

                    delete this._shownForWorkspacesGesture;
                }
            };
        }

        this._overview.controls.workspacesGestureEnd(tracker, duration, endProgress, onStopped);
    }

    cancelSwitchWorkspace() {
        this._overview.controls.cancelSwitchToActiveWorkspace()
    }

    switchToActiveWorkspace(animate, onStopped, onTopWindow = null) {
        if (this._animationInProgress) {
            onStopped(true);
//            this._overview.controls.switchToActiveWorkspace(false, onStopped);
            return;
        }

        let clone = null;
        if (onTopWindow) {
            onTopWindow._hideFromOverview = true;;

            clone = new WindowPreview.WindowPreview(onTopWindow, null, null);
            clone.overlay_enabled = false;
            clone.x = clone.boundingBox.x;
            clone.y = clone.boundingBox.y;

            Main.uiGroup.add_child(clone);
        }

        let stoppedCb = (finished) => {
            if (onTopWindow) {
                clone.destroy();
                delete onTopWindow._hideFromOverview;
            }

            onStopped(finished);
        };

        if (!this._shown) {
            Meta.disable_unredirect_for_display(global.display);
            this._shown = true;
            this._animationInProgress = true;
            this.emit('showing');
            Main.layoutManager.showOverview();
            this._syncGrab();

            stoppedCb = (finished) => {
                if (onTopWindow) {
                    clone.destroy();
                    delete onTopWindow._hideFromOverview;
                }

                this._shown = false;
                this.emit('hiding');
                Main.panel.style = `transition-duration: 0ms;`;
                this._hideDone();

                onStopped(finished);
            }
        }

        this._overview.controls.switchToActiveWorkspace(true, stoppedCb);
    }

    beginItemDrag(source) {
        this.emit('item-drag-begin', source);
        this._inItemDrag = true;
    }

    cancelledItemDrag(source) {
        this.emit('item-drag-cancelled', source);
    }

    endItemDrag(source) {
        if (!this._inItemDrag)
            return;
        this.emit('item-drag-end', source);
        this._inItemDrag = false;
    }

    beginWindowDrag(window) {
        this.emit('window-drag-begin', window);
        this._inWindowDrag = true;
    }

    cancelledWindowDrag(window) {
        this.emit('window-drag-cancelled', window);
    }

    endWindowDrag(window) {
        if (!this._inWindowDrag)
            return;
        this.emit('window-drag-end', window);
        this._inWindowDrag = false;
    }

    focusSearch() {
        this.show();
        this._overview.searchEntry.grab_key_focus();
    }

    // Checks if the Activities button is currently sensitive to
    // clicks. The first call to this function within the
    // OVERVIEW_ACTIVATION_TIMEOUT time of the hot corner being
    // triggered will return false. This avoids opening and closing
    // the overview if the user both triggered the hot corner and
    // clicked the Activities button.
    shouldToggleByCornerOrButton() {
        if (this._animationInProgress)
            return false;
        if (this._inItemDrag || this._inWindowDrag)
            return false;
        if (!this._activationTime ||
            GLib.get_monotonic_time() / GLib.USEC_PER_SEC - this._activationTime > OVERVIEW_ACTIVATION_TIMEOUT)
            return true;
        return false;
    }

    _syncGrab() {
        // We delay grab changes during animation so that when removing the
        // overview we don't have a problem with the release of a press/release
        // going to an application.
        if (this._animationInProgress)
            return true;

        if (this._shown) {
            let shouldBeModal = !this._inXdndDrag;
            if (shouldBeModal && !this._modal) {
                if (global.display.get_grab_op() !== Meta.GrabOp.NONE) {
                    this.hide();
                    return false;
                }

                const grab = Main.pushModal(global.stage, {
                    actionMode: Shell.ActionMode.OVERVIEW,
                });
                if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
                    Main.popModal(grab);
                    this.hide();
                    return false;
                }

                this._grab = grab;
                this._modal = true;
            }
        } else {
            // eslint-disable-next-line no-lonely-if
            if (this._modal) {
                Main.popModal(this._grab);
                this._grab = false;
                this._modal = false;
            }
        }
        return true;
    }

    // show:
    //
    // Animates the overview visible and grabs mouse and keyboard input
    show(state = OverviewControls.ControlsState.WINDOW_PICKER) {
        if (state === OverviewControls.ControlsState.HIDDEN)
            throw new Error('Invalid state, use hide() to hide');

        if (this.isDummy)
            return;
        if (this._shown)
            return;
        this._shown = true;

        if (!this._syncGrab())
            return;

        Main.layoutManager.showOverview();
        this._animateVisible(state);
    }


    _animateVisible(state) {
        if (this._visible || this._animationInProgress)
            return;
imports.gi.Cogl.trace_generic_begin("overview anim visible");

        this._visible = true;
        this._animationInProgress = true;
        this._visibleTarget = true;
        this._activationTime = GLib.get_monotonic_time() / GLib.USEC_PER_SEC;

        Meta.disable_unredirect_for_display(global.display);

        this._overview.animateToOverview(state, () => this._showDone());

        Main.layoutManager.overviewGroup.set_child_above_sibling(
            this._coverPane, null);
        this._coverPane.show();
imports.gi.Cogl.trace_generic_end();
imports.gi.Cogl.trace_generic_begin("emitting showing");
        this.emit('showing');
imports.gi.Cogl.trace_generic_end();

    }

    _showDone() {
        this._animationInProgress = false;
        this._coverPane.hide();

        this.emit('shown');
        // Handle any calls to hide* while we were showing
        if (!this._shown)
            this._animateNotVisible();

        this._syncGrab();

        this._threeFingerWorkspacesGesture.allowLongSwipes = true;
        this._singleFingerWorkspacesGesture.enabled = false;
    }

    // hide:
    //
    // Reverses the effect of show()
    hide() {
        if (this.isDummy)
            return;

        if (!this._shown)
            return;

        let event = Clutter.get_current_event();
        if (event) {
            let type = event.type();
            let button = type == Clutter.EventType.BUTTON_PRESS ||
                          type == Clutter.EventType.BUTTON_RELEASE;
            let ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) != 0;
            if (button && ctrl)
                return;
        }

        this._shown = false;

        this._animateNotVisible();
        this._syncGrab();
    }

    _animateNotVisible() {
        if (!this._visible || this._animationInProgress)
            return;

        this._animationInProgress = true;
        this._visibleTarget = false;

        this._overview.animateFromOverview(() => this._hideDone());

        Main.layoutManager.overviewGroup.set_child_above_sibling(
            this._coverPane, null);
        this._coverPane.show();
        this.emit('hiding');
    }

    _hideDone() {
        // Re-enable unredirection
        Meta.enable_unredirect_for_display(global.display);

        this._threeFingerWorkspacesGesture.allowLongSwipes = false;
        this._singleFingerWorkspacesGesture.enabled = true;
        this._singleFingerOverviewGesture.allowSwipeAnywhere = false;

        this._coverPane.hide();

        this._visible = false;
        this._animationInProgress = false;

        // disallow hiding and show again, needed for when the screen is turned :/
        if (Main.wm.workspaceTracker.zeroOpenWindows) {
            this.show(2)
        }

        // Handle any calls to show* while we were hiding
        if (this._shown) {
            this.emit('hidden');
            this._animateVisible(OverviewControls.ControlsState.WINDOW_PICKER);
        } else {
            Main.layoutManager.hideOverview();
            this.emit('hidden');
        }

        Main.panel.style = null;

        this._syncGrab();
    }

    toggle() {
        if (this.isDummy)
            return;

        if (this._visible)
            this.hide();
        else
            this.show();
    }

    showApps() {
        this.show(OverviewControls.ControlsState.APP_GRID);
    }

    selectApp(id) {
        this.showApps();
        this._overview.controls.appDisplay.selectApp(id);
    }

    runStartupAnimation(callback) {
        Main.panel.style = 'transition-duration: 0ms;';

        this._shown = true;
        this._visible = true;
        this._visibleTarget = true;
        Main.layoutManager.showOverview();
        // We should call this._syncGrab() here, but moved it to happen after
        // the animation because of a race in the xserver where the grab
        // fails when requested very early during startup.

        Meta.disable_unredirect_for_display(global.display);

        this.emit('showing');

        this._overview.runStartupAnimation(() => {
            if (!this._syncGrab()) {
                callback();
                return;
            }

            this._showDone();
            callback();
        });
    }

    getShowAppsButton() {
        logError(new Error('Usage of Overview.\'getShowAppsButton\' is deprecated, ' +
            'use \'dash.showAppsButton\' property instead'));

        return this.dash.showAppsButton;
    }

    get searchEntry() {
        return this._overview.searchEntry;
    }
};
