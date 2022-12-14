// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported WorkspacesView, WorkspacesDisplay */

const { Clutter, Gio, GObject, Meta, Shell, St } = imports.gi;

const Main = imports.ui.main;
const WindowManager = imports.ui.windowManager;
const Workspace = imports.ui.workspace;

var WORKSPACE_SWITCH_TIME = 250;

var AnimationType = {
    ZOOM: 0,
    FADE: 1
};

const MUTTER_SCHEMA = 'org.gnome.mutter';

var WorkspacesViewBase = GObject.registerClass({
    GTypeFlags: GObject.TypeFlags.ABSTRACT
}, class WorkspacesViewBase extends St.Widget {
    _init(monitorIndex) {
        super._init({ style_class: 'workspaces-view', reactive: true });
        this.connect('destroy', this._onDestroy.bind(this));
        global.focus_manager.add_group(this);

        // The actor itself isn't a drop target, so we don't want to pick on its area
        this.set_size(0, 0);

        this._monitorIndex = monitorIndex;

        this._fullGeometry = null;
        this._actualGeometry = null;

        this._inDrag = false;
        this._windowDragBeginId = Main.overview.connect('window-drag-begin', this._dragBegin.bind(this));
        this._windowDragEndId = Main.overview.connect('window-drag-end', this._dragEnd.bind(this));
    }

    _onDestroy() {
        this._dragEnd();

        if (this._windowDragBeginId > 0) {
            Main.overview.disconnect(this._windowDragBeginId);
            this._windowDragBeginId = 0;
        }
        if (this._windowDragEndId > 0) {
            Main.overview.disconnect(this._windowDragEndId);
            this._windowDragEndId = 0;
        }
    }

    _dragBegin(overview, window) {
        this._inDrag = true;
        this._setReservedSlot(window);
    }

    _dragEnd() {
        this._inDrag = false;
        this._setReservedSlot(null);
    }

    setFullGeometry(geom) {
        this._fullGeometry = geom;
        this._syncFullGeometry();
    }

    setActualGeometry(geom) {
        this._actualGeometry = geom;
        this._syncActualGeometry();
    }
});

