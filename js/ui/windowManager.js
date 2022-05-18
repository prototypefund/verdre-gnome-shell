// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported WindowManager */

const { Clutter, Gio, GLib, GObject, Graphene, Meta, Shell, St } = imports.gi;

const AltTab = imports.ui.altTab;
const AppFavorites = imports.ui.appFavorites;
const Dialog = imports.ui.dialog;
const WorkspaceSwitcherPopup = imports.ui.workspaceSwitcherPopup;
const InhibitShortcutsDialog = imports.ui.inhibitShortcutsDialog;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const WindowMenu = imports.ui.windowMenu;
const Overview = imports.ui.overview;
const PadOsd = imports.ui.padOsd;
const EdgeDragAction = imports.ui.edgeDragAction;
const CloseDialog = imports.ui.closeDialog;
const SwitchMonitor = imports.ui.switchMonitor;
const IBusManager = imports.misc.ibusManager;
const WorkspaceAnimation = imports.ui.workspaceAnimation;

const { loadInterfaceXML } = imports.misc.fileUtils;

var SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
var MINIMIZE_WINDOW_ANIMATION_TIME = 400;
var MINIMIZE_WINDOW_ANIMATION_MODE = Clutter.AnimationMode.EASE_OUT_EXPO;
var SHOW_WINDOW_ANIMATION_TIME = 150;
var DIALOG_SHOW_WINDOW_ANIMATION_TIME = 100;
var DESTROY_WINDOW_ANIMATION_TIME = 150;
var DIALOG_DESTROY_WINDOW_ANIMATION_TIME = 100;
var WINDOW_ANIMATION_TIME = 250;
var SCROLL_TIMEOUT_TIME = 150;
var DIM_BRIGHTNESS = -0.3;
var DIM_TIME = 500;
var UNDIM_TIME = 250;
var APP_MOTION_THRESHOLD = 30;

var ONE_SECOND = 1000; // in ms

var MIN_NUM_WORKSPACES = 2;

const GSD_WACOM_BUS_NAME = 'org.gnome.SettingsDaemon.Wacom';
const GSD_WACOM_OBJECT_PATH = '/org/gnome/SettingsDaemon/Wacom';

const GsdWacomIface = loadInterfaceXML('org.gnome.SettingsDaemon.Wacom');
const GsdWacomProxy = Gio.DBusProxy.makeProxyWrapper(GsdWacomIface);

const WINDOW_DIMMER_EFFECT_NAME = "gnome-shell-window-dimmer";

Gio._promisify(Shell, 'util_start_systemd_unit');
Gio._promisify(Shell, 'util_stop_systemd_unit');

var DisplayChangeDialog = GObject.registerClass(
class DisplayChangeDialog extends ModalDialog.ModalDialog {
    _init(wm) {
        super._init();

        this._wm = wm;

        this._countDown = Meta.MonitorManager.get_display_configuration_timeout();

        // Translators: This string should be shorter than 30 characters
        let title = _('Keep these display settings?');
        let description = this._formatCountDown();

        this._content = new Dialog.MessageDialogContent({ title, description });
        this.contentLayout.add_child(this._content);

        /* Translators: this and the following message should be limited in length,
           to avoid ellipsizing the labels.
        */
        this._cancelButton = this.addButton({
            label: _('Revert Settings'),
            action: this._onFailure.bind(this),
            key: Clutter.KEY_Escape,
        });
        this._okButton = this.addButton({
            label: _('Keep Changes'),
            action: this._onSuccess.bind(this),
            default: true,
        });

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ONE_SECOND, this._tick.bind(this));
        GLib.Source.set_name_by_id(this._timeoutId, '[gnome-shell] this._tick');
    }

    close(timestamp) {
        if (this._timeoutId > 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        super.close(timestamp);
    }

    _formatCountDown() {
        const fmt = ngettext(
            'Settings changes will revert in %d second',
            'Settings changes will revert in %d seconds',
            this._countDown);
        return fmt.format(this._countDown);
    }

    _tick() {
        this._countDown--;

        if (this._countDown == 0) {
            /* mutter already takes care of failing at timeout */
            this._timeoutId = 0;
            this.close();
            return GLib.SOURCE_REMOVE;
        }

        this._content.description = this._formatCountDown();
        return GLib.SOURCE_CONTINUE;
    }

    _onFailure() {
        this._wm.complete_display_change(false);
        this.close();
    }

    _onSuccess() {
        this._wm.complete_display_change(true);
        this.close();
    }
});

var WindowDimmer = GObject.registerClass(
class WindowDimmer extends Clutter.BrightnessContrastEffect {
    _init() {
        super._init({
            name: WINDOW_DIMMER_EFFECT_NAME,
            enabled: false,
        });
    }

    _syncEnabled(dimmed) {
        let animating = this.actor.get_transition(`@effects.${this.name}.brightness`) !== null;

        this.enabled = Meta.prefs_get_attach_modal_dialogs() && (animating || dimmed);
    }

    setDimmed(dimmed, animate) {
        let val = 127 * (1 + (dimmed ? 1 : 0) * DIM_BRIGHTNESS);
        let color = Clutter.Color.new(val, val, val, 255);

        this.actor.ease_property(`@effects.${this.name}.brightness`, color, {
            mode: Clutter.AnimationMode.LINEAR,
            duration: (dimmed ? DIM_TIME : UNDIM_TIME) * (animate ? 1 : 0),
            onStopped: () => this._syncEnabled(dimmed),
        });

        this._syncEnabled(dimmed);
    }
});

function getWindowDimmer(actor) {
    let effect = actor.get_effect(WINDOW_DIMMER_EFFECT_NAME);

    if (!effect) {
        effect = new WindowDimmer();
        actor.add_effect(effect);
    }
    return effect;
}

var AppStartupAnimation = GObject.registerClass(
class AppStartupAnimation extends St.Widget {
    _init(app, workspace) {
        super._init({
            style_class: 'tmp-overlay',
            width: 0,
            height: 0,
x_expand:true, y_expand: true,
        });

        this._forceVisible = false;
        this._workspace = workspace;

        this._appIcon = app.create_icon_texture(128);
        this._appIcon.add_style_class_name('icon-dropshadow');
        this._appIcon.opacity = 255;
        this._appIcon.set_pivot_point(0.5, 0.5);

        this.add_child(this._appIcon);

        this._appIcon.add_constraint(new Clutter.AlignConstraint({
            source: this,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        this._appIcon.add_constraint(new Clutter.AlignConstraint({
            source: this,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 0.5,
        }));

        const wmId = global.window_manager.connect('switch-workspace', () => {
            if (this._forceVisible)
                return;

            this.visible = global.workspace_manager.get_active_workspace() === workspace;
        });

        this.connect('destroy', () => {
            global.window_manager.disconnect(wmId);
        });
    }

    set forceVisible(force) {
        this._forceVisible = force;

        if (force)
            this.show();
        else
            this.visible = global.workspace_manager.get_active_workspace() === this._workspace;
    }

    animateIn(existingAppIcon) {
        const iconExtents = existingAppIcon.get_transformed_extents();
        existingAppIcon.opacity = 0;

        this._appIcon.scale_x = iconExtents.size.width / 128;
        this._appIcon.scale_y = iconExtents.size.height / 128;

        this.set_position(iconExtents.origin.x + iconExtents.size.width / 2,
            iconExtents.origin.y + iconExtents.size.height / 2);

        this._appIcon.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 400,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        });

        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryMonitor)
        this.ease({
            width: workArea.width,
            height: workArea.height,
            x: workArea.x,
            y: workArea.y,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            duration: 400,
            onStopped: () => {
                existingAppIcon.opacity = 255;
            },
        });
    }

    _fadeOutAndDestroy() {
        if (this._clone) {
            this._clone.ease({
                opacity: 0,
                duration: 350,
                onStopped: () => this.destroy(),
            });
        } else {
            this.ease({
                opacity: 0,
                duration: 350,
                onStopped: () => this.destroy(),
            });
        }
    }

    animateOut() {
        const existingTransition = this.get_transition('width');
        if (existingTransition) {
            existingTransition.connect('stopped', (finished) => {
                this._fadeOutAndDestroy();
            });
        } else {
            this._fadeOutAndDestroy();
        }
    }
});

var SPLASHSCREEN_GRACE_TIME_MS = 1000;

