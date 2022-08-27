// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported ControlsManager */

const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;

const AppDisplay = imports.ui.appDisplay;
const Background = imports.ui.background;
const Dash = imports.ui.dash;
const Layout = imports.ui.layout;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const SearchController = imports.ui.searchController;
const Util = imports.misc.util;
const WindowManager = imports.ui.windowManager;
const WorkspaceThumbnail = imports.ui.workspaceThumbnail;
const WorkspacesView = imports.ui.workspacesView;

var WORKSPACE_SWITCH_TIME = 250;

const SMALL_WORKSPACE_RATIO = 0.25;
const DASH_MAX_HEIGHT_RATIO = 0.15;

const A11Y_SCHEMA = 'org.gnome.desktop.a11y.keyboard';

var SIDE_CONTROLS_ANIMATION_TIME = Overview.ANIMATION_TIME;

var ControlsState = {
    HIDDEN: 0,
    WINDOW_PICKER: 1,
    APP_GRID: 2,
};

var ControlsManagerLayout = GObject.registerClass(
class ControlsManagerLayout extends Clutter.BoxLayout {
    _init(searchEntry, appDisplay, workspacesDisplay, workspacesThumbnails,
        searchController, dash, stateAdjustment, background) {
        super._init({ orientation: Clutter.Orientation.VERTICAL });

        this._appDisplay = appDisplay;
        this._workspacesDisplay = workspacesDisplay;
        this._workspacesThumbnails = workspacesThumbnails;
        this._stateAdjustment = stateAdjustment;
        this._searchEntry = searchEntry;
        this._searchController = searchController;
        this._dash = dash;
        this._background = background;

        this._cachedWorkspaceBoxes = new Map();
        this._postAllocationCallbacks = [];

this.empty = false;
        stateAdjustment.connect('notify::value', () => this.layout_changed());

        this._workAreaBox = new Clutter.ActorBox();
        global.display.connectObject(
            'workareas-changed', () => this._updateWorkAreaBox(),
            this);
        this._updateWorkAreaBox();
    }

    _updateWorkAreaBox() {
        const monitor = Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const startX = workArea.x - monitor.x;
        const startY = workArea.y - monitor.y;
        this._workAreaBox.set_origin(startX, startY);
        this._workAreaBox.set_size(workArea.width, workArea.height);
    }

    _computeWorkspacesBoxForState(state, box, searchHeight, dashHeight, thumbnailsHeight, spacing) {
        const [width, height] = box.get_size();
        const {y1: startY} = this._workAreaBox;

        let expandFraction = 0;
        if (this._workspacesThumbnails.visible)
            expandFraction = this._workspacesThumbnails.expandFraction;

        if (Main.layoutManager.is_phone) {
            const hiddenStateBox = new Clutter.ActorBox();
            const appGridStateBox = new Clutter.ActorBox();

            hiddenStateBox.set_origin(...this._workAreaBox.get_origin());
            hiddenStateBox.set_size(this._workAreaBox.get_width(), this._workAreaBox.get_height() + Main.layoutManager.bottomPanelBox.height);

            appGridStateBox.set_origin(0, startY + searchHeight + spacing);
            appGridStateBox.set_size(
                width,
                Math.round(height * SMALL_WORKSPACE_RATIO));

            switch (state) {
            case ControlsState.HIDDEN:
                return hiddenStateBox;
            case ControlsState.WINDOW_PICKER:
                return hiddenStateBox.interpolate(appGridStateBox, 0.5);
            case ControlsState.APP_GRID:
                return appGridStateBox;
            }
        } else {
            const workspaceBox = new Clutter.ActorBox();

            switch (state) {
            case ControlsState.HIDDEN:
                workspaceBox.set_origin(...this._workAreaBox.get_origin());
                workspaceBox.set_size(this._workAreaBox.get_width(), this._workAreaBox.get_height() + Main.layoutManager.bottomPanelBox.height);
                break;
            case ControlsState.WINDOW_PICKER:
                workspaceBox.set_origin(0,
                    startY + searchHeight + spacing +
                    (thumbnailsHeight + spacing) * expandFraction);
                workspaceBox.set_size(width,
                    height -
                    (dashHeight > 0 ? dashHeight + spacing : 0) -
                    searchHeight - spacing -
                    (thumbnailsHeight + spacing) * expandFraction);
                break;
            case ControlsState.APP_GRID:
                workspaceBox.set_origin(0, startY + searchHeight + spacing);
                workspaceBox.set_size(
                    width,
                    Math.round(height * SMALL_WORKSPACE_RATIO));
                break;
            }

            return workspaceBox;
        }
    }

    _getAppDisplayBoxForState(state, box, searchHeight, dashHeight, workspacesBox, spacing) {
        const [width, height] = box.get_size();
        const {y1: startY} = this._workAreaBox;

        const appDisplayBox = new Clutter.ActorBox();

if (this.empty) {
        appDisplayBox.set_size(width,
            height -
            searchHeight - spacing-
            workspacesBox.get_height() * 0.8 -
            (dashHeight > 0 ? dashHeight + spacing : 0));
} else {
        appDisplayBox.set_size(width,
            height -
            searchHeight - spacing -
            workspacesBox.get_height() - spacing -
            (dashHeight > 0 ? dashHeight + spacing : 0));
}

        if (Main.layoutManager.is_phone) {
            const hiddenStateBox = appDisplayBox.copy();
            const appGridStateBox = appDisplayBox.copy();

            hiddenStateBox.set_origin(0, box.y2);
if (this.empty)
            appGridStateBox.set_origin(0,
                startY + searchHeight + spacing + workspacesBox.get_height() * 0.8);
else
            appGridStateBox.set_origin(0,
                startY + searchHeight + spacing + workspacesBox.get_height() + spacing);

            switch (state) {
            case ControlsState.HIDDEN:
                return hiddenStateBox;
            case ControlsState.WINDOW_PICKER:
                return hiddenStateBox.interpolate(appGridStateBox, 0.5);
            case ControlsState.APP_GRID:
                return appGridStateBox;
            }
        } else {
            switch (state) {
            case ControlsState.HIDDEN:
            case ControlsState.WINDOW_PICKER:
                appDisplayBox.set_origin(0, box.y2);
                break;
            case ControlsState.APP_GRID:
                appDisplayBox.set_origin(0,
                    startY + searchHeight + spacing + workspacesBox.get_height() + spacing);
                break;
            }
        }

        return appDisplayBox;
    }

    _runPostAllocation() {
        if (this._postAllocationCallbacks.length === 0)
            return;

        this._postAllocationCallbacks.forEach(cb => cb());
        this._postAllocationCallbacks = [];
    }

    vfunc_set_container(container) {
        this._container = container;
        if (container)
            this.hookup_style(container);
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        // The MonitorConstraint will allocate us a fixed size anyway
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        // The MonitorConstraint will allocate us a fixed size anyway
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const childBox = new Clutter.ActorBox();

        const startY = this._workAreaBox.y1;
        box.y1 += startY;
        const [width, height] = box.get_size();
        const spacing = height * 0.02;
        let availableHeight = height;

        // Search entry
        let [searchHeight] = this._searchEntry.get_preferred_height(width);
        if (this.empty) {

            if (this._searchEntry.child.text.length > 0) {
         //       searchHeight = 58;
                childBox.set_origin(0, startY);
            } else {
          //      searchHeight = 70;
                childBox.set_origin(0, startY + spacing * 4.5);
            }
        } else {
            childBox.set_origin(0, startY);
        }
        childBox.set_size(width, searchHeight);
    //    searchHeight = 52;
        this._searchEntry.save_easing_state();

        this._searchEntry.allocate(childBox);
        this._searchEntry.restore_easing_state();
        if (this.empty) {
            availableHeight -= searchHeight + spacing * 4;
        } else {
            availableHeight -= searchHeight + spacing;
        }

        // Dash
        let dashHeight = 0;
        if (this._dash.visible) {
            const maxDashHeight = Math.round(box.get_height() * DASH_MAX_HEIGHT_RATIO);
            this._dash.setMaxSize(width, maxDashHeight);

            [, dashHeight] = this._dash.get_preferred_height(width);
            dashHeight = Math.min(dashHeight, maxDashHeight);
            childBox.set_origin(0, startY + height - dashHeight);
            childBox.set_size(width, dashHeight);
            this._dash.allocate(childBox);

            availableHeight -= dashHeight + spacing;
        }

        // Workspace Thumbnails
        let thumbnailsHeight = 0;
        if (this._workspacesThumbnails.visible) {
            const { expandFraction } = this._workspacesThumbnails;
            [thumbnailsHeight] =
                this._workspacesThumbnails.get_preferred_height(width);
            thumbnailsHeight = Math.min(
                thumbnailsHeight * expandFraction,
                height * WorkspaceThumbnail.MAX_THUMBNAIL_SCALE);
            childBox.set_origin(0, startY + searchHeight + spacing);
            childBox.set_size(width, thumbnailsHeight);
            this._workspacesThumbnails.allocate(childBox);
        }

        // Workspaces
        let params = [box, searchHeight, dashHeight, thumbnailsHeight, spacing];
        const transitionParams = this._stateAdjustment.getStateTransitionParams();

        // Update cached boxes
        for (const state of Object.values(ControlsState)) {
            this._cachedWorkspaceBoxes.set(
                state, this._computeWorkspacesBoxForState(state, ...params));
        }

        let workspacesBox;
        if (!transitionParams.transitioning) {
            workspacesBox = this._cachedWorkspaceBoxes.get(transitionParams.currentState);
        } else {
            const initialBox = this._cachedWorkspaceBoxes.get(transitionParams.initialState);
            const finalBox = this._cachedWorkspaceBoxes.get(transitionParams.finalState);
            workspacesBox = initialBox.interpolate(finalBox, transitionParams.progress);
        }

if (this.empty)
        this._workspacesDisplay.allocate(new Clutter.ActorBox());
else
        this._workspacesDisplay.allocate(workspacesBox);

        // AppDisplay
        if (this._appDisplay.visible) {
            const workspaceAppGridBox =
                this._cachedWorkspaceBoxes.get(ControlsState.APP_GRID);

            params = [box, searchHeight, dashHeight, workspaceAppGridBox, spacing];
            let appDisplayBox;
            if (!transitionParams.transitioning) {
                appDisplayBox =
                    this._getAppDisplayBoxForState(transitionParams.currentState, ...params);
            } else {
                const initialBox =
                    this._getAppDisplayBoxForState(transitionParams.initialState, ...params);
                const finalBox =
                    this._getAppDisplayBoxForState(transitionParams.finalState, ...params);

                appDisplayBox = initialBox.interpolate(finalBox, transitionParams.progress);
            }

       /*     this._appDisplay.save_easing_state();
            this._appDisplay.set_easing_duration(500);
            this._appDisplay.set_easing_mode(Clutter.AnimationMode.LINEAR);

            this._appDisplay._grid.save_easing_state();
            //this._appDisplay._grid.background_color = Clutter.color_from_string("red")[1]
            this._appDisplay._grid.set_easing_duration(500);
            this._appDisplay._grid.set_easing_mode(Clutter.AnimationMode.LINEAR);

            this._appDisplay._pageIndicators.save_easing_state();
            //this._appDisplay._grid.background_color = Clutter.color_from_string("red")[1]
            this._appDisplay._pageIndicators.set_easing_duration(500);
            this._appDisplay._pageIndicators.set_easing_mode(Clutter.AnimationMode.LINEAR);
*/
            this._appDisplay.allocate(appDisplayBox);
  /*          this._appDisplay._pageIndicators.restore_easing_state();
            this._appDisplay._grid.restore_easing_state();
            this._appDisplay.restore_easing_state();
*/
        }

        // Search
        childBox.set_origin(0, startY + searchHeight + spacing);
        childBox.set_size(width, availableHeight);

        this._searchController.allocate(childBox);

        box.y1 -= startY;
        this._background.allocate(box);

        this._runPostAllocation();
    }

    ensureAllocation() {
        this.layout_changed();
        return new Promise(
            resolve => this._postAllocationCallbacks.push(resolve));
    }

    getWorkspacesBoxForState(state) {
        return this._cachedWorkspaceBoxes.get(state);
    }
});