var WorkspacesView = GObject.registerClass(
class WorkspacesView extends WorkspacesViewBase {
    _init(monitorIndex) {
        let workspaceManager = global.workspace_manager;

        super._init(monitorIndex);

        this._animating = false; // tweening
        this._scrolling = false; // swipe-scrolling
        this._gestureActive = false; // touch(pad) gestures
        this._animatingScroll = false; // programmatically updating the adjustment

        let activeWorkspaceIndex = workspaceManager.get_active_workspace_index();
        this.scrollAdjustment = new St.Adjustment({ value: activeWorkspaceIndex,
                                                    lower: 0,
                                                    page_increment: 1,
                                                    page_size: 1,
                                                    step_increment: 0,
                                                    upper: workspaceManager.n_workspaces });
        this.scrollAdjustment.connect('notify::value',
                                      this._onScroll.bind(this));

        this._workspaces = [];
        this._updateWorkspaces();
        this._updateWorkspacesId =
            workspaceManager.connect('notify::n-workspaces',
                                     this._updateWorkspaces.bind(this));
        this._reorderWorkspacesId =
            workspaceManager.connect('workspaces-reordered', () => {
                this._workspaces.sort((a, b) => {
                    return a.metaWorkspace.index() - b.metaWorkspace.index();
                });
                this._updateWorkspaceActors(false);
            });


        this._overviewShownId =
            Main.overview.connect('shown', () => {
                this.set_clip(this._fullGeometry.x, this._fullGeometry.y,
                              this._fullGeometry.width, this._fullGeometry.height);
            });

        this._switchWorkspaceNotifyId =
            global.window_manager.connect('switch-workspace',
                                          this._activeWorkspaceChanged.bind(this));
    }

    _setReservedSlot(window) {
        for (let i = 0; i < this._workspaces.length; i++)
            this._workspaces[i].setReservedSlot(window);
    }

    _syncFullGeometry() {
        for (let i = 0; i < this._workspaces.length; i++)
            this._workspaces[i].setFullGeometry(this._fullGeometry);
    }

    _syncActualGeometry() {
        for (let i = 0; i < this._workspaces.length; i++)
            this._workspaces[i].setActualGeometry(this._actualGeometry);
    }

    getActiveWorkspace() {
        let workspaceManager = global.workspace_manager;
        let active = workspaceManager.get_active_workspace_index();
        return this._workspaces[active];
    }

    animateToOverview(animationType) {
        for (let w = 0; w < this._workspaces.length; w++) {
            if (animationType == AnimationType.ZOOM)
                this._workspaces[w].zoomToOverview();
            else
                this._workspaces[w].fadeToOverview();
        }
        this._updateWorkspaceActors(false);
    }

    animateFromOverview(animationType) {
        this.remove_clip();

        for (let w = 0; w < this._workspaces.length; w++) {
            if (animationType == AnimationType.ZOOM)
                this._workspaces[w].zoomFromOverview();
            else
                this._workspaces[w].fadeFromOverview();
        }
    }

    syncStacking(stackIndices) {
        for (let i = 0; i < this._workspaces.length; i++)
            this._workspaces[i].syncStacking(stackIndices);
    }

    _scrollToActive() {
        let workspaceManager = global.workspace_manager;
        let active = workspaceManager.get_active_workspace_index();

        this._updateWorkspaceActors(true);
        this._updateScrollAdjustment(active);
    }

    // Update workspace actors parameters
    // @showAnimation: iff %true, transition between states
    _updateWorkspaceActors(showAnimation) {
        let workspaceManager = global.workspace_manager;
        let active = workspaceManager.get_active_workspace_index();

        this._animating = showAnimation;

        for (let w = 0; w < this._workspaces.length; w++) {
            let workspace = this._workspaces[w];

            workspace.remove_all_transitions();

            let params = {};
            if (workspaceManager.layout_rows == -1)
                params.y = (w - active) * this._fullGeometry.height;
            else if (this.text_direction == Clutter.TextDirection.RTL)
                params.x = (active - w) * this._fullGeometry.width;
            else
                params.x = (w - active) * this._fullGeometry.width;

            if (showAnimation) {
                let easeParams = Object.assign(params, {
                    duration: WORKSPACE_SWITCH_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
                // we have to call _updateVisibility() once before the
                // animation and once afterwards - it does not really
                // matter which tween we use, so we pick the first one ...
                if (w == 0) {
                    this._updateVisibility();
                    easeParams.onComplete = () => {
                        this._animating = false;
                        this._updateVisibility();
                    };
                }
                workspace.ease(easeParams);
            } else {
                workspace.set(params);
                if (w == 0)
                    this._updateVisibility();
            }
        }
    }

    _updateVisibility() {
        let workspaceManager = global.workspace_manager;
        let active = workspaceManager.get_active_workspace_index();

        for (let w = 0; w < this._workspaces.length; w++) {
            let workspace = this._workspaces[w];
            if (this._animating || this._scrolling || this._gestureActive) {
                workspace.show();
            } else {
                if (this._inDrag)
                    workspace.visible = (Math.abs(w - active) <= 1);
                else
                    workspace.visible = (w == active);
            }
        }
    }

    _updateScrollAdjustment(index) {
        if (this._scrolling || this._gestureActive)
            return;

        this._animatingScroll = true;

        this.scrollAdjustment.ease(index, {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: WORKSPACE_SWITCH_TIME,
            onComplete: () => (this._animatingScroll = false)
        });
    }

    _updateWorkspaces() {
        let workspaceManager = global.workspace_manager;
        let newNumWorkspaces = workspaceManager.n_workspaces;

        this.scrollAdjustment.upper = newNumWorkspaces;

        for (let j = 0; j < newNumWorkspaces; j++) {
            let metaWorkspace = workspaceManager.get_workspace_by_index(j);
            let workspace;

            if (j >= this._workspaces.length) { /* added */
                workspace = new Workspace.Workspace(metaWorkspace, this._monitorIndex);
                this.add_actor(workspace);
                this._workspaces[j] = workspace;
            } else  {
                workspace = this._workspaces[j];

                if (workspace.metaWorkspace != metaWorkspace) { /* removed */
                    workspace.destroy();
                    this._workspaces.splice(j, 1);
                } /* else kept */
            }
        }

        if (this._fullGeometry) {
            this._updateWorkspaceActors(false);
            this._syncFullGeometry();
        }
        if (this._actualGeometry)
            this._syncActualGeometry();
    }

    _activeWorkspaceChanged(_wm, _from, _to, _direction) {
        if (this._scrolling)
            return;

        this._scrollToActive();
    }

    _onDestroy() {
        super._onDestroy();

        this.scrollAdjustment.run_dispose();
        Main.overview.disconnect(this._overviewShownId);
        global.window_manager.disconnect(this._switchWorkspaceNotifyId);
        let workspaceManager = global.workspace_manager;
        workspaceManager.disconnect(this._updateWorkspacesId);
        workspaceManager.disconnect(this._reorderWorkspacesId);
    }

    startSwipeScroll() {
        this._scrolling = true;
    }

    endSwipeScroll() {
        this._scrolling = false;

        // Make sure title captions etc are shown as necessary
        this._scrollToActive();
        this._updateVisibility();
    }

    startTouchGesture() {
        this._gestureActive = true;
    }

    endTouchGesture() {
        this._gestureActive = false;

        // Make sure title captions etc are shown as necessary
        this._scrollToActive();
        this._updateVisibility();
    }

    // sync the workspaces' positions to the value of the scroll adjustment
    // and change the active workspace if appropriate
    _onScroll(adj) {
        if (this._animatingScroll)
            return;

        let workspaceManager = global.workspace_manager;
        let active = workspaceManager.get_active_workspace_index();
        let current = Math.round(adj.value);

        if (active != current && !this._gestureActive) {
            if (!this._workspaces[current]) {
                // The current workspace was destroyed. This could happen
                // when you are on the last empty workspace, and consolidate
                // windows using the thumbnail bar.
                // In that case, the intended behavior is to stay on the empty
                // workspace, which is the last one, so pick it.
                current = this._workspaces.length - 1;
            }

            let metaWorkspace = this._workspaces[current].metaWorkspace;
            metaWorkspace.activate(global.get_current_time());
        }

        if (adj.upper == 1)
            return;

        let last = this._workspaces.length - 1;

        if (workspaceManager.layout_rows == -1) {
            let firstWorkspaceY = this._workspaces[0].y;
            let lastWorkspaceY = this._workspaces[last].y;
            let workspacesHeight = lastWorkspaceY - firstWorkspaceY;

            let currentY = firstWorkspaceY;
            let newY = -adj.value / (adj.upper - 1) * workspacesHeight;

            let dy = newY - currentY;

            for (let i = 0; i < this._workspaces.length; i++) {
                this._workspaces[i].visible = Math.abs(i - adj.value) <= 1;
                this._workspaces[i].y += dy;
            }
        } else {
            let firstWorkspaceX = this._workspaces[0].x;
            let lastWorkspaceX = this._workspaces[last].x;
            let workspacesWidth = lastWorkspaceX - firstWorkspaceX;

            let currentX = firstWorkspaceX;
            let newX = -adj.value / (adj.upper - 1) * workspacesWidth;

            let dx = newX - currentX;

            for (let i = 0; i < this._workspaces.length; i++) {
                this._workspaces[i].visible = Math.abs(i - adj.value) <= 1;
                this._workspaces[i].x += dx;
            }
        }
    }
});

var ExtraWorkspaceView = GObject.registerClass(
class ExtraWorkspaceView extends WorkspacesViewBase {
    _init(monitorIndex) {
        super._init(monitorIndex);
        this._workspace = new Workspace.Workspace(null, monitorIndex);
        this.add_actor(this._workspace);
    }

    _setReservedSlot(window) {
        this._workspace.setReservedSlot(window);
    }

    _syncFullGeometry() {
        this._workspace.setFullGeometry(this._fullGeometry);
    }

    _syncActualGeometry() {
        this._workspace.setActualGeometry(this._actualGeometry);
    }

    getActiveWorkspace() {
        return this._workspace;
    }

    animateToOverview(animationType) {
        if (animationType == AnimationType.ZOOM)
            this._workspace.zoomToOverview();
        else
            this._workspace.fadeToOverview();
    }

    animateFromOverview(animationType) {
        if (animationType == AnimationType.ZOOM)
            this._workspace.zoomFromOverview();
        else
            this._workspace.fadeFromOverview();
    }

    syncStacking(stackIndices) {
        this._workspace.syncStacking(stackIndices);
    }

    startSwipeScroll() {
    }

    endSwipeScroll() {
    }

    startTouchGesture() {
    }

    endTouchGesture() {
    }
});

var WorkspacesDisplay = GObject.registerClass(
class WorkspacesDisplay extends St.Widget {
    _init() {
        super._init({ clip_to_allocation: true });
        this.connect('notify::allocation', this._updateWorkspacesActualGeometry.bind(this));

        let clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', action => {
            // Only switch to the workspace when there's no application
            // windows open. The problem is that it's too easy to miss
            // an app window and get the wrong one focused.
            let event = Clutter.get_current_event();
            let index = this._getMonitorIndexForEvent(event);
            if ((action.get_button() == 1 || action.get_button() == 0) &&
                this._workspacesViews[index].getActiveWorkspace().isEmpty())
                Main.overview.hide();
        });
        Main.overview.addAction(clickAction);
        this.bind_property('mapped', clickAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);

        let panAction = new Clutter.PanAction({ threshold_trigger_edge: Clutter.GestureTriggerEdge.AFTER });
        panAction.connect('pan', this._onPan.bind(this));
        panAction.connect('gesture-begin', () => {
            if (this._workspacesOnlyOnPrimary) {
                let event = Clutter.get_current_event();
                if (this._getMonitorIndexForEvent(event) != this._primaryIndex)
                    return false;
            }

            this._startSwipeScroll();
            return true;
        });
        panAction.connect('gesture-cancel', () => {
            clickAction.release();
            this._endSwipeScroll();
        });
        panAction.connect('gesture-end', () => {
            clickAction.release();
            this._endSwipeScroll();
        });
        Main.overview.addAction(panAction);
        this.bind_property('mapped', panAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);

        let allowedModes = Shell.ActionMode.OVERVIEW;
        let switchGesture = new WindowManager.WorkspaceSwitchAction(allowedModes);
        switchGesture.connect('motion', this._onSwitchWorkspaceMotion.bind(this));
        switchGesture.connect('activated', this._onSwitchWorkspaceActivated.bind(this));
        switchGesture.connect('cancel', this._endTouchGesture.bind(this));
        Main.overview.addAction(switchGesture);
        this.bind_property('mapped', switchGesture, 'enabled', GObject.BindingFlags.SYNC_CREATE);

        switchGesture = new WindowManager.TouchpadWorkspaceSwitchAction(global.stage, allowedModes);
        switchGesture.connect('motion', this._onSwitchWorkspaceMotion.bind(this));
        switchGesture.connect('activated', this._onSwitchWorkspaceActivated.bind(this));
        switchGesture.connect('cancel', this._endTouchGesture.bind(this));

        this._primaryIndex = Main.layoutManager.primaryIndex;
        this._workspacesViews = [];

        this._settings = new Gio.Settings({ schema_id: MUTTER_SCHEMA });
        this._settings.connect('changed::workspaces-only-on-primary',
                               this._workspacesOnlyOnPrimaryChanged.bind(this));
        this._workspacesOnlyOnPrimaryChanged();

        this._notifyOpacityId = 0;
        this._restackedNotifyId = 0;
        this._scrollEventId = 0;
        this._keyPressEventId = 0;

        this._fullGeometry = null;

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._notifyOpacityId) {
            let parent = this.get_parent();
            if (parent)
                parent.disconnect(this._notifyOpacityId);
            this._notifyOpacityId = 0;
        }

        if (this._parentSetLater) {
            Meta.later_remove(this._parentSetLater);
            this._parentSetLater = 0;
        }
    }

    _onPan(action) {
        let [dist_, dx, dy] = action.get_motion_delta(0);
        let adjustment = this._scrollAdjustment;
        if (global.workspace_manager.layout_rows == -1)
            adjustment.value -= (dy / this.height) * adjustment.page_size;
        else if (this.text_direction == Clutter.TextDirection.RTL)
            adjustment.value += (dx / this.width) * adjustment.page_size;
        else
            adjustment.value -= (dx / this.width) * adjustment.page_size;
        return false;
    }

    _startSwipeScroll() {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].startSwipeScroll();
    }

    _endSwipeScroll() {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].endSwipeScroll();
    }

    _startTouchGesture() {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].startTouchGesture();
    }

    _endTouchGesture() {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].endTouchGesture();
    }

    _onSwitchWorkspaceMotion(action, xRel, yRel) {
        // We don't have a way to hook into start of touchpad actions,
        // luckily this is safe to call repeatedly.
        this._startTouchGesture();

        let workspaceManager = global.workspace_manager;
        let active = workspaceManager.get_active_workspace_index();
        let adjustment = this._scrollAdjustment;
        if (workspaceManager.layout_rows == -1)
            adjustment.value = (active - yRel / this.height) * adjustment.page_size;
        else if (this.text_direction == Clutter.TextDirection.RTL)
            adjustment.value = (active + xRel / this.width) * adjustment.page_size;
        else
            adjustment.value = (active - xRel / this.width) * adjustment.page_size;
    }

    _onSwitchWorkspaceActivated(action, direction) {
        let workspaceManager = global.workspace_manager;
        let activeWorkspace = workspaceManager.get_active_workspace();
        let newWs = activeWorkspace.get_neighbor(direction);
        if (newWs != activeWorkspace)
            newWs.activate(global.get_current_time());

        this._endTouchGesture();
    }

    vfunc_navigate_focus(from, direction) {
        return this._getPrimaryView().navigate_focus(from, direction, false);
    }

    show(fadeOnPrimary) {
        this._updateWorkspacesViews();
        for (let i = 0; i < this._workspacesViews.length; i++) {
            let animationType;
            if (fadeOnPrimary && i == this._primaryIndex)
                animationType = AnimationType.FADE;
            else
                animationType = AnimationType.ZOOM;
            this._workspacesViews[i].animateToOverview(animationType);
        }

        this._restackedNotifyId =
            Main.overview.connect('windows-restacked',
                                  this._onRestacked.bind(this));
        if (this._scrollEventId == 0)
            this._scrollEventId = Main.overview.connect('scroll-event', this._onScrollEvent.bind(this));

        if (this._keyPressEventId == 0)
            this._keyPressEventId = global.stage.connect('key-press-event', this._onKeyPressEvent.bind(this));
    }

    animateFromOverview(fadeOnPrimary) {
        for (let i = 0; i < this._workspacesViews.length; i++) {
            let animationType;
            if (fadeOnPrimary && i == this._primaryIndex)
                animationType = AnimationType.FADE;
            else
                animationType = AnimationType.ZOOM;
            this._workspacesViews[i].animateFromOverview(animationType);
        }
    }

    hide() {
        if (this._restackedNotifyId > 0) {
            Main.overview.disconnect(this._restackedNotifyId);
            this._restackedNotifyId = 0;
        }
        if (this._scrollEventId > 0) {
            Main.overview.disconnect(this._scrollEventId);
            this._scrollEventId = 0;
        }
        if (this._keyPressEventId > 0) {
            global.stage.disconnect(this._keyPressEventId);
            this._keyPressEventId = 0;
        }
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].destroy();
        this._workspacesViews = [];
    }

    _workspacesOnlyOnPrimaryChanged() {
        this._workspacesOnlyOnPrimary = this._settings.get_boolean('workspaces-only-on-primary');

        if (!Main.overview.visible)
            return;

        this._updateWorkspacesViews();
    }

    _updateWorkspacesViews() {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].destroy();

        this._primaryIndex = Main.layoutManager.primaryIndex;
        this._workspacesViews = [];
        let monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            let view;
            if (this._workspacesOnlyOnPrimary && i != this._primaryIndex)
                view = new ExtraWorkspaceView(i);
            else
                view = new WorkspacesView(i);

            view.connect('scroll-event', this._onScrollEvent.bind(this));
            if (i == this._primaryIndex) {
                this._scrollAdjustment = view.scrollAdjustment;
                this._scrollAdjustment.connect('notify::value',
                                               this._scrollValueChanged.bind(this));
            }

            // HACK: Avoid spurious allocation changes while updating views
            view.hide();

            this._workspacesViews.push(view);
            Main.layoutManager.overviewGroup.add_actor(view);
        }

        this._workspacesViews.forEach(v => v.show());

        this._updateWorkspacesFullGeometry();
        this._updateWorkspacesActualGeometry();
    }

    _scrollValueChanged() {
        for (let i = 0; i < this._workspacesViews.length; i++) {
            if (i == this._primaryIndex)
                continue;

            let adjustment = this._workspacesViews[i].scrollAdjustment;
            if (!adjustment)
                continue;

            // the adjustments work in terms of workspaces, so the
            // values map directly
            adjustment.value = this._scrollAdjustment.value;
        }
    }

    _getMonitorIndexForEvent(event) {
        let [x, y] = event.get_coords();
        let rect = new Meta.Rectangle({ x: x, y: y, width: 1, height: 1 });
        return global.display.get_monitor_index_for_rect(rect);
    }

    _getPrimaryView() {
        if (!this._workspacesViews.length)
            return null;
        return this._workspacesViews[this._primaryIndex];
    }

    activeWorkspaceHasMaximizedWindows() {
        return this._getPrimaryView().getActiveWorkspace().hasMaximizedWindows();
    }

    vfunc_parent_set(oldParent) {
        if (oldParent && this._notifyOpacityId)
            oldParent.disconnect(this._notifyOpacityId);
        this._notifyOpacityId = 0;

        if (this._parentSetLater)
            return;

        this._parentSetLater = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._parentSetLater = 0;
            let newParent = this.get_parent();
            if (!newParent)
                return;

            // This is kinda hackish - we want the primary view to
            // appear as parent of this, though in reality it
            // is added directly to Main.layoutManager.overviewGroup
            this._notifyOpacityId = newParent.connect('notify::opacity', () => {
                let opacity = this.get_parent().opacity;
                let primaryView = this._getPrimaryView();
                if (!primaryView)
                    return;
                primaryView.opacity = opacity;
                primaryView.visible = opacity != 0;
            });
        });
    }

    // This geometry should always be the fullest geometry
    // the workspaces switcher can ever be allocated, as if
    // the sliding controls were never slid in at all.
    setWorkspacesFullGeometry(geom) {
        this._fullGeometry = geom;
        this._updateWorkspacesFullGeometry();
    }

    _updateWorkspacesFullGeometry() {
        if (!this._workspacesViews.length)
            return;

        let monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            let geometry = (i == this._primaryIndex) ? this._fullGeometry : monitors[i];
            this._workspacesViews[i].setFullGeometry(geometry);
        }
    }

    _updateWorkspacesActualGeometry() {
        if (!this._workspacesViews.length)
            return;

        let [x, y] = this.get_transformed_position();
        let allocation = this.allocation;
        let width = allocation.x2 - allocation.x1;
        let height = allocation.y2 - allocation.y1;
        let primaryGeometry = { x: x, y: y, width: width, height: height };

        let monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            let geometry = (i == this._primaryIndex) ? primaryGeometry : monitors[i];
            this._workspacesViews[i].setActualGeometry(geometry);
        }
    }

    _onRestacked(overview, stackIndices) {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].syncStacking(stackIndices);
    }

    _onScrollEvent(actor, event) {
        if (!this.mapped)
            return Clutter.EVENT_PROPAGATE;

        if (this._workspacesOnlyOnPrimary &&
            this._getMonitorIndexForEvent(event) != this._primaryIndex)
            return Clutter.EVENT_PROPAGATE;

        let workspaceManager = global.workspace_manager;
        let activeWs = workspaceManager.get_active_workspace();
        let ws;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            ws = activeWs.get_neighbor(Meta.MotionDirection.UP);
            break;
        case Clutter.ScrollDirection.DOWN:
            ws = activeWs.get_neighbor(Meta.MotionDirection.DOWN);
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
        Main.wm.actionMoveWorkspace(ws);
        return Clutter.EVENT_STOP;
    }

    _onKeyPressEvent(actor, event) {
        if (!this.mapped)
            return Clutter.EVENT_PROPAGATE;
        let workspaceManager = global.workspace_manager;
        let activeWs = workspaceManager.get_active_workspace();
        let ws;
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Page_Up:
            ws = activeWs.get_neighbor(Meta.MotionDirection.UP);
            break;
        case Clutter.KEY_Page_Down:
            ws = activeWs.get_neighbor(Meta.MotionDirection.DOWN);
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        Main.wm.actionMoveWorkspace(ws);
        return Clutter.EVENT_STOP;
    }
});