var WorkspaceTracker = GObject.registerClass({
    Properties: {
        'single-window-workspaces': GObject.ParamSpec.boolean(
            'single-window-workspaces', 'single-window-workspaces', 'single-window-workspaces',
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class WorkspaceTracker extends GObject.Object {
    _init(params) {
        super._init(params);

        this._workspaces = [];
        this._windowData = new Map();
        this._updatesBlocked = false;

        const workspaceManager = global.workspace_manager;
        workspaceManager.connect('workspace-added',
            this._workspaceAdded.bind(this));
        workspaceManager.connect('workspace-removed',
            this._workspaceRemoved.bind(this));
        workspaceManager.connect('workspaces-reordered', () => {
            this._workspaces.sort((a, b) => a.index() - b.index());
        });

        global.window_manager.connect('switch-workspace',
            this._workspaceSwitched.bind(this));

        const tracker = Shell.WindowTracker.get_default();
        tracker.connect('startup-sequence-changed',
            this._startupSequenceChanged.bind(this));

        this.connect('notify::single-window-workspaces',
            this._redoLayout.bind(this));

        this._workspaceSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this._workspaceSettings.connect('changed::dynamic-workspaces',
            this._redoLayout.bind(this));

        for (let i = 0; i < workspaceManager.n_workspaces; i++)
            this._workspaceAdded(workspaceManager, i);

        this._redoLayout();
    }

    blockUpdates() {
        this._updatesBlocked = true;
    }

    unblockUpdates() {
        this._updatesBlocked = false;
        this._redoLayout();
    }

    _redoLayout() {
        if (this.singleWindowWorkspaces && !Meta.prefs_get_dynamic_workspaces()) {
            log("Disallowing single window workspaces: Dynamic workspaces are disabled");
            this._useSingleWindowWorkspaces = false;
        } else {
            this._useSingleWindowWorkspaces = this.singleWindowWorkspaces;
        }
log("WS: CHANGE single window: " + this._useSingleWindowWorkspaces);

        if (this._useSingleWindowWorkspaces) {
            for (const w of this._windowData.keys())
                this._maybeMoveToOwnWorkspace(w);

            this._workspaces.slice().reverse().forEach(w => this._maybeRemoveWorkspace(w));
        } else {
            for (const w of this._windowData.keys())
                w.set_can_grab(true);

            this._workspaces.forEach(w => {
                if (w._newTilingWorkspaceTimeoutId) {
                    GLib.source_remove(w._newTilingWorkspaceTimeoutId);
                    delete w._newTilingWorkspaceTimeoutId;
                }
            });

            if (Meta.prefs_get_dynamic_workspaces()) {
                const workspaceManager = global.workspace_manager;
                while (workspaceManager.n_workspaces < MIN_NUM_WORKSPACES)
                    workspaceManager.append_new_workspace(false, global.get_current_time());

                /* We always want one empty workspace at the end of the strip */
                if (this._workspaceHasOwnWindows(this._workspaces[this._workspaces.length - 1]))
                    workspaceManager.append_new_workspace(false, global.get_current_time());

                this._workspaces.slice().reverse().forEach(w => this._maybeRemoveWorkspace(w));
            }
        }
    }

    _workspaceHasOwnWindows(workspace) {
        for (const w of workspace.get_windows()) {
            if (!w.on_all_workspaces)
                return true;
        }

        return false;
    }

    _moveWindowToNewWorkspace(window, workspaceIndex) {
        const workspaceManager = global.workspace_manager;
        const newWorkspace =
            workspaceManager.append_new_workspace(true, global.display.get_current_time_roundtrip());

        workspaceManager.reorder_workspace(newWorkspace, workspaceIndex);
        window.change_workspace_by_index(workspaceIndex, false);
    }

    _maybeRemoveWorkspace(workspace) {
        const workspaceManager = global.workspace_manager;

log("WS: MAYBE remove removing ws " + workspace.workspace_index);

        if (this._updatesBlocked) {
log("WS: nope, updates are blocked");
            return;
}


        if (workspace._appStartingUp) {
log("WS: nope, has a startup sequence");
            return;
}

        if (workspace._splashscreenGraceTimeoutId) {
log("WS: nope, there's a grace timeout");
            return;
}

        if (this._workspaceHasOwnWindows(workspace)) {
log("WS: nope, its occupied");
            return;
}
        if (this._useSingleWindowWorkspaces) {
            if (workspace._newTilingWorkspaceTimeoutId) {
    log("WS: nope, has window added timeout");
                return;
    }

            if (workspace._appOpeningOverlay) {
                workspace._appOpeningOverlay.destroy(),
                delete workspace._appOpeningOverlay;
            }

            if (workspace.active)
                Main.overview.show(2);

            /* There must always be a default workspace, don't remove that one */
            if (this._workspaces.length > 1)
                workspaceManager.remove_workspace(workspace, 0);
else
log("WS: nope, it's the default one");


        } else {
            if (workspace.active ||
                this._workspaces.length === MIN_NUM_WORKSPACES)
                return;

            /* We always want one empty workspace at the end of the strip */
            if (workspace.workspace_index === this._workspaces.length - 1)
                return;

            workspaceManager.remove_workspace(workspace, 0);
        }
    }

    _windowShouldHaveOwnWorkspace(window) {
        /* Transient windows are usually modal dialogs */
        if (window.get_transient_for() !== null)
            return false;

        if (window.is_override_redirect())
            return false;

        if (window.on_all_workspaces)
            return false;

        if (window.window_type === Meta.WindowType.SPLASHSCREEN ||
            window.window_type === Meta.WindowType.DIALOG ||
            window.window_type === Meta.WindowType.MODAL_DIALOG)
            return false;

        return true;
    }

    _windowShouldBeGrabbable(window) {
        if (window.above)
            return true;

        /* Workaround for windows that are too big for the screen */
        // allow grabbing if the window has a width thats bigger
        // than the workarea so it can at least be moved horizontally...
        // vertically that wouldnt really help because window can
        // only be grabbed on the headerbar, so impossible to move them up more
        const frameRect = window.get_frame_rect();
        const workArea = window.get_work_area_current_monitor();
        if (frameRect.width > workArea.width || frameRect.height > workArea.height)
            return true;

        return false;
    }

    _maybeMoveToOwnWorkspace(window) {
log("WS:  updated should have own workspaces: " + this._windowData.get(window).shouldHaveOwnWorkspace);

        if (this._windowData.get(window).shouldHaveOwnWorkspace) {
            const windowWorkspace = window.get_workspace();
            let workspaceHasOtherWindows = false;
            for (const [w, data] of this._windowData.entries()) {
                if (w !== window &&
                    (w.get_workspace() === windowWorkspace || w.on_all_workspaces) &&
                    data.shouldHaveOwnWorkspace) {
                    workspaceHasOtherWindows = true;
                    break;
                }
            };

            if (workspaceHasOtherWindows) {
                log("WS: WINDOW ADDED: moving the window to new workspace");
                this._moveWindowToNewWorkspace(window, window.get_workspace().workspace_index + 1);
                return true;
            }
        }

    return false;
    }

    _windowAddedToWorkspace(workspace, window) {
        if (!window._laterDone) {
log("WS: " + workspace.workspace_index + " WIN ADDED " + workspace.n_windows + " delaying " + window.title);
            /* Give newly opened windows some time to sort things out. If we
             * passed a specific workspace the window should open on, it only
             * gets moved to this workspace after 'window-added' got emitted, we
             * want to wait until that happened.
             */
            window._addedLater = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                window._laterDone = true;
                delete window._addedLater;

                this._windowAddedToWorkspace(workspace, window);
                return false;
            });

            return;
        }

log("WS: " + workspace.workspace_index + " WIN ADDED " + workspace.n_windows + " inside later " + window.title);
        let windowData = this._windowData.get(window);
        if (!windowData) {
            this._windowData.set(window, {
                connections: [
                    window.connect('transient-for-changed', () => {
    log("WS: transient for change");
                        this._windowData.get(window).shouldHaveOwnWorkspace =
                            this._windowShouldHaveOwnWorkspace(window);

                        if (this._useSingleWindowWorkspaces)
                            this._maybeMoveToOwnWorkspace(window);

                        const transientFor = window.get_transient_for();
                        if (transientFor !== null) {
                            const transientForWorkspace = transientFor.get_workspace();
                            if (window.get_workspace() !== transientForWorkspace)
                                window.change_workspace(transientForWorkspace);
                        }
                    }),
                    window.connect('notify::window-type', () => {
    log("WS: window type change");
                        this._windowData.get(window).shouldHaveOwnWorkspace =
                            this._windowShouldHaveOwnWorkspace(window);

                        if (this._useSingleWindowWorkspaces)
                            this._maybeMoveToOwnWorkspace(window);
                    }),
                    window.connect('notify::above', () => {
    log("WS: above change");
                        if (this._useSingleWindowWorkspaces)
                            window.set_can_grab(this._windowShouldBeGrabbable(window));
                    }),
                    window.connect('size-changed', () => {
    log("WS: siye change");
                        if (((window.maximized_vertically && window.maximized_horizontally) || window.fullscreen) && workspace._appOpeningOverlay) {
                            workspace._appOpeningOverlay.animateOut();
                            delete workspace._appOpeningOverlay;
                        }

                        if (this._useSingleWindowWorkspaces)
                            window.set_can_grab(this._windowShouldBeGrabbable(window));
                    }),

                /*    window.connect('notify::on-all-workspaces', () => {
    log("WS: on-all-ws change");
                        if (this._useSingleWindowWorkspaces)
                            this._maybeMoveToOwnWorkspace(window);
                    }),*/ // no need to listen to that, mutter will remove and re-add windows anyway
                    window.connect('unmanaged', () => {
                        this._windowData.delete(window);
                    }),
                    window.connect('shown', () => {
        if (!window._waitForSizeChange && workspace._appOpeningOverlay) {
            workspace._appOpeningOverlay.animateOut();
            delete workspace._appOpeningOverlay;
        }
                    }),
                ],
            });

            windowData = this._windowData.get(window);
        }

        windowData.shouldHaveOwnWorkspace = this._windowShouldHaveOwnWorkspace(window);


        if (!Meta.prefs_get_dynamic_workspaces())
            return;

        /* Stickies don't count as real windows */
        if (window.on_all_workspaces)
            return;

        if (workspace._splashscreenGraceTimeoutId) {
log("WS: WINDOW ADDED: removing grace timeout thingy");
            GLib.source_remove(workspace._splashscreenGraceTimeoutId);
            delete workspace._splashscreenGraceTimeoutId;
        }


        if (this._useSingleWindowWorkspaces) {
            if (workspace._newTilingWorkspaceTimeoutId) {
    log("WS: WINDOW ADDED: was app workspace, that worked, neat");
                GLib.source_remove(workspace._newTilingWorkspaceTimeoutId);
                delete workspace._newTilingWorkspaceTimeoutId;
            }

            if (this._maybeMoveToOwnWorkspace(window))
                return; // let the new workspaces 'window-added' handler maximize the window

            const shouldMaximize = windowData.shouldHaveOwnWorkspace &&
                window.can_maximize() &&
                !(window.maximized_vertically && window.maximized_horizontally);

            if (shouldMaximize) {
log("WS: telling window to maxi");
                window.maximize(Meta.MaximizeFlags.BOTH);
window._waitForSizeChange = true;
                /* Wait for the size-change to finish before animating out the
                 * app opening overlay.
                 */
            } else if (window.get_compositor_private()?.visible) {
        if (workspace._appOpeningOverlay) {
            workspace._appOpeningOverlay.animateOut();
            delete workspace._appOpeningOverlay;
        }
            }

            window.set_can_grab(this._windowShouldBeGrabbable(window));
        } else {
            const workspaceManager = global.workspace_manager;

            /* We always want one empty workspace at the end of the strip */
            if (!this._updatesBlocked && workspace.workspace_index === this._workspaces.length - 1)
                workspaceManager.append_new_workspace(false, global.get_current_time());
        }
    }

    _windowRemovedFromWorkspace(workspace, window) {
        if (!window._laterDone) {
log("WS: " + workspace.workspace_index + " WIN REMOVED, " + workspace.n_windows + " we pretend nothing happened");
            Meta.later_remove(window._addedLater);
            delete window._addedLater;

            /* Window got removed so quickly again the MetaLater didn't even
             * execute, let's pretend nothing happened.
             */
            return;
        }

        if (!Meta.prefs_get_dynamic_workspaces())
            return;

        /* Stickies don't count as real windows */
        if (window.on_all_workspaces)
            return;

        const workspaceEmpty = !this._workspaceHasOwnWindows(workspace);

log("WS: " + workspace.workspace_index + " WIN REMOVED, " + workspace.n_windows + " " + window.title + " empty " + workspaceEmpty);

        if (workspaceEmpty) {
            if (workspace._splashscreenGraceTimeoutId)
                throw new Error();

            /* If the last window that got closed is a temporary one (like a
             * splashscreen), we leave the workspace around for a bit in case
             * the app maps another window.
             */
            if (window.window_type === Meta.WindowType.SPLASHSCREEN) {
log("WS: we have 0, delaying to later because splashscreen");
                workspace._splashscreenGraceTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, SPLASHSCREEN_GRACE_TIME_MS, () => {
log("WS: alright now is later");
                        delete workspace._splashscreenGraceTimeoutId;
                        this._maybeRemoveWorkspace(workspace);

                        return GLib.SOURCE_REMOVE;
                    });
            } else {
log("WS: we have 0, removing");

                if (window._content && !Main.overview.visible) {
                    let actorClone = new St.Widget({ content: window._content, });
            //        actorClone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
                    actorClone.set_position(window._rect.x, window._rect.y);
                    actorClone.set_size(window._rect.width, window._rect.height);
                    actorClone.set_pivot_point(0.5, 0.5);

                    Main.uiGroup.add_child(actorClone);
                    Main.uiGroup.set_child_above_sibling(actorClone, Main.layoutManager.overviewGroup);
                 /*   actorClone.ease({
                        scale_x: 0.8,
                        scale_y: 0.8,
                        duration: 200,
                        mode: Clutter.AnimationMode.EASE_IN_QUAD,
                        onStopped: () => {
                            actorClone.destroy();
                        },
                    });
            */
                    actorClone.ease({
                        delay: 0,
                        opacity: 0,
                        duration: 230,
                        mode: Clutter.AnimationMode.LINEAR,
                    });
                }

                this._maybeRemoveWorkspace(workspace);
            }
        }
    }

    maybeCreateWorkspaceForWindow(time, app, existingIcon) {
        if (!this._useSingleWindowWorkspaces)
            return null;

        if (!Meta.prefs_get_dynamic_workspaces())
            return null;

        let newWorkspaceIndex;

        /* The default workspace always exists, if it's empty and not
         * reserved already, use it.
         */
        if (this._workspaces.length === 1 &&
            !this._workspaces[0]._appStartingUp &&
            !this._workspaces[0]._splashscreenGraceTimeoutId &&
            !this._workspaces[0]._newTilingWorkspaceTimeoutId &&
            !this._workspaceHasOwnWindows(this._workspaces[0])) {
            newWorkspaceIndex = 0;
        } else {
            const workspaceManager = global.workspace_manager;

            workspaceManager.append_new_workspace(false, time);
            newWorkspaceIndex = workspaceManager.n_workspaces - 1;
        }
log("WS: created app workspace index " + newWorkspaceIndex);
        const newWorkspace = this._workspaces[newWorkspaceIndex];
        if (!newWorkspace)
            throw new Error();

        newWorkspace.activate(time);

        /* If no window or startup sequence appears within five seconds,
         * we remove the workspace again.
         */
        newWorkspace._newTilingWorkspaceTimeoutId =
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    log("WS: app ws " + newWorkspaceIndex + " timed out, removing");
                delete newWorkspace._newTilingWorkspaceTimeoutId;
                this._maybeRemoveWorkspace(newWorkspace);

                return GLib.SOURCE_REMOVE;
            });

        const animationActor = new AppStartupAnimation(app, newWorkspace);
        Main.uiGroup.add_child(animationActor);
        Main.uiGroup.set_child_above_sibling(animationActor, Main.layoutManager.overviewGroup);

        animationActor.animateIn(existingIcon);

        newWorkspace._appOpeningOverlay = animationActor;

        return newWorkspace;
    }

    _workspaceAdded(workspaceManager, index) {
        const newWorkspace = workspaceManager.get_workspace_by_index(index);
log("WS: added " + index);

        this._workspaces.splice(index, 0, newWorkspace);

        newWorkspace.connectObject(
            'window-added', this._windowAddedToWorkspace.bind(this),
            'window-removed', this._windowRemovedFromWorkspace.bind(this), this);
    }

    _workspaceRemoved(workspaceManager, index) {
log("WS: removed " + index);
        if (!this._workspaces[index])
            throw new Error();

        if (this._workspaces[index]._appStartingUp)
            throw new Error();

        if (this._workspaces[index]._splashscreenGraceTimeoutId)
            throw new Error();

        if (this._workspaces[index]._newTilingWorkspaceTimeoutId)
            throw new Error();

        if (this._workspaces[index]._appOpeningOverlay)
            throw new Error();

        this._workspaces.splice(index, 1);
    }

    _workspaceSwitched(shellwm, fromIndex, toIndex, direction) {
        if (!Meta.prefs_get_dynamic_workspaces())
            return;

        const workspaceManager = global.workspace_manager;

        if (!this._useSingleWindowWorkspaces) {
log("WS: switched, maybe reming index " + fromIndex);
            this._maybeRemoveWorkspace(workspaceManager.get_workspace_by_index(fromIndex));
}
    }

    _startupSequenceChanged(windowTracker, startupSequence) {
        if (!Meta.prefs_get_dynamic_workspaces())
            return;

        /* Note that the way startup sequences work is quite sub-optimal
         * right now: The workspace index gets set once when creating the
         * sequence and it won't get updated if workspaces change. That
         * means the index might be outdated and the window will open on
         * the wrong workspace.
         */

log("WS: startup sequence changed " + startupSequence + " ws " + startupSequence.get_workspace() + " comp " + startupSequence.get_completed());

        const sequences = Shell.WindowTracker.get_default().get_startup_sequences();
   /*     const workspacesStartingUp = [];
        for (const sequence of sequences) {
            if (sequence.get_completed())
                continue;

            const wsIndex = sequence.get_workspace();
            if (wsIndex >= 0 && wsIndex < this._workspaces.length)
                workspacesStartingUp[wsIndex] = true;
        }

        this._workspaces.slice().forEach((workspace, i) => {
            const wasStartingUp = workspace._appStartingUp;

            if (workspacesStartingUp[i]) {
                if (workspace._newTilingWorkspaceTimeoutId) {
        log("WS: STARTING UP : was app workspace, that worked, neat");
                    GLib.source_remove(workspace._newTilingWorkspaceTimeoutId);
                    delete workspace._newTilingWorkspaceTimeoutId;
                }

                workspace._appStartingUp = true;
            } else if (wasStartingUp) {
                delete workspace._appStartingUp;
                this._maybeRemoveWorkspace(workspace);
            }
        });
*/

        this._workspaces.slice().forEach((workspace, i) => {
            let isStartingUp = false;

            for (const sequence of sequences) {
                if (!sequence.get_completed() && sequence.get_workspace() === i) {
                    isStartingUp = true;
                    break;
                }
            }

            if (isStartingUp) {
               if (workspace._newTilingWorkspaceTimeoutId) {
                    log("WS: STARTING UP : was app workspace, that worked, neat");
                    GLib.source_remove(workspace._newTilingWorkspaceTimeoutId);
                    delete workspace._newTilingWorkspaceTimeoutId;
                }

                workspace._appStartingUp = true;
            } else if (workspace._appStartingUp) {
                delete workspace._appStartingUp;
                this._maybeRemoveWorkspace(workspace);
            }
        });
    }
});