var OverviewAdjustment = GObject.registerClass({
    Properties: {
        'gesture-in-progress': GObject.ParamSpec.boolean(
            'gesture-in-progress', 'Gesture in progress', 'Gesture in progress',
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class OverviewAdjustment extends St.Adjustment {
    _init(actor) {
        super._init({
            actor,
            value: ControlsState.WINDOW_PICKER,
            lower: ControlsState.HIDDEN,
            upper: ControlsState.APP_GRID,
        });
    }

    getStateTransitionParams() {
        const currentState = this.value;

        const transition = this.get_transition('value');
        let initialState = transition
            ? transition.get_interval().peek_initial_value()
            : currentState;
        let finalState = transition
            ? transition.get_interval().peek_final_value()
            : currentState;

        if (initialState > finalState) {
            initialState = Math.ceil(initialState);
            finalState = Math.floor(finalState);
        } else {
            initialState = Math.floor(initialState);
            finalState = Math.ceil(finalState);
        }

        const length = Math.abs(finalState - initialState);
        const progress = length > 0
            ? Math.abs((currentState - initialState) / length)
            : 1;

        return {
            transitioning: transition !== null || this.gestureInProgress,
            currentState,
            initialState,
            finalState,
            progress,
        };
    }
});

var ControlsManager = GObject.registerClass(
class ControlsManager extends St.Widget {
    _init() {
        super._init({
            style_class: 'controls-manager',
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });

        this._ignoreShowAppsButtonToggle = false;

        this._searchEntry = new St.Entry({
            style_class: 'search-entry',
            /* Translators: this is the text displayed
               in the search entry when no search is
               active; it should not exceed ~30
               characters. */
            hint_text: _('Type to search'),
            track_hover: true,
            can_focus: true,
        });
        this._searchEntry.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        this._searchEntry.connect('primary-icon-clicked', () => {
            this._searchEntry.grab_key_focus();
        });
        const searchClickGesture = new Clutter.ClickGesture();
        searchClickGesture.connect('clicked', () => {
            this._searchEntry.grab_key_focus();
        });
        this._searchEntry.add_action(searchClickGesture);
        this._searchEntryBin = new St.Bin({
            child: this._searchEntry,
            x_align: Clutter.ActorAlign.CENTER,
        });


        this.dash = new Dash.Dash();
        Main.layoutManager.bind_property('is-phone',
            this.dash, 'visible',
            GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN);

        let workspaceManager = global.workspace_manager;
        let activeWorkspaceIndex = workspaceManager.get_active_workspace_index();

        this._workspaceAdjustment = new St.Adjustment({
            actor: this,
            value: activeWorkspaceIndex,
            lower: 0,
            page_increment: 1,
            page_size: 1,
            step_increment: 0,
            upper: workspaceManager.n_workspaces,
        });

        this._stateAdjustment = new OverviewAdjustment(this);
        this._stateAdjustment.connect('notify::value', this._update.bind(this));

        workspaceManager.connectObject(
            'notify::n-workspaces', () => this._updateAdjustment(), this);

        this._searchController = new SearchController.SearchController(
            this._searchEntry,
            this.dash.showAppsButton);
        this._searchController.connect('notify::search-active', this._onSearchChanged.bind(this));

        Main.layoutManager.connect('monitors-changed', () => {
            this._thumbnailsBox.setMonitorIndex(Main.layoutManager.primaryIndex);
        });
        this._thumbnailsBox = new WorkspaceThumbnail.ThumbnailsBox(
            this._workspaceAdjustment, Main.layoutManager.primaryIndex);
        this._thumbnailsBox.connect('notify::should-show', () => {
            this._thumbnailsBox.ease_property('expand-fraction',
                this._thumbnailsBox.should_show ? 1 : 0, {
                    duration: SIDE_CONTROLS_ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => this._updateThumbnailsBox(),
                });
        });
        Main.layoutManager.connect('notify::is-phone', () => this._updateThumbnailsBox());

        this._workspacesDisplay = new WorkspacesView.WorkspacesDisplay(
            this,
            this._workspaceAdjustment,
            this._stateAdjustment);
        this._appDisplay = new AppDisplay.AppDisplay();

        let monitor = Main.layoutManager.monitors[Main.layoutManager.primaryIndex];
        const wallpaper = new St.Widget({
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        Main.wm.workspaceTracker.bind_property('single-window-workspaces',
            wallpaper, 'visible',
            GObject.BindingFlags.SYNC_CREATE);

        const bgManager = new Background.BackgroundManager({
            container: wallpaper,
            monitorIndex: Main.layoutManager.primaryIndex,
            controlPosition: false,
        });

        this.add_child(wallpaper);
        this.add_child(this._searchEntryBin);
        this.add_child(this._appDisplay);
        this.add_child(this.dash);
        this.add_child(this._searchController);
        this.add_child(this._thumbnailsBox);
        this.add_child(this._workspacesDisplay);

        this.layout_manager = new ControlsManagerLayout(
            this._searchEntryBin,
            this._appDisplay,
            this._workspacesDisplay,
            this._thumbnailsBox,
            this._searchController,
            this.dash,
            this._stateAdjustment,
            wallpaper);

        this.dash.showAppsButton.connect('notify::checked',
            this._onShowAppsButtonToggled.bind(this));

        Main.ctrlAltTabManager.addGroup(
            this.appDisplay,
            _('Applications'),
            'view-app-grid-symbolic', {
                proxy: this,
                focusCallback: () => {
                    this.dash.showAppsButton.checked = true;
                    this.appDisplay.navigate_focus(
                        null, St.DirectionType.TAB_FORWARD, false);
                },
            });

        Main.ctrlAltTabManager.addGroup(
            this._workspacesDisplay,
            _('Windows'),
            'focus-windows-symbolic', {
                proxy: this,
                focusCallback: () => {
                    this.dash.showAppsButton.checked = false;
                    this._workspacesDisplay.navigate_focus(
                        null, St.DirectionType.TAB_FORWARD, false);
                },
            });

        this._a11ySettings = new Gio.Settings({ schema_id: A11Y_SCHEMA });

        this._lastOverlayKeyTime = 0;
        global.display.connect('overlay-key', () => {
            if (this._a11ySettings.get_boolean('stickykeys-enable'))
                return;

            const { initialState, finalState, transitioning } =
                this._stateAdjustment.getStateTransitionParams();

            const time = GLib.get_monotonic_time() / 1000;
            const timeDiff = time - this._lastOverlayKeyTime;
            this._lastOverlayKeyTime = time;

            const shouldShift = St.Settings.get().enable_animations
                ? transitioning && finalState > initialState
                : Main.overview.visible && timeDiff < Overview.ANIMATION_TIME;

            if (shouldShift)
                this._shiftState(Meta.MotionDirection.UP);
            else
                Main.overview.toggle();
        });

        // connect_after to give search controller first dibs on the event
        global.stage.connect_after('key-press-event', (actor, event) => {
            if (this._searchController.searchActive)
                return Clutter.EVENT_PROPAGATE;

            if (global.stage.key_focus &&
                !this.contains(global.stage.key_focus))
                return Clutter.EVENT_PROPAGATE;

            const { finalState } =
                this._stateAdjustment.getStateTransitionParams();
            let keynavDisplay;

            if (finalState === ControlsState.WINDOW_PICKER)
                keynavDisplay = this._workspacesDisplay;
            else if (finalState === ControlsState.APP_GRID)
                keynavDisplay = this._appDisplay;

            if (!keynavDisplay)
                return Clutter.EVENT_PROPAGATE;

            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_Down) {
                keynavDisplay.navigate_focus(
                    null, St.DirectionType.TAB_FORWARD, false);
                return Clutter.EVENT_STOP;
            } else if (symbol === Clutter.KEY_ISO_Left_Tab) {
                keynavDisplay.navigate_focus(
                    null, St.DirectionType.TAB_BACKWARD, false);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        Main.wm.workspaceTracker.connect('notify::zero-open-windows', () =>
            this._emptyStateMaybeChanged(true));
       // this._searchEntry.connect('notify::text', this._emptyStateMaybeChanged.bind(this));

        Main.wm.addKeybinding(
            'toggle-application-view',
            new Gio.Settings({ schema_id: WindowManager.SHELL_KEYBINDINGS_SCHEMA }),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this._toggleAppsPage.bind(this));

        Main.wm.addKeybinding('shift-overview-up',
            new Gio.Settings({ schema_id: WindowManager.SHELL_KEYBINDINGS_SCHEMA }),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._shiftState(Meta.MotionDirection.UP));

        Main.wm.addKeybinding('shift-overview-down',
            new Gio.Settings({ schema_id: WindowManager.SHELL_KEYBINDINGS_SCHEMA }),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._shiftState(Meta.MotionDirection.DOWN));

        this._emptyStateMaybeChanged(true);
        this._update();
    }

    _getFitModeForState(state) {
            return WorkspacesView.FitMode.SINGLE;
        switch (state) {
        case ControlsState.HIDDEN:
        case ControlsState.WINDOW_PICKER:
            return WorkspacesView.FitMode.SINGLE;
        case ControlsState.APP_GRID:
            return WorkspacesView.FitMode.ALL;
        default:
            return WorkspacesView.FitMode.SINGLE;
        }
    }

    _getThumbnailsBoxParams() {
        const { initialState, finalState, progress } =
            this._stateAdjustment.getStateTransitionParams();

        const paramsForState = s => {
            let opacity, scale, translationY;
            switch (s) {
            case ControlsState.HIDDEN:
            case ControlsState.WINDOW_PICKER:
                opacity = 255;
                scale = 1;
                translationY = 0;
                break;
            case ControlsState.APP_GRID:
                opacity = 0;
                scale = 0.5;
                translationY = this._thumbnailsBox.height / 2;
                break;
            default:
                opacity = 255;
                scale = 1;
                translationY = 0;
                break;
            }

            return { opacity, scale, translationY };
        };

        const initialParams = paramsForState(initialState);
        const finalParams = paramsForState(finalState);

        return [
            Util.lerp(initialParams.opacity, finalParams.opacity, progress),
            Util.lerp(initialParams.scale, finalParams.scale, progress),
            Util.lerp(initialParams.translationY, finalParams.translationY, progress),
        ];
    }

    _updateThumbnailsBox(animate = false) {
        const { shouldShow } = this._thumbnailsBox;
        const { searchActive } = this._searchController;
        const [opacity, scale, translationY] = this._getThumbnailsBoxParams();

        const thumbnailsBoxVisible = !Main.layoutManager.is_phone &&
            shouldShow && !searchActive && opacity !== 0;

        if (thumbnailsBoxVisible) {
            this._thumbnailsBox.opacity = 0;
            this._thumbnailsBox.visible = thumbnailsBoxVisible;
        }

        const params = {
            opacity: searchActive ? 0 : opacity,
            duration: animate ? SIDE_CONTROLS_ANIMATION_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => (this._thumbnailsBox.visible = thumbnailsBoxVisible),
        };

        if (!searchActive) {
            params.scale_x = scale;
            params.scale_y = scale;
            params.translation_y = translationY;
        }

        this._thumbnailsBox.ease(params);
    }

    _updateAppDisplayVisibility(stateTransitionParams = null) {
        if (!stateTransitionParams)
            stateTransitionParams = this._stateAdjustment.getStateTransitionParams();

        const { initialState, finalState } = stateTransitionParams;
        const state = Math.max(initialState, finalState);

        this._appDisplay.visible =
            (Main.layoutManager.is_phone || state > ControlsState.WINDOW_PICKER) &&
            !this._searchController.searchActive;
    }

    _update() {
        const params = this._stateAdjustment.getStateTransitionParams();

        const fitMode = Util.lerp(
            this._getFitModeForState(params.initialState),
            this._getFitModeForState(params.finalState),
            params.progress);

        const { fitModeAdjustment } = this._workspacesDisplay;
        fitModeAdjustment.value = fitMode;

        this._updateThumbnailsBox();
        this._updateAppDisplayVisibility(params);
    }

    _onSearchChanged() {

        const { searchActive } = this._searchController;
this.queue_relayout();
        if (!searchActive) {
            this.remove_style_class_name('search-active');
            this._updateAppDisplayVisibility();
            this._workspacesDisplay.reactive = true;
            this._workspacesDisplay.setPrimaryWorkspaceVisible(true);
        } else {
            this.add_style_class_name('search-active');
            this._searchController.show();
        }

        this._updateThumbnailsBox(true);

        this._appDisplay.ease({
            opacity: searchActive ? 0 : 255,
            duration: SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._updateAppDisplayVisibility(),
        });
        this._workspacesDisplay.ease({
            opacity: searchActive ? 0 : 255,
            duration: SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._workspacesDisplay.reactive = !searchActive;
                this._workspacesDisplay.setPrimaryWorkspaceVisible(!searchActive);
            },
        });
        this._searchController.ease({
            opacity: searchActive ? 255 : 0,
            duration: SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => (this._searchController.visible = searchActive),
        });
    }

    _onShowAppsButtonToggled() {
        if (this._ignoreShowAppsButtonToggle)
            return;

        const checked = this.dash.showAppsButton.checked;

        const value = checked
            ? ControlsState.APP_GRID : ControlsState.WINDOW_PICKER;
        this._stateAdjustment.remove_transition('value');
        this._stateAdjustment.ease(value, {
            duration: SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _toggleAppsPage() {
        if (Main.overview.visible) {
            const checked = this.dash.showAppsButton.checked;
            this.dash.showAppsButton.checked = !checked;
        } else {
            Main.overview.show(ControlsState.APP_GRID);
        }
    }

    _shiftState(direction) {
        let { currentState, finalState } = this._stateAdjustment.getStateTransitionParams();

        if (direction === Meta.MotionDirection.DOWN)
            finalState = Math.max(finalState - 1, ControlsState.HIDDEN);
        else if (direction === Meta.MotionDirection.UP)
            finalState = Math.min(finalState + 1, ControlsState.APP_GRID);

        if (finalState === currentState)
            return;

        if (currentState === ControlsState.HIDDEN &&
            finalState === ControlsState.WINDOW_PICKER) {
            Main.overview.show();
        } else if (finalState === ControlsState.HIDDEN) {
            Main.overview.hide();
        } else {
            this._stateAdjustment.ease(finalState, {
                duration: SIDE_CONTROLS_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this.dash.showAppsButton.checked =
                        finalState === ControlsState.APP_GRID;
                },
            });
        }
    }

    _updateAdjustment() {
        let workspaceManager = global.workspace_manager;
        let newNumWorkspaces = workspaceManager.n_workspaces;
        let activeIndex = workspaceManager.get_active_workspace_index();

        this._workspaceAdjustment.upper = newNumWorkspaces;

        // A workspace might have been inserted or removed before the active
        // one, causing the adjustment to go out of sync, so update the value
        this._workspaceAdjustment.remove_transition('value');
        this._workspaceAdjustment.value = activeIndex;
    }

    vfunc_unmap() {
        super.vfunc_unmap();
        this._workspacesDisplay.hide();
    }

    animateToOverview(state, callback) {
        this._ignoreShowAppsButtonToggle = true;

        this._searchController.prepareToEnterOverview();
        this._workspacesDisplay.show();

        this._emptyStateMaybeChanged(true);

        this._stateAdjustment.value = ControlsState.HIDDEN;
        this._stateAdjustment.ease(state, {
            duration: Overview.ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (callback)
                    callback();
            },
        });

        this.dash.showAppsButton.checked =
            state === ControlsState.APP_GRID;

        this._ignoreShowAppsButtonToggle = false;
    }

    animateFromOverview(callback) {
        this._ignoreShowAppsButtonToggle = true;

        this._workspacesDisplay.prepareToLeaveOverview();

        this._stateAdjustment.ease(ControlsState.HIDDEN, {
            duration: Overview.ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this.dash.showAppsButton.checked = false;
                this._ignoreShowAppsButtonToggle = false;

                if (callback)
                    callback();
            },
        });
    }

    getWorkspacesBoxForState(state) {
        return this.layoutManager.getWorkspacesBoxForState(state);
    }

    overviewGestureBegin(tracker) {
        const progress = this._stateAdjustment.value;
        const points = Main.layoutManager.is_phone ? [
            ControlsState.HIDDEN,
            ControlsState.APP_GRID,
        ] : [
            ControlsState.HIDDEN,
            ControlsState.WINDOW_PICKER,
            ControlsState.APP_GRID,
        ];

imports.gi.Cogl.trace_generic_begin("_overviewGestureBegin removing old transition");
        let wasEasingTo = null;
        let cancelProgress = Math.round(progress);
        const transition = this._stateAdjustment.get_transition('value');
        if (transition) {
            wasEasingTo = cancelProgress = transition.get_interval().peek_final_value();
            this._stateAdjustment.remove_transition('value');
        }
imports.gi.Cogl.trace_generic_end();
imports.gi.Cogl.trace_generic_begin("_overviewGestureBegin get ws boxes");
        const hiddenBox = this.layoutManager.getWorkspacesBoxForState(ControlsState.HIDDEN);
        const windowPickerBox = this.layoutManager.getWorkspacesBoxForState(ControlsState.WINDOW_PICKER);
        const appGridBox = this.layoutManager.getWorkspacesBoxForState(ControlsState.APP_GRID);
imports.gi.Cogl.trace_generic_end();
        const distanceHiddenToWindowPicker = Math.abs(hiddenBox.y2 - windowPickerBox.y2);
        const distanceWindowPickerToAppGrid = Math.abs(windowPickerBox.y2 - appGridBox.y2);

        const distance = progress > ControlsState.WINDOW_PICKER
            ? distanceWindowPickerToAppGrid : distanceHiddenToWindowPicker;

imports.gi.Cogl.trace_generic_begin("_overviewGestureBegin confirm swipe");
        tracker.confirmSwipe(distance, points, progress, cancelProgress, wasEasingTo);
imports.gi.Cogl.trace_generic_end();

imports.gi.Cogl.trace_generic_begin("_overviewGestureBegin showing ws display");
        this._workspacesDisplay.show();
imports.gi.Cogl.trace_generic_end();
imports.gi.Cogl.trace_generic_begin("_overviewGestureBegin prepare to enter");
        this._searchController.prepareToEnterOverview();
imports.gi.Cogl.trace_generic_end();
        this._stateAdjustment.gestureInProgress = true;
    }

    overviewGestureProgress(tracker, progress) {
        const oldProgress = this._stateAdjustment.value;

        if ((oldProgress >= ControlsState.WINDOW_PICKER &&
             progress < ControlsState.WINDOW_PICKER) ||
             oldProgress <= ControlsState.WINDOW_PICKER &&
             progress > ControlsState.WINDOW_PICKER) {
            const hiddenBox = this.layoutManager.getWorkspacesBoxForState(ControlsState.HIDDEN);
            const windowPickerBox = this.layoutManager.getWorkspacesBoxForState(ControlsState.WINDOW_PICKER);
            const appGridBox = this.layoutManager.getWorkspacesBoxForState(ControlsState.APP_GRID);

            const distanceHiddenToWindowPicker = Math.abs(hiddenBox.y2 - windowPickerBox.y2);
            const distanceWindowPickerToAppGrid = Math.abs(windowPickerBox.y2 - appGridBox.y2);

            tracker.distance = progress > ControlsState.WINDOW_PICKER
                ? distanceWindowPickerToAppGrid : distanceHiddenToWindowPicker;
        }

        this._stateAdjustment.value = progress;
    }

    overviewGestureEnd(target, duration, onStopped) {
        if (target === ControlsState.HIDDEN)
            this._workspacesDisplay.prepareToLeaveOverview();

        this.dash.showAppsButton.checked =
            target === ControlsState.APP_GRID;

        this._stateAdjustment.remove_transition('value');
        this._stateAdjustment.ease(target, {
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped,
        });

        this._stateAdjustment.gestureInProgress = false;
    }

    workspacesGestureBegin(tracker, monitor) {
        this._searchController.prepareToEnterOverview();
        this._workspacesDisplay.show();

        this._emptyStateMaybeChanged(true);

        this._workspacesDisplay.workspacesGestureBegin(tracker, monitor);
    }

    workspacesGestureProgress(tracker, progress) {
        this._workspacesDisplay.workspacesGestureUpdate(tracker, progress);
    }

    workspacesGestureEnd(tracker, duration, endProgress, onStopped) {
        this._workspacesDisplay.workspacesGestureEnd(tracker, duration, endProgress, onStopped);
    }

    switchToActiveWorkspace(animate, stoppedCb = () => {}) {
        const { workspaceManager } = global;
        const active = workspaceManager.get_active_workspace_index();

        this._searchController.prepareToEnterOverview();
        this._workspacesDisplay.show();

        this._workspaceAdjustment.remove_transition('value');
        this._workspaceAdjustment.ease(active, {
            duration: animate ? WORKSPACE_SWITCH_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: stoppedCb,
        });
    }

    cancelSwitchToActiveWorkspace() {
        this._workspaceAdjustment.remove_transition('value');
    }

    _emptyStateMaybeChanged(allowMovingToNonEmpty) {
        if (!Main.wm.workspaceTracker.singleWindowWorkspaces)
            return;
log("CHECKING " + Main.wm.workspaceTracker.zeroOpenWindows);
        if (Main.wm.workspaceTracker.zeroOpenWindows) {
            this.add_style_class_name("empty");
            this.layout_manager.empty = true;
        } else if (allowMovingToNonEmpty) {
            this.remove_style_class_name("empty");
            this.layout_manager.empty = false;
        }
    }

    async runStartupAnimation(callback) {
        this._ignoreShowAppsButtonToggle = true;

        this._searchController.prepareToEnterOverview();
        this._workspacesDisplay.show();

        const initialState = Main.layoutManager.is_phone
            ? ControlsState.APP_GRID : ControlsState.WINDOW_PICKER;

        this._stateAdjustment.value = ControlsState.HIDDEN;
        this._stateAdjustment.ease(initialState, {
            duration: Overview.ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this.dash.showAppsButton.checked = initialState === ControlsState.APP_GRID;
        this._ignoreShowAppsButtonToggle = false;

        // Set the opacity here to avoid a 1-frame flicker
        this.opacity = 0;

        // We can't run the animation before the first allocation happens
        await this.layout_manager.ensureAllocation();

        const { STARTUP_ANIMATION_TIME } = Layout;

        // Opacity
        this.ease({
            opacity: 255,
            duration: STARTUP_ANIMATION_TIME,
            mode: Clutter.AnimationMode.LINEAR,
        });

        // Search bar falls from the ceiling
        const { primaryMonitor } = Main.layoutManager;
        const [, y] = this._searchEntryBin.get_transformed_position();
        const yOffset = y - primaryMonitor.y;

        this._searchEntryBin.translation_y = -(yOffset + this._searchEntryBin.height);
        this._searchEntryBin.ease({
            translation_y: 0,
            duration: STARTUP_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // The Dash rises from the bottom. This is the last animation to finish,
        // so run the callback there.
        this.dash.translation_y = this.dash.height + this.dash.margin_bottom;
        this.dash.ease({
            translation_y: 0,
            delay: STARTUP_ANIMATION_TIME,
            duration: STARTUP_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => callback(),
        });
    }

    get searchEntry() {
        return this._searchEntry;
    }

    get appDisplay() {
        return this._appDisplay;
    }
});