var TilePreview = GObject.registerClass(
class TilePreview extends St.Widget {
    _init() {
        super._init();
        global.window_group.add_actor(this);

        this._reset();
        this._showing = false;
    }

    open(window, tileRect, monitorIndex) {
        let windowActor = window.get_compositor_private();
        if (!windowActor)
            return;

        global.window_group.set_child_below_sibling(this, windowActor);

        if (this._rect && this._rect.equal(tileRect))
            return;

        let changeMonitor = this._monitorIndex == -1 ||
                             this._monitorIndex != monitorIndex;

        this._monitorIndex = monitorIndex;
        this._rect = tileRect;

        let monitor = Main.layoutManager.monitors[monitorIndex];

        this._updateStyle(monitor);

        if (!this._showing || changeMonitor) {
            const monitorRect = new Meta.Rectangle({
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
            });
            let [, rect] = window.get_frame_rect().intersect(monitorRect);
            this.set_size(rect.width, rect.height);
            this.set_position(rect.x, rect.y);
            this.opacity = 0;
        }

        this._showing = true;
        this.show();
        this.ease({
            x: tileRect.x,
            y: tileRect.y,
            width: tileRect.width,
            height: tileRect.height,
            opacity: 255,
            duration: WINDOW_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (!this._showing)
            return;

        this._showing = false;
        this.ease({
            opacity: 0,
            duration: WINDOW_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._reset(),
        });
    }

    _reset() {
        this.hide();
        this._rect = null;
        this._monitorIndex = -1;
    }

    _updateStyle(monitor) {
        let styles = ['tile-preview'];
        if (this._monitorIndex == Main.layoutManager.primaryIndex)
            styles.push('on-primary');
        if (this._rect.x == monitor.x)
            styles.push('tile-preview-left');
        if (this._rect.x + this._rect.width == monitor.x + monitor.width)
            styles.push('tile-preview-right');

        this.style_class = styles.join(' ');
    }
});

var AppSwitchAction = GObject.registerClass({
    Signals: { 'activated': {} },
}, class AppSwitchAction extends Clutter.GestureAction {
    _init() {
        super._init();
        this.set_n_touch_points(3);

        global.display.connect('grab-op-begin', () => {
            this.cancel();
        });
    }

    vfunc_gesture_prepare(_actor) {
        if (Main.actionMode != Shell.ActionMode.NORMAL) {
            this.cancel();
            return false;
        }

        return this.get_n_current_points() <= 4;
    }

    vfunc_gesture_begin(_actor) {
        // in milliseconds
        const LONG_PRESS_TIMEOUT = 250;

        let nPoints = this.get_n_current_points();
        let event = this.get_last_event(nPoints - 1);

        if (nPoints == 3) {
            this._longPressStartTime = event.get_time();
        } else if (nPoints == 4) {
            // Check whether the 4th finger press happens after a 3-finger long press,
            // this only needs to be checked on the first 4th finger press
            if (this._longPressStartTime != null &&
                event.get_time() < this._longPressStartTime + LONG_PRESS_TIMEOUT) {
                this.cancel();
            } else {
                this._longPressStartTime = null;
                this.emit('activated');
            }
        }

        return this.get_n_current_points() <= 4;
    }

    vfunc_gesture_progress(_actor) {
        if (this.get_n_current_points() == 3) {
            for (let i = 0; i < this.get_n_current_points(); i++) {
                let [startX, startY] = this.get_press_coords(i);
                let [x, y] = this.get_motion_coords(i);

                if (Math.abs(x - startX) > APP_MOTION_THRESHOLD ||
                    Math.abs(y - startY) > APP_MOTION_THRESHOLD)
                    return false;
            }
        }

        return true;
    }
});

var ResizePopup = GObject.registerClass(
class ResizePopup extends St.Widget {
    _init() {
        super._init({ layout_manager: new Clutter.BinLayout() });
        this._label = new St.Label({
            style_class: 'resize-popup',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._label);
        Main.uiGroup.add_actor(this);
    }

    set(rect, displayW, displayH) {
        /* Translators: This represents the size of a window. The first number is
         * the width of the window and the second is the height. */
        let text = _("%d × %d").format(displayW, displayH);
        this._label.set_text(text);

        this.set_position(rect.x, rect.y);
        this.set_size(rect.width, rect.height);
    }
});

var WindowManager = class {
    constructor() {
        this._shellwm =  global.window_manager;

        this._minimizing = new Set();
        this._unminimizing = new Set();
        this._mapping = new Set();
        this._resizing = new Set();
        this._resizePending = new Set();
        this._destroying = new Set();

        this._dimmedWindows = [];

        this._skippedActors = new Set();

        this._allowedKeybindings = {};

        this._isWorkspacePrepended = false;
        this._canScroll = true; // limiting scrolling speed

        this._shellwm.connect('kill-window-effects', (shellwm, actor) => {
            this._minimizeWindowDone(shellwm, actor);
            this._mapWindowDone(shellwm, actor);
            this._destroyWindowDone(shellwm, actor);
            this._sizeChangeWindowDone(shellwm, actor);
        });

        this._shellwm.connect('switch-workspace', this._switchWorkspace.bind(this));
        this._shellwm.connect('show-tile-preview', this._showTilePreview.bind(this));
        this._shellwm.connect('hide-tile-preview', this._hideTilePreview.bind(this));
        this._shellwm.connect('show-window-menu', this._showWindowMenu.bind(this));
        this._shellwm.connect('minimize', this._minimizeWindow.bind(this));
        this._shellwm.connect('unminimize', this._unminimizeWindow.bind(this));
        this._shellwm.connect('size-change', this._sizeChangeWindow.bind(this));
        this._shellwm.connect('size-changed', this._sizeChangedWindow.bind(this));
        this._shellwm.connect('map', this._mapWindow.bind(this));
        this._shellwm.connect('destroy', this._destroyWindow.bind(this));
        this._shellwm.connect('filter-keybinding', this._filterKeybinding.bind(this));
        this._shellwm.connect('confirm-display-change', this._confirmDisplayChange.bind(this));
        this._shellwm.connect('create-close-dialog', this._createCloseDialog.bind(this));
        this._shellwm.connect('create-inhibit-shortcuts-dialog', this._createInhibitShortcutsDialog.bind(this));

        this._workspaceSwitcherPopup = null;
        this._tilePreview = null;

        this.allowKeybinding('switch-to-session-1', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-2', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-3', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-4', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-5', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-6', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-7', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-8', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-9', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-10', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-11', Shell.ActionMode.ALL);
        this.allowKeybinding('switch-to-session-12', Shell.ActionMode.ALL);

        this.setCustomKeybindingHandler('switch-to-workspace-left',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-right',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-up',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-down',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-last',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-left',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-right',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-up',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-down',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-1',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-2',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-3',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-4',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-5',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-6',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-7',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-8',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-9',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-10',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-11',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-to-workspace-12',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-1',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-2',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-3',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-4',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-5',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-6',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-7',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-8',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-9',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-10',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-11',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-12',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('move-to-workspace-last',
                                        Shell.ActionMode.NORMAL,
                                        this._showWorkspaceSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-applications',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-group',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-applications-backward',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-group-backward',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-windows',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-windows-backward',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('cycle-windows',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('cycle-windows-backward',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('cycle-group',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('cycle-group-backward',
                                        Shell.ActionMode.NORMAL,
                                        this._startSwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-panels',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW |
                                        Shell.ActionMode.LOCK_SCREEN |
                                        Shell.ActionMode.UNLOCK_SCREEN |
                                        Shell.ActionMode.LOGIN_SCREEN,
                                        this._startA11ySwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-panels-backward',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW |
                                        Shell.ActionMode.LOCK_SCREEN |
                                        Shell.ActionMode.UNLOCK_SCREEN |
                                        Shell.ActionMode.LOGIN_SCREEN,
                                        this._startA11ySwitcher.bind(this));
        this.setCustomKeybindingHandler('switch-monitor',
                                        Shell.ActionMode.NORMAL |
                                        Shell.ActionMode.OVERVIEW,
                                        this._startSwitcher.bind(this));

        this.addKeybinding('open-application-menu',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.POPUP,
                           this._toggleAppMenu.bind(this));

        this.addKeybinding('toggle-message-tray',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW |
                           Shell.ActionMode.POPUP,
                           this._toggleCalendar.bind(this));

        this.addKeybinding('switch-to-application-1',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW,
                           this._switchToApplication.bind(this));

        this.addKeybinding('switch-to-application-2',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW,
                           this._switchToApplication.bind(this));

        this.addKeybinding('switch-to-application-3',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW,
                           this._switchToApplication.bind(this));

        this.addKeybinding('switch-to-application-4',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW,
                           this._switchToApplication.bind(this));

        this.addKeybinding('switch-to-application-5',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW,
                           this._switchToApplication.bind(this));

        this.addKeybinding('switch-to-application-6',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW,
                           this._switchToApplication.bind(this));

        this.addKeybinding('switch-to-application-7',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW,
                           this._switchToApplication.bind(this));

        this.addKeybinding('switch-to-application-8',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW,
                           this._switchToApplication.bind(this));

        this.addKeybinding('switch-to-application-9',
                           new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                           Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                           Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW,
                           this._switchToApplication.bind(this));

        global.stage.connect('scroll-event', (stage, event) => {
            const allowedModes = Shell.ActionMode.NORMAL;
            if ((allowedModes & Main.actionMode) === 0)
                return Clutter.EVENT_PROPAGATE;

            if (this._workspaceAnimation.canHandleScrollEvent(event))
                return Clutter.EVENT_PROPAGATE;

            if ((event.get_state() & global.display.compositor_modifiers) === 0)
                return Clutter.EVENT_PROPAGATE;

            return this.handleWorkspaceScroll(event);
        });

        global.display.connect('show-resize-popup', this._showResizePopup.bind(this));
        global.display.connect('show-pad-osd', this._showPadOsd.bind(this));
        global.display.connect('show-osd', (display, monitorIndex, iconName, label) => {
            let icon = Gio.Icon.new_for_string(iconName);
            Main.osdWindowManager.show(monitorIndex, icon, label, null);
        });

        this._gsdWacomProxy = new GsdWacomProxy(Gio.DBus.session, GSD_WACOM_BUS_NAME,
                                                GSD_WACOM_OBJECT_PATH,
                                                (proxy, error) => {
                                                    if (error)
                                                        log(error.message);
                                                });

        global.display.connect('pad-mode-switch', (display, pad, _group, _mode) => {
            let labels = [];

            // FIXME: Fix num buttons
            for (let i = 0; i < 50; i++) {
                let str = display.get_pad_action_label(pad, Meta.PadActionType.BUTTON, i);
                labels.push(str ?? '');
            }

            this._gsdWacomProxy?.SetOLEDLabelsAsync(
                pad.get_device_node(), labels).catch(logError);
        });

        global.display.connect('init-xserver', (display, task) => {
            IBusManager.getIBusManager().restartDaemon(['--xim']);

            this._startX11Services(task);

            return true;
        });
        global.display.connect('x11-display-closing', () => {
            if (!Meta.is_wayland_compositor())
                return;

            this._stopX11Services(null);

            IBusManager.getIBusManager().restartDaemon();
        });

        Main.overview.connect('showing', () => {
            for (let i = 0; i < this._dimmedWindows.length; i++)
                this._undimWindow(this._dimmedWindows[i]);
        });
        Main.overview.connect('hiding', () => {
            for (let i = 0; i < this._dimmedWindows.length; i++)
                this._dimWindow(this._dimmedWindows[i]);
        });

        this._windowMenuManager = new WindowMenu.WindowMenuManager();

        if (Main.sessionMode.hasWorkspaces) {
            this.workspaceTracker = new WorkspaceTracker();

            Main.layoutManager.bind_property('is-phone',
                this.workspaceTracker, 'single-window-workspaces',
                GObject.BindingFlags.SYNC_CREATE);
        }

        let appSwitchAction = new AppSwitchAction();
        appSwitchAction.connect('activated', this._switchApp.bind(this));
        global.stage.add_action_full('app-switch', Clutter.EventPhase.CAPTURE, appSwitchAction);

        let mode = Shell.ActionMode.NORMAL;
        let topDragAction = new EdgeDragAction.EdgeDragAction(St.Side.TOP, mode);
        topDragAction.connect('activated',  () => {
            let currentWindow = global.display.focus_window;
            if (currentWindow)
                currentWindow.unmake_fullscreen();
        });

        let updateUnfullscreenGesture = () => {
            let currentWindow = global.display.focus_window;
            topDragAction.enabled = currentWindow && currentWindow.is_fullscreen();
        };

        global.display.connect('notify::focus-window', updateUnfullscreenGesture);
        global.display.connect('in-fullscreen-changed', updateUnfullscreenGesture);
        updateUnfullscreenGesture();

        global.stage.add_action_full('unfullscreen', Clutter.EventPhase.CAPTURE, topDragAction);

        this._workspaceAnimation =
            new WorkspaceAnimation.WorkspaceAnimationController();

        this._shellwm.connect('kill-switch-workspace', () => {
            this._workspaceAnimation.cancelSwitchAnimation();
            this._switchWorkspaceDone();
        });
    }

    async _startX11Services(task) {
        let status = true;
        try {
            await Shell.util_start_systemd_unit(
                'gnome-session-x11-services-ready.target', 'fail', null);
        } catch (e) {
            // Ignore NOT_SUPPORTED error, which indicates we are not systemd
            // managed and gnome-session will have taken care of everything
            // already.
            // Note that we do log cancellation from here.
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED)) {
                log(`Error starting X11 services: ${e.message}`);
                status = false;
            }
        } finally {
            task.return_boolean(status);
        }
    }

    async _stopX11Services(cancellable) {
        try {
            await Shell.util_stop_systemd_unit(
                'gnome-session-x11-services.target', 'fail', cancellable);
        } catch (e) {
            // Ignore NOT_SUPPORTED error, which indicates we are not systemd
            // managed and gnome-session will have taken care of everything
            // already.
            // Note that we do log cancellation from here.
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED))
                log(`Error stopping X11 services: ${e.message}`);
        }
    }

    _showPadOsd(display, device, settings, imagePath, editionMode, monitorIndex) {
        this._currentPadOsd = new PadOsd.PadOsd(device, settings, imagePath, editionMode, monitorIndex);
        this._currentPadOsd.connect('closed', () => (this._currentPadOsd = null));

        return this._currentPadOsd;
    }

    _lookupIndex(windows, metaWindow) {
        for (let i = 0; i < windows.length; i++) {
            if (windows[i].metaWindow == metaWindow)
                return i;
        }
        return -1;
    }

    _switchApp() {
        let windows = global.get_window_actors().filter(actor => {
            let win = actor.metaWindow;
            let workspaceManager = global.workspace_manager;
            let activeWorkspace = workspaceManager.get_active_workspace();
            return !win.is_override_redirect() &&
                    win.located_on_workspace(activeWorkspace);
        });

        if (windows.length == 0)
            return;

        let focusWindow = global.display.focus_window;
        let nextWindow;

        if (focusWindow == null) {
            nextWindow = windows[0].metaWindow;
        } else {
            let index = this._lookupIndex(windows, focusWindow) + 1;

            if (index >= windows.length)
                index = 0;

            nextWindow = windows[index].metaWindow;
        }

        Main.activateWindow(nextWindow);
    }

    insertWorkspace(pos) {
        const workspaceManager = global.workspace_manager;

        if (!Meta.prefs_get_dynamic_workspaces())
            return;

        const newWs = workspaceManager.append_new_workspace(false, global.get_current_time());
        workspaceManager.reorder_workspace(newWs, pos);
    }

    skipNextEffect(actor) {
        this._skippedActors.add(actor);
    }

    setCustomKeybindingHandler(name, modes, handler) {
        if (Meta.keybindings_set_custom_handler(name, handler))
            this.allowKeybinding(name, modes);
    }

    addKeybinding(name, settings, flags, modes, handler) {
        let action = global.display.add_keybinding(name, settings, flags, handler);
        if (action != Meta.KeyBindingAction.NONE)
            this.allowKeybinding(name, modes);
        return action;
    }

    removeKeybinding(name) {
        if (global.display.remove_keybinding(name))
            this.allowKeybinding(name, Shell.ActionMode.NONE);
    }

    allowKeybinding(name, modes) {
        this._allowedKeybindings[name] = modes;
    }

    _shouldAnimate() {
        const overviewOpen = Main.overview.visible && !Main.overview.closing;
        return !(overviewOpen || this._workspaceAnimation.gestureActive);
    }

    _shouldAnimateActor(actor, types) {
        if (this._skippedActors.delete(actor))
            return false;

        if (!this._shouldAnimate())
            return false;

        if (!actor.get_texture())
            return false;

        let type = actor.meta_window.get_window_type();
        return types.includes(type);
    }

    _minimizeWindow(shellwm, actor) {
        const types = [
            Meta.WindowType.NORMAL,
            Meta.WindowType.MODAL_DIALOG,
            Meta.WindowType.DIALOG,
        ];
        if (!this._shouldAnimateActor(actor, types)) {
            shellwm.completed_minimize(actor);
            return;
        }

        actor.set_scale(1.0, 1.0);

        this._minimizing.add(actor);

        if (actor.meta_window.is_monitor_sized()) {
            actor.ease({
                opacity: 0,
                duration: MINIMIZE_WINDOW_ANIMATION_TIME,
                mode: MINIMIZE_WINDOW_ANIMATION_MODE,
                onStopped: () => this._minimizeWindowDone(shellwm, actor),
            });
        } else {
            let xDest, yDest, xScale, yScale;
            let [success, geom] = actor.meta_window.get_icon_geometry();
            if (success) {
                xDest = geom.x;
                yDest = geom.y;
                xScale = geom.width / actor.width;
                yScale = geom.height / actor.height;
            } else {
                let monitor = Main.layoutManager.monitors[actor.meta_window.get_monitor()];
                if (!monitor) {
                    this._minimizeWindowDone();
                    return;
                }
                xDest = monitor.x;
                yDest = monitor.y;
                if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
                    xDest += monitor.width;
                xScale = 0;
                yScale = 0;
            }

            actor.ease({
                scale_x: xScale,
                scale_y: yScale,
                x: xDest,
                y: yDest,
                duration: MINIMIZE_WINDOW_ANIMATION_TIME,
                mode: MINIMIZE_WINDOW_ANIMATION_MODE,
                onStopped: () => this._minimizeWindowDone(shellwm, actor),
            });
        }
    }

    _minimizeWindowDone(shellwm, actor) {
        if (this._minimizing.delete(actor)) {
            actor.remove_all_transitions();
            actor.set_scale(1.0, 1.0);
            actor.set_opacity(255);
            actor.set_pivot_point(0, 0);

            shellwm.completed_minimize(actor);
        }
    }

    _unminimizeWindow(shellwm, actor) {
        const types = [
            Meta.WindowType.NORMAL,
            Meta.WindowType.MODAL_DIALOG,
            Meta.WindowType.DIALOG,
        ];
        if (!this._shouldAnimateActor(actor, types)) {
            shellwm.completed_unminimize(actor);
            return;
        }

        this._unminimizing.add(actor);

        if (actor.meta_window.is_monitor_sized()) {
            actor.opacity = 0;
            actor.set_scale(1.0, 1.0);
            actor.ease({
                opacity: 255,
                duration: MINIMIZE_WINDOW_ANIMATION_TIME,
                mode: MINIMIZE_WINDOW_ANIMATION_MODE,
                onStopped: () => this._unminimizeWindowDone(shellwm, actor),
            });
        } else {
            let [success, geom] = actor.meta_window.get_icon_geometry();
            if (success) {
                actor.set_position(geom.x, geom.y);
                actor.set_scale(geom.width / actor.width,
                                geom.height / actor.height);
            } else {
                let monitor = Main.layoutManager.monitors[actor.meta_window.get_monitor()];
                if (!monitor) {
                    actor.show();
                    this._unminimizeWindowDone();
                    return;
                }
                actor.set_position(monitor.x, monitor.y);
                if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
                    actor.x += monitor.width;
                actor.set_scale(0, 0);
            }

            let rect = actor.meta_window.get_buffer_rect();
            let [xDest, yDest] = [rect.x, rect.y];

            actor.show();
            actor.ease({
                scale_x: 1,
                scale_y: 1,
                x: xDest,
                y: yDest,
                duration: MINIMIZE_WINDOW_ANIMATION_TIME,
                mode: MINIMIZE_WINDOW_ANIMATION_MODE,
                onStopped: () => this._unminimizeWindowDone(shellwm, actor),
            });
        }
    }

    _unminimizeWindowDone(shellwm, actor) {
        if (this._unminimizing.delete(actor)) {
            actor.remove_all_transitions();
            actor.set_scale(1.0, 1.0);
            actor.set_opacity(255);
            actor.set_pivot_point(0, 0);

            shellwm.completed_unminimize(actor);
        }
    }

    _sizeChangeWindow(shellwm, actor, whichChange, oldFrameRect, _oldBufferRect) {
        const types = [Meta.WindowType.NORMAL];
        const shouldAnimate =
            !this.workspaceTracker.singleWindowWorkspaces &&
            this._shouldAnimateActor(actor, types) &&
            oldFrameRect.width > 0 &&
            oldFrameRect.height > 0;

        if (shouldAnimate)
            this._prepareAnimationInfo(shellwm, actor, oldFrameRect, whichChange);
        else
            shellwm.completed_size_change(actor);
    }

    _prepareAnimationInfo(shellwm, actor, oldFrameRect, _change) {
        // Position a clone of the window on top of the old position,
        // while actor updates are frozen.
        let actorContent = actor.paint_to_content(oldFrameRect);
        let actorClone = new St.Widget({ content: actorContent });
        actorClone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        actorClone.set_position(oldFrameRect.x, oldFrameRect.y);
        actorClone.set_size(oldFrameRect.width, oldFrameRect.height);

        actor.freeze();

        if (this._clearAnimationInfo(actor)) {
            log(`Old animationInfo removed from actor ${actor}`);
            this._shellwm.completed_size_change(actor);
        }

        actor.connectObject('destroy',
            () => this._clearAnimationInfo(actor), actorClone);

        this._resizePending.add(actor);
        actor.__animationInfo = {
            clone: actorClone,
            oldRect: oldFrameRect,
            frozen: true,
        };
    }

    _sizeChangedWindow(shellwm, actor) {
        if (!actor.__animationInfo)
            return;
        if (this._resizing.has(actor))
            return;

        let actorClone = actor.__animationInfo.clone;
        let targetRect = actor.meta_window.get_frame_rect();
        let sourceRect = actor.__animationInfo.oldRect;

        let scaleX = targetRect.width / sourceRect.width;
        let scaleY = targetRect.height / sourceRect.height;

        this._resizePending.delete(actor);
        this._resizing.add(actor);

        Main.uiGroup.add_child(actorClone);

        // Now scale and fade out the clone
        actorClone.ease({
            x: targetRect.x,
            y: targetRect.y,
            scale_x: scaleX,
            scale_y: scaleY,
            opacity: 0,
            duration: WINDOW_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        actor.translation_x = -targetRect.x + sourceRect.x;
        actor.translation_y = -targetRect.y + sourceRect.y;

        // Now set scale the actor to size it as the clone.
        actor.scale_x = 1 / scaleX;
        actor.scale_y = 1 / scaleY;

        // Scale it to its actual new size
        actor.ease({
            scale_x: 1,
            scale_y: 1,
            translation_x: 0,
            translation_y: 0,
            duration: WINDOW_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._sizeChangeWindowDone(shellwm, actor),
        });

        // ease didn't animate and cleared the info, we are done
        if (!actor.__animationInfo)
            return;

        // Now unfreeze actor updates, to get it to the new size.
        // It's important that we don't wait until the animation is completed to
        // do this, otherwise our scale will be applied to the old texture size.
        actor.thaw();
        actor.__animationInfo.frozen = false;
    }

    _clearAnimationInfo(actor) {
        if (actor.__animationInfo) {
            actor.__animationInfo.clone.destroy();
            if (actor.__animationInfo.frozen)
                actor.thaw();

            delete actor.__animationInfo;
            return true;
        }
        return false;
    }

    _sizeChangeWindowDone(shellwm, actor) {
        if (this._resizing.delete(actor)) {
            actor.remove_all_transitions();
            actor.scale_x = 1.0;
            actor.scale_y = 1.0;
            actor.translation_x = 0;
            actor.translation_y = 0;
            this._clearAnimationInfo(actor);
            this._shellwm.completed_size_change(actor);
        }

        if (this._resizePending.delete(actor)) {
            this._clearAnimationInfo(actor);
            this._shellwm.completed_size_change(actor);
        }
    }

    _checkDimming(window) {
        const shouldDim = window.has_attached_dialogs();

        if (shouldDim && !window._dimmed) {
            window._dimmed = true;
            this._dimmedWindows.push(window);
            this._dimWindow(window);
        } else if (!shouldDim && window._dimmed) {
            window._dimmed = false;
            this._dimmedWindows =
                this._dimmedWindows.filter(win => win != window);
            this._undimWindow(window);
        }
    }

    _dimWindow(window) {
        let actor = window.get_compositor_private();
        if (!actor)
            return;
        let dimmer = getWindowDimmer(actor);
        if (!dimmer)
            return;
        dimmer.setDimmed(true, this._shouldAnimate());
    }

    _undimWindow(window) {
        let actor = window.get_compositor_private();
        if (!actor)
            return;
        let dimmer = getWindowDimmer(actor);
        if (!dimmer)
            return;
        dimmer.setDimmed(false, this._shouldAnimate());
    }

    _waitForOverviewToHide() {
        if (!Main.overview.visible)
            return Promise.resolve();

        return new Promise(resolve => {
            const id = Main.overview.connect('hidden', () => {
                Main.overview.disconnect(id);
                resolve();
            });
        });
    }

    async _mapWindow(shellwm, actor) {
        actor._windowType = actor.meta_window.get_window_type();
        actor.meta_window.connectObject('notify::window-type', () => {
            let type = actor.meta_window.get_window_type();
            if (type === actor._windowType)
                return;
            if (type === Meta.WindowType.MODAL_DIALOG ||
                actor._windowType === Meta.WindowType.MODAL_DIALOG) {
                let parent = actor.get_meta_window().get_transient_for();
                if (parent)
                    this._checkDimming(parent);
            }

            actor._windowType = type;
        }, actor);
        actor.meta_window.connect('unmanaged', window => {
            let parent = window.get_transient_for();
            if (parent)
                this._checkDimming(parent);
        });

        if (actor.meta_window.is_attached_dialog())
            this._checkDimming(actor.get_meta_window().get_transient_for());



        const types = [
            Meta.WindowType.NORMAL,
            Meta.WindowType.DIALOG,
            Meta.WindowType.MODAL_DIALOG,
        ];
        if (!this._shouldAnimateActor(actor, types)) {
            shellwm.completed_map(actor);
            return;
        }




        switch (actor._windowType) {
        case Meta.WindowType.NORMAL:
            if (this.workspaceTracker.singleWindowWorkspaces) {
log("WS: NORMAL Window wants to animate");
                shellwm.completed_map(actor);

                return;
    }

            actor.set_pivot_point(0.5, 1.0);
            actor.scale_x = 0.01;
            actor.scale_y = 0.05;
            actor.opacity = 0;
            actor.show();
            this._mapping.add(actor);

            await this._waitForOverviewToHide();
            actor.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: SHOW_WINDOW_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO,
                onStopped: () => this._mapWindowDone(shellwm, actor),
            });
            break;
        case Meta.WindowType.MODAL_DIALOG:
        case Meta.WindowType.DIALOG:
            actor.set_pivot_point(0.5, 0.5);
            actor.scale_y = 0;
            actor.opacity = 0;
            actor.show();
            this._mapping.add(actor);

            await this._waitForOverviewToHide();
            actor.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: DIALOG_SHOW_WINDOW_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._mapWindowDone(shellwm, actor),
            });
            break;
        default:
            shellwm.completed_map(actor);
        }
    }

    _mapWindowDone(shellwm, actor) {
        if (this._mapping.delete(actor)) {
            actor.remove_all_transitions();
            actor.opacity = 255;
            actor.set_pivot_point(0, 0);
            actor.scale_y = 1;
            actor.scale_x = 1;
            actor.translation_y = 0;
            actor.translation_x = 0;
            shellwm.completed_map(actor);
        }
    }

    _destroyWindow(shellwm, actor) {
        let window = actor.meta_window;
        window.disconnectObject(actor);
        if (window._dimmed) {
            this._dimmedWindows =
                this._dimmedWindows.filter(win => win != window);
        }

        if (window.is_attached_dialog())
            this._checkDimming(window.get_transient_for());

        const types = [
            Meta.WindowType.NORMAL,
            Meta.WindowType.DIALOG,
            Meta.WindowType.MODAL_DIALOG,
        ];
            if (this.workspaceTracker.singleWindowWorkspaces) {
window._rect = window.get_frame_rect();
window._content = actor.paint_to_content(window._rect);

                shellwm.completed_destroy(actor);
               return;
            }

        if (!this._shouldAnimateActor(actor, types)) {
            shellwm.completed_destroy(actor);
            return;
        }

        switch (actor.meta_window.window_type) {
        case Meta.WindowType.NORMAL:


            actor.set_pivot_point(0.5, 0.5);
            this._destroying.add(actor);

            actor.ease({
                opacity: 0,
                scale_x: 0.8,
                scale_y: 0.8,
                duration: DESTROY_WINDOW_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._destroyWindowDone(shellwm, actor),
            });
            break;
        case Meta.WindowType.MODAL_DIALOG:
        case Meta.WindowType.DIALOG:
            actor.set_pivot_point(0.5, 0.5);
            this._destroying.add(actor);

            if (window.is_attached_dialog()) {
                let parent = window.get_transient_for();
                parent.connectObject('unmanaged', () => {
                    actor.remove_all_transitions();
                    this._destroyWindowDone(shellwm, actor);
                }, actor);
            }

            actor.ease({
                scale_y: 0,
                duration: DIALOG_DESTROY_WINDOW_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._destroyWindowDone(shellwm, actor),
            });
            break;
        default:
            shellwm.completed_destroy(actor);
        }
    }

    _destroyWindowDone(shellwm, actor) {
        if (this._destroying.delete(actor)) {
            const parent = actor.get_meta_window()?.get_transient_for();
            parent?.disconnectObject(actor);
            shellwm.completed_destroy(actor);
        }
    }

    _filterKeybinding(shellwm, binding) {
        if (Main.actionMode == Shell.ActionMode.NONE)
            return true;

        // There's little sense in implementing a keybinding in mutter and
        // not having it work in NORMAL mode; handle this case generically
        // so we don't have to explicitly allow all builtin keybindings in
        // NORMAL mode.
        if (Main.actionMode == Shell.ActionMode.NORMAL &&
            binding.is_builtin())
            return false;

        return !(this._allowedKeybindings[binding.get_name()] & Main.actionMode);
    }

    _switchWorkspace(shellwm, from, to, direction) {
        if (!Main.sessionMode.hasWorkspaces || !this._shouldAnimate()) {
            shellwm.completed_switch_workspace();
            return;
        }

        this._switchInProgress = true;

        this._workspaceAnimation.animateSwitch(from, to, direction, () => {
            this._shellwm.completed_switch_workspace();
            this._switchInProgress = false;
        });
    }

    _switchWorkspaceDone() {
        if (!this._switchInProgress)
            return;

        this._shellwm.completed_switch_workspace();
        this._switchInProgress = false;
    }

    _showTilePreview(shellwm, window, tileRect, monitorIndex) {
        if (!this._tilePreview)
            this._tilePreview = new TilePreview();
        this._tilePreview.open(window, tileRect, monitorIndex);
    }

    _hideTilePreview() {
        if (!this._tilePreview)
            return;
        this._tilePreview.close();
    }

    _showWindowMenu(shellwm, window, menu, rect) {
        this._windowMenuManager.showWindowMenuForWindow(window, menu, rect);
    }

    _startSwitcher(display, window, binding) {
        let constructor = null;
        switch (binding.get_name()) {
        case 'switch-applications':
        case 'switch-applications-backward':
        case 'switch-group':
        case 'switch-group-backward':
            constructor = AltTab.AppSwitcherPopup;
            break;
        case 'switch-windows':
        case 'switch-windows-backward':
            constructor = AltTab.WindowSwitcherPopup;
            break;
        case 'cycle-windows':
        case 'cycle-windows-backward':
            constructor = AltTab.WindowCyclerPopup;
            break;
        case 'cycle-group':
        case 'cycle-group-backward':
            constructor = AltTab.GroupCyclerPopup;
            break;
        case 'switch-monitor':
            constructor = SwitchMonitor.SwitchMonitorPopup;
            break;
        }

        if (!constructor)
            return;

        /* prevent a corner case where both popups show up at once */
        if (this._workspaceSwitcherPopup != null)
            this._workspaceSwitcherPopup.destroy();

        let tabPopup = new constructor();

        if (!tabPopup.show(binding.is_reversed(), binding.get_name(), binding.get_mask()))
            tabPopup.destroy();
    }

    _startA11ySwitcher(display, window, binding) {
        Main.ctrlAltTabManager.popup(binding.is_reversed(), binding.get_name(), binding.get_mask());
    }

    _allowFavoriteShortcuts() {
        return Main.sessionMode.hasOverview;
    }

    _switchToApplication(display, window, binding) {
        if (!this._allowFavoriteShortcuts())
            return;

        let [, , , target] = binding.get_name().split('-');
        let apps = AppFavorites.getAppFavorites().getFavorites();
        let app = apps[target - 1];
        if (app) {
            Main.overview.hide();
            app.activate();
        }
    }

    _toggleAppMenu() {
        Main.panel.toggleAppMenu();
    }

    _toggleCalendar() {
        Main.panel.toggleCalendar();
    }

    _showWorkspaceSwitcher(display, window, binding) {
        let workspaceManager = display.get_workspace_manager();

        if (!Main.sessionMode.hasWorkspaces)
            return;

        if (workspaceManager.n_workspaces == 1)
            return;

        let [action,,, target] = binding.get_name().split('-');
        let newWs;
        let direction;
        let vertical = workspaceManager.layout_rows == -1;
        let rtl = Clutter.get_default_text_direction() == Clutter.TextDirection.RTL;

        if (action == 'move') {
            // "Moving" a window to another workspace doesn't make sense when
            // it cannot be unstuck, and is potentially confusing if a new
            // workspaces is added at the start/end
            if (window.is_always_on_all_workspaces() ||
                (Meta.prefs_get_workspaces_only_on_primary() &&
                 window.get_monitor() != Main.layoutManager.primaryIndex))
                return;
        }

        if (target == 'last') {
            if (vertical)
                direction = Meta.MotionDirection.DOWN;
            else if (rtl)
                direction = Meta.MotionDirection.LEFT;
            else
                direction = Meta.MotionDirection.RIGHT;
            newWs = workspaceManager.get_workspace_by_index(workspaceManager.n_workspaces - 1);
        } else if (isNaN(target)) {
            // Prepend a new workspace dynamically
            let prependTarget;
            if (vertical)
                prependTarget = 'up';
            else if (rtl)
                prependTarget = 'right';
            else
                prependTarget = 'left';
            if (workspaceManager.get_active_workspace_index() === 0 &&
                action === 'move' && target === prependTarget &&
                this._isWorkspacePrepended === false) {
                this.insertWorkspace(0);
                this._isWorkspacePrepended = true;
            }

            direction = Meta.MotionDirection[target.toUpperCase()];
            newWs = workspaceManager.get_active_workspace().get_neighbor(direction);
        } else if ((target > 0) && (target <= workspaceManager.n_workspaces)) {
            target--;
            newWs = workspaceManager.get_workspace_by_index(target);

            if (workspaceManager.get_active_workspace().index() > target) {
                if (vertical)
                    direction = Meta.MotionDirection.UP;
                else if (rtl)
                    direction = Meta.MotionDirection.RIGHT;
                else
                    direction = Meta.MotionDirection.LEFT;
            } else {
                if (vertical) // eslint-disable-line no-lonely-if
                    direction = Meta.MotionDirection.DOWN;
                else if (rtl)
                    direction = Meta.MotionDirection.LEFT;
                else
                    direction = Meta.MotionDirection.RIGHT;
            }
        }

        if (workspaceManager.layout_rows == -1 &&
            direction != Meta.MotionDirection.UP &&
            direction != Meta.MotionDirection.DOWN)
            return;

        if (workspaceManager.layout_columns == -1 &&
            direction != Meta.MotionDirection.LEFT &&
            direction != Meta.MotionDirection.RIGHT)
            return;

        if (action == 'switch')
            this.actionMoveWorkspace(newWs);
        else
            this.actionMoveWindow(window, newWs);

        if (!Main.overview.visible) {
            if (this._workspaceSwitcherPopup == null) {
                this.workspaceTracker.blockUpdates();
                this._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
                this._workspaceSwitcherPopup.connect('destroy', () => {
                    this.workspaceTracker.unblockUpdates();
                    this._workspaceSwitcherPopup = null;
                    this._isWorkspacePrepended = false;
                });
            }
            this._workspaceSwitcherPopup.display(newWs.index());
        }
    }

    actionMoveWorkspace(workspace) {
        if (!Main.sessionMode.hasWorkspaces)
            return;

        if (!workspace.active)
            workspace.activate(global.get_current_time());
    }

    actionMoveWindow(window, workspace) {
        if (!Main.sessionMode.hasWorkspaces)
            return;

        if (!workspace.active) {
            // This won't have any effect for "always sticky" windows
            // (like desktop windows or docks)

            this._workspaceAnimation.movingWindow = window;
            window.change_workspace(workspace);

            global.display.clear_mouse_mode();
            workspace.activate_with_focus(window, global.get_current_time());
        }
    }

    handleWorkspaceScroll(event) {
        if (!this._canScroll)
            return Clutter.EVENT_PROPAGATE;

        if (event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;

        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;

        const workspaceManager = global.workspace_manager;
        const vertical = workspaceManager.layout_rows === -1;
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const activeWs = workspaceManager.get_active_workspace();
        let ws;
        switch (direction) {
        case Clutter.ScrollDirection.UP:
            if (vertical)
                ws = activeWs.get_neighbor(Meta.MotionDirection.UP);
            else if (rtl)
                ws = activeWs.get_neighbor(Meta.MotionDirection.RIGHT);
            else
                ws = activeWs.get_neighbor(Meta.MotionDirection.LEFT);
            break;
        case Clutter.ScrollDirection.DOWN:
            if (vertical)
                ws = activeWs.get_neighbor(Meta.MotionDirection.DOWN);
            else if (rtl)
                ws = activeWs.get_neighbor(Meta.MotionDirection.LEFT);
            else
                ws = activeWs.get_neighbor(Meta.MotionDirection.RIGHT);
            break;
        case Clutter.ScrollDirection.LEFT:
            ws = activeWs.get_neighbor(Meta.MotionDirection.LEFT);
            break;
        case Clutter.ScrollDirection.RIGHT:
            ws = activeWs.get_neighbor(Meta.MotionDirection.RIGHT);
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        this.actionMoveWorkspace(ws);

        this._canScroll = false;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            SCROLL_TIMEOUT_TIME, () => {
                this._canScroll = true;
                return GLib.SOURCE_REMOVE;
            });

        return Clutter.EVENT_STOP;
    }

    _confirmDisplayChange() {
        let dialog = new DisplayChangeDialog(this._shellwm);
        dialog.open();
    }

    _createCloseDialog(shellwm, window) {
        return new CloseDialog.CloseDialog(window);
    }

    _createInhibitShortcutsDialog(shellwm, window) {
        return new InhibitShortcutsDialog.InhibitShortcutsDialog(window);
    }

    _showResizePopup(display, show, rect, displayW, displayH) {
        if (show) {
            if (!this._resizePopup)
                this._resizePopup = new ResizePopup();

            this._resizePopup.set(rect, displayW, displayH);
        } else {
            if (!this._resizePopup)
                return;

            this._resizePopup.destroy();
            this._resizePopup = null;
        }
    }
};
