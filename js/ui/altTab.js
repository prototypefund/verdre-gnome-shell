// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const Main = imports.ui.main;
const SwitcherPopup = imports.ui.switcherPopup;
const Tweener = imports.ui.tweener;

var APP_ICON_HOVER_TIMEOUT = 200; // milliseconds

var THUMBNAIL_DEFAULT_SIZE = 256;
var THUMBNAIL_POPUP_TIME = 500; // milliseconds
var THUMBNAIL_FADE_TIME = 0.2; // seconds

var WINDOW_PREVIEW_SIZE = 128;
var APP_ICON_SIZE = 96;
var APP_ICON_SIZE_SMALL = 48;

const baseIconSizes = [96, 64, 48, 32, 22];

var AppIconMode = {
    THUMBNAIL_ONLY: 1,
    APP_ICON_ONLY: 2,
    BOTH: 3,
};

function _createWindowClone(window, size) {
    let [width, height] = window.get_size();
    let scale = Math.min(1.0, size / width, size / height);
    return new Clutter.Clone({ source: window,
                               width: width * scale,
                               height: height * scale,
                               x_align: Clutter.ActorAlign.CENTER,
                               y_align: Clutter.ActorAlign.CENTER,
                               // usual hack for the usual bug in ClutterBinLayout...
                               x_expand: true,
                               y_expand: true });
};

function getWindows(workspace) {
    // We ignore skip-taskbar windows in switchers, but if they are attached
    // to their parent, their position in the MRU list may be more appropriate
    // than the parent; so start with the complete list ...
    let windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL,
                                              workspace);
    // ... map windows to their parent where appropriate ...
    return windows.map(w => {
        return w.is_attached_dialog() ? w.get_transient_for() : w;
    // ... and filter out skip-taskbar windows and duplicates
    }).filter((w, i, a) => !w.skip_taskbar && a.indexOf(w) == i);
}

var AppSwitcherPopup = new Lang.Class({
    Name: 'AppSwitcherPopup',
    Extends: SwitcherPopup.SwitcherPopup,

    _init() {
        this.parent();

        this._thumbnails = null;
        this._thumbnailTimeoutId = 0;
        this._currentWindow = -1;

        this.thumbnailsVisible = false;

        let apps = Shell.AppSystem.get_default().get_running();

        let settings = new Gio.Settings({ schema_id: 'org.gnome.shell.app-switcher' });

        this._currentWorkspace = null;
        if (settings.get_boolean('current-workspace-only')) {
            let workspaceManager = global.workspace_manager;

            this._currentWorkspace = workspaceManager.get_active_workspace();
        }

        this._switcherList = new AppSwitcher(apps, this._currentWorkspace, this);
        this._items = this._switcherList.icons;
    },

    _allocate(actor, box, flags) {
        this.parent(actor, box, flags);

        // Allocate the thumbnails
        // We try to avoid overflowing the screen so we base the resulting size on
        // those calculations
        if (this._thumbnails) {
            let childBox = this._switcherList.actor.get_allocation_box();
            let primary = Main.layoutManager.primaryMonitor;

            let themeNode = this.actor.get_theme_node();
            let leftPadding = themeNode.get_padding(St.Side.LEFT);
            let rightPadding = themeNode.get_padding(St.Side.RIGHT);
            let bottomPadding = themeNode.get_padding(St.Side.BOTTOM);
            let spacing = themeNode.get_length('spacing');

            let icon = this._items[this._selectedIndex].actor;
            let [posX, posY] = icon.get_transformed_position();
            let thumbnailCenter = posX + icon.width / 2;

            let [childMinWidth, childNaturalWidth] = this._thumbnails.actor.get_preferred_width(-1);
            childBox.x1 = Math.max(primary.x + leftPadding, Math.floor(thumbnailCenter - childNaturalWidth / 2));
            let rightLimit = primary.x + primary.width - rightPadding;
            if (childBox.x1 + childNaturalWidth > rightLimit)
                childBox.x1 = Math.max(primary.x + leftPadding, rightLimit - childNaturalWidth);

            childBox.x2 = Math.min(childBox.x1 + childNaturalWidth, rightLimit);

            childBox.y1 = this._switcherList.actor.allocation.y2 + spacing;

            let maxSwitcherListHeight = primary.y + primary.height - bottomPadding - childBox.y1;
            this._thumbnails.addClones(maxSwitcherListHeight);

            let [childMinHeight, childNaturalHeight] = this._thumbnails.actor.get_preferred_height(-1);
            childBox.y2 = childBox.y1 + childNaturalHeight;

            this._thumbnails.actor.allocate(childBox, flags);
        }
    },

    _initialSelection(backward, binding) {
        if (binding == 'switch-group') {
            if (backward) {
                this._select(0, this._items[0].cachedWindows.length - 1);
            } else {
                if (this._items[0].cachedWindows.length > 1)
                    this._select(0, 1);
                else
                    this._select(0, 0);
            }
        } else if (binding == 'switch-group-backward') {
            this._select(0, this._items[0].cachedWindows.length - 1);
        } else if (binding == 'switch-applications-backward') {
            this._select(this._items.length - 1);
        } else if (this._items.length == 1) {
            this._select(0);
        } else if (backward) {
            this._select(this._items.length - 1);
        } else {
            this._select(1);
        }
    },

    _nextWindow() {
        // We actually want the second window if we're in the unset state
        if (this._currentWindow == -1)
            this._currentWindow = 0;
        return SwitcherPopup.mod(this._currentWindow + 1,
                                 this._items[this._selectedIndex].cachedWindows.length);
    },

    _previousWindow() {
        // Also assume second window here
        if (this._currentWindow == -1)
            this._currentWindow = 1;
        return SwitcherPopup.mod(this._currentWindow - 1,
                                 this._items[this._selectedIndex].cachedWindows.length);
    },

    _closeAppWindow(appIndex, windowIndex) {
        let appIcon = this._items[appIndex];
        if (!appIcon)
            return;

        let window = appIcon.cachedWindows[windowIndex];
        if (!window)
            return;

        window.delete(global.get_current_time());
    },

    _quitApplication(appIndex) {
        let appIcon = this._items[appIndex];
        if (!appIcon)
            return;

        // If we are limited to the workspace only close windows on workspace
        if (this._currentWorkspace)
            appIcon.cachedWindows.forEach(window => window.delete(global.get_current_time()));
        else
            appIcon.app.request_quit();
    },

    _keyPressHandler(keysym, action) {
        let selectedWindowBefore = this._currentWindow;

        if (action == Meta.KeyBindingAction.SWITCH_GROUP) {
            if (!this._thumbnailsFocused)
                this._select(this._selectedIndex, 0);
            else
                this._select(this._selectedIndex, this._nextWindow());
        } else if (action == Meta.KeyBindingAction.SWITCH_GROUP_BACKWARD) {
            this._select(this._selectedIndex, this._previousWindow());
        } else if (action == Meta.KeyBindingAction.SWITCH_APPLICATIONS) {
            this._select(this._next());
        } else if (action == Meta.KeyBindingAction.SWITCH_APPLICATIONS_BACKWARD) {
            this._select(this._previous());
        } else if (keysym == Clutter.q || keysym == Clutter.Q) {
            this._quitApplication(this._selectedIndex);
        } else if (this._thumbnailsFocused) {
            if (keysym == Clutter.Left)
                this._select(this._selectedIndex, this._previousWindow());
            else if (keysym == Clutter.Right)
                this._select(this._selectedIndex, this._nextWindow());
            else if (keysym == Clutter.Up)
                this._select(this._selectedIndex, null, true);
            else if (keysym == Clutter.w || keysym == Clutter.W || keysym == Clutter.F4)
                this._closeAppWindow(this._selectedIndex, this._currentWindow);
            else
                return Clutter.EVENT_PROPAGATE;
        } else {
            if (keysym == Clutter.Left)
                this._select(this._previous());
            else if (keysym == Clutter.Right)
                this._select(this._next());
            else if (keysym == Clutter.Down)
                this._select(this._selectedIndex, 0);
            else
                return Clutter.EVENT_PROPAGATE;
        }

        if (selectedWindowBefore != this._currentWindow)
            this._disableHover();

        return Clutter.EVENT_STOP;
    },

    _scrollHandler(direction) {
        if (direction == Clutter.ScrollDirection.UP) {
            if (this._thumbnailsFocused) {
                if (this._currentWindow == 0 || this._currentWindow == -1)
                    this._select(this._previous());
                else
                    this._select(this._selectedIndex, this._previousWindow());
            } else {
                let nwindows = this._items[this._selectedIndex].cachedWindows.length;
                if (nwindows > 1)
                    this._select(this._selectedIndex, nwindows - 1);
                else
                    this._select(this._previous());
            }
        } else if (direction == Clutter.ScrollDirection.DOWN) {
            if (this._thumbnailsFocused) {
                if (this._currentWindow == this._items[this._selectedIndex].cachedWindows.length - 1)
                    this._select(this._next());
                else
                    this._select(this._selectedIndex, this._nextWindow());
            } else {
                let nwindows = this._items[this._selectedIndex].cachedWindows.length;
                if (nwindows > 1)
                    this._select(this._selectedIndex, 0);
                else
                    this._select(this._next());
            }
        }
    },

    _itemActivatedHandler(n) {
        // If the user clicks on the selected app and a
        // window is selected, use it
        if (n == this._selectedIndex && this._currentWindow >= 0)
            this._select(n, this._currentWindow);
        else
            this._select(n);
    },

    _itemAddedHandler(n) {
        if (n < this._selectedIndex || n == this._selectedIndex) {
            if (this._thumbnails && this._currentWindow >= 0) {
                // Destroy thumbnails without animation since we show them right again
                this._thumbnails.disconnectHandlers();
                this._thumbnails.actor.destroy();
                this._thumbnails = null;
                this._switcherList.removeAccessibleState(this._selectedIndex, Atk.StateType.EXPANDED);

                this._select(this._selectedIndex + 1, this._currentWindow);
            } else {
                this._select(this._selectedIndex + 1);
            }
        }
    },

    _itemRemovedHandler(n) {
        if (this._items.length > 0) {
            // If the last item is selected and was removed, we fall back to this
            let newIndex = this._items.length - 1;

            if (n < this._selectedIndex)
                newIndex = this._selectedIndex - 1;
            else if (n == this._selectedIndex && n != this._items.length)
                newIndex = this._selectedIndex;
            else if (n > this._selectedIndex)
                return; // No need to select something new in this case

            if (this._thumbnails && this._currentWindow >= 0 && n != this._selectedIndex) {
                // Destroy thumbnails without animation since we show them right again
                this._thumbnails.disconnectHandlers();
                this._thumbnails.actor.destroy();
                this._thumbnails = null;
                this._switcherList.removeAccessibleState(this._selectedIndex, Atk.StateType.EXPANDED);

                this._select(newIndex, this._currentWindow);
            } else {
                this._select(newIndex);
            }
        } else {
            this.destroy();
        }
    },

    _windowActivated(thumbnailSwitcher, n) {
        Main.activateWindow(thumbnailSwitcher.icon.cachedWindows[n]);
        this.destroy();
    },

    _windowEntered(thumbnailSwitcher, n) {
        if (!this.mouseActive)
            return;

        this._select(this._selectedIndex, n);
    },

    _windowAdded(thumbnailSwitcher, n) {
        // Only select new thumbnail if a thumbnail was selected before
        if (this._thumbnailsFocused && (n < this._currentWindow || n == this._currentWindow))
            this._select(this._selectedIndex, this._currentWindow + 1);
    },

    _windowRemoved(thumbnailSwitcher, n) {
        // Only select new thumbnail if a thumbnail was selected before
        if (this._thumbnailsFocused) {
            // If only one window is left, move the selection to the parent,
            // this also destroys the thumbnails
            if (thumbnailSwitcher.icon.cachedWindows.length == 1) {
                this._select(this._selectedIndex);
            } else {
                let newIndex = thumbnailSwitcher.icon.cachedWindows.length - 1;

                if (n < this._currentWindow)
                    newIndex = this._currentWindow - 1;
                else if (n == this._currentWindow && n != thumbnailSwitcher.icon.cachedWindows.length)
                    newIndex = this._currentWindow;
                else if (n > this._currentWindow)
                    return; // No need to select something new in this case

                this._select(this._selectedIndex, newIndex);
            }
        } else if (thumbnailSwitcher.icon.cachedWindows.length == 1) {
            this._destroyThumbnails();
        }
    },

    _finish(timestamp) {
        let appIcon = this._items[this._selectedIndex];
        if (this._currentWindow < 0)
            appIcon.app.activate_window(appIcon.cachedWindows[0], timestamp);
        else if (appIcon.cachedWindows[this._currentWindow])
            Main.activateWindow(appIcon.cachedWindows[this._currentWindow], timestamp);

        this.parent();
    },

    _onDestroy() {
        this.parent();

        if (this._thumbnails)
            this._destroyThumbnails();
        if (this._thumbnailTimeoutId != 0)
            GLib.source_remove(this._thumbnailTimeoutId);
    },

    /**
     * _select:
     * @app: index of the app to select
     * @window: (optional) index of which of @app's windows to select
     * @forceAppFocus: optional flag, see below
     *
     * Selects the indicated @app, and optional @window, and sets
     * this._thumbnailsFocused appropriately to indicate whether the
     * arrow keys should act on the app list or the thumbnail list.
     *
     * If @app is specified and @window is unspecified or %null, then
     * the app is highlighted (ie, given a light background), and the
     * current thumbnail list, if any, is destroyed. If @app has
     * multiple windows, and @forceAppFocus is not %true, then a
     * timeout is started to open a thumbnail list.
     *
     * If @app and @window are specified (and @forceAppFocus is not),
     * then @app will be outlined, a thumbnail list will be created
     * and focused (if it hasn't been already), and the @window'th
     * window in it will be highlighted.
     *
     * If @app and @window are specified and @forceAppFocus is %true,
     * then @app will be highlighted, and @window outlined, and the
     * app list will have the keyboard focus.
     */
    _select(app, window, forceAppFocus) {
        if (app != this._selectedIndex || window == null) {
            if (this._thumbnails)
                this._destroyThumbnails();
        }

        if (this._thumbnailTimeoutId != 0) {
            GLib.source_remove(this._thumbnailTimeoutId);
            this._thumbnailTimeoutId = 0;
        }

        this._thumbnailsFocused = (window != null) && !forceAppFocus;

        this._selectedIndex = app;
        this._currentWindow = window ? window : -1;
        this._switcherList.highlight(app, this._thumbnailsFocused);

        if (window != null) {
            if (!this._thumbnails)
                this._createThumbnails();
            this._currentWindow = window;
            this._thumbnails.highlight(window, forceAppFocus);
        } else if (this._items[this._selectedIndex].cachedWindows.length > 1 &&
                   !forceAppFocus) {
            this._thumbnailTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                THUMBNAIL_POPUP_TIME,
                this._timeoutPopupThumbnails.bind(this));
            GLib.Source.set_name_by_id(this._thumbnailTimeoutId, '[gnome-shell] this._timeoutPopupThumbnails');
        }
    },

    _timeoutPopupThumbnails() {
        if (!this._thumbnails)
            this._createThumbnails();
        this._thumbnailTimeoutId = 0;
        this._thumbnailsFocused = false;
        return GLib.SOURCE_REMOVE;
    },

    _destroyThumbnails() {
        let thumbnailsActor = this._thumbnails.actor;

        // Disconnect signal handlers now instead of onDestroy.
        // When this._thumbnails is null, the object isn't referenced
        // anymore and GC will kick in, making disconnecting
        // signal handlers impossible.
        this._thumbnails.disconnectHandlers();
        this._thumbnails = null;
        this.thumbnailsVisible = false;
        this._thumbnailsFocused = false;

        Tweener.addTween(thumbnailsActor,
                         { opacity: 0,
                           time: THUMBNAIL_FADE_TIME,
                           transition: 'easeOutQuad',
                           onComplete: () => thumbnailsActor.destroy()
                         });

        this._switcherList.removeAccessibleState(this._selectedIndex, Atk.StateType.EXPANDED);
    },

    _createThumbnails() {
        this._thumbnails = new ThumbnailSwitcher(this._items[this._selectedIndex]);
        this._thumbnails.connect('item-activated', this._windowActivated.bind(this));
        this._thumbnails.connect('item-entered', this._windowEntered.bind(this));
        this._thumbnails.connect('item-added', this._windowAdded.bind(this));
        this._thumbnails.connect('item-removed', this._windowRemoved.bind(this));

        this.actor.add_actor(this._thumbnails.actor);

        // Need to force an allocation so we can figure out whether we
        // need to scroll when selecting
        this._thumbnails.actor.get_allocation_box();

        this._thumbnails.actor.opacity = 0;
        Tweener.addTween(this._thumbnails.actor,
                         { opacity: 255,
                           time: THUMBNAIL_FADE_TIME,
                           transition: 'easeOutQuad'
                         });

        this.thumbnailsVisible = true;
        this._switcherList.addAccessibleState(this._selectedIndex, Atk.StateType.EXPANDED);
    },

    // We need this function to start showing thumbnails if the item is already selected
    onWindowAdded(index) {
        if (this._thumbnailTimeoutId != 0)
            return;

        if (this._selectedIndex == index && !this._thumbnails) {
            this._thumbnailTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                THUMBNAIL_POPUP_TIME,
                this._timeoutPopupThumbnails.bind(this));
            GLib.Source.set_name_by_id(this._thumbnailTimeoutId, '[gnome-shell] this._timeoutPopupThumbnails');
        }
    }
});

var CyclerHighlight = new Lang.Class({
    Name: 'CyclerHighlight',

    _init() {
        this._window = null;

        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout() });

        this._clone = new Clutter.Clone();
        this.actor.add_actor(this._clone);

        this._highlight = new St.Widget({ style_class: 'cycler-highlight' });
        this.actor.add_actor(this._highlight);

        let coordinate = Clutter.BindCoordinate.ALL;
        let constraint = new Clutter.BindConstraint({ coordinate: coordinate });
        this._clone.bind_property('source', constraint, 'source', 0);

        this.actor.add_constraint(constraint);

        this.actor.connect('notify::allocation',
                           this._onAllocationChanged.bind(this));
        this.actor.connect('destroy', this._onDestroy.bind(this));
    },

    set window(w) {
        if (this._window == w)
            return;

        this._window = w;

        if (this._clone.source)
            this._clone.source.sync_visibility();

        let windowActor = this._window ? this._window.get_compositor_private()
                                       : null;

        if (windowActor)
            windowActor.hide();

        this._clone.source = windowActor;
    },

    _onAllocationChanged() {
        if (!this._window) {
            this._highlight.set_size(0, 0);
            this._highlight.hide();
        } else {
            let [x, y] = this.actor.allocation.get_origin();
            let rect = this._window.get_frame_rect();
            this._highlight.set_size(rect.width, rect.height);
            this._highlight.set_position(rect.x - x, rect.y - y);
            this._highlight.show();
        }
    },

    _onDestroy() {
        this.window = null;
    }
});

var CyclerPopup = new Lang.Class({
    Name: 'CyclerPopup',
    Extends: SwitcherPopup.SwitcherPopup,
    Abstract: true,

    _init() {
        this.parent();

        let settings = new Gio.Settings({ schema_id: 'org.gnome.shell.window-switcher' });

        this._currentWorkspace = null;
        if (settings.get_boolean('current-workspace-only')) {
            let workspaceManager = global.workspace_manager;

            this._currentWorkspace = workspaceManager.get_active_workspace();
        }

        let windows = this._getWindows();

        windows.forEach(window => this._addWindow(window));

        this._highlight = new CyclerHighlight();
        global.window_group.add_actor(this._highlight.actor);

        // We don't show an actual popup, so just provide what SwitcherPopup
        // expects instead of inheriting from SwitcherList
        this._switcherList = { actor: new St.Widget(),
                               highlight: this._highlightItem.bind(this),
                               connect() {} };

        if (this._currentWorkspace) {
            this._workspaceWindowAddedSignalId = this._currentWorkspace.connect_after('window-added', (workspace, window) => this._onWindowAdded(window));
            this._workspaceWindowRemovedSignalId = this._currentWorkspace.connect_after('window-removed', (workspace, window) => this._removeWindow(window));
        } else {
            this._windowCreatedSignalId = global.display.connect('window-created', (display, window) => this._onWindowAdded(window));
        }
    },

    _onWindowAdded(window) {
        let windows = this._getWindows();
        let index = windows.indexOf(window);
        if (index === -1)
            return;

        this._addWindow(window, index);
    },

    _addWindow(window, index) {
        if (index != undefined) {
            this._items.splice(index, 0, window);

            // Call _itemAdded here since there won't be an event emitted by SwitcherList
            this._itemAdded(this._switcherList, index);
        } else {
            this._items.push(window);
        }

        window._unmanagedSignalId = window.connect('unmanaged', this._removeWindow.bind(this));
    },

    _removeWindow(window) {
        let index = this._items.indexOf(window);
        if (index === -1)
            return;

        let item = this._items.splice(index, 1)[0];
        window.disconnect(item._unmanagedSignalId);

        // Call _itemRemoved here since there won't be an event emitted by SwitcherList
        this._itemRemoved(this._switcherList, index);
    },

    _highlightItem(index, justOutline) {
        this._highlight.window = this._items[index];
        global.window_group.set_child_above_sibling(this._highlight.actor, null);
    },

    _closeWindow(windowIndex) {
        let window = this._items[windowIndex];
        if (!window)
            return;

        window.delete(global.get_current_time());
    },

    _keyPressHandler(keysym, action) {
        if (keysym == Clutter.w || keysym == Clutter.W || keysym == Clutter.F4)
            this._closeWindow(this._selectedIndex);
        else
            return Clutter.EVENT_PROPAGATE;

        return Clutter.EVENT_STOP;
    },

    _finish() {
        let window = this._items[this._selectedIndex];
        let ws = window.get_workspace();
        let workspaceManager = global.workspace_manager;
        let activeWs = workspaceManager.get_active_workspace();

        if (window.minimized) {
            Main.wm.skipNextEffect(window.get_compositor_private());
            window.unminimize();
        }

        if (activeWs == ws) {
            Main.activateWindow(window);
        } else {
            // If the selected window is on a different workspace, we don't
            // want it to disappear, then slide in with the workspace; instead,
            // always activate it on the active workspace ...
            activeWs.activate_with_focus(window, global.get_current_time());

            // ... then slide it over to the original workspace if necessary
            Main.wm.actionMoveWindow(window, ws);
        }

        this.parent();
    },

    _onDestroy() {
        this._highlight.actor.destroy();

        if (this._currentWorkspace) {
            this._currentWorkspace.disconnect(this._workspaceWindowAddedSignalId);
            this._currentWorkspace.disconnect(this._workspaceWindowRemovedSignalId);
        } else {
            global.display.disconnect(this._windowCreatedSignalId);
        }

        this._items.forEach(window => {
            window.disconnect(window._unmanagedSignalId);
        });

        this.parent();
    }
});


var GroupCyclerPopup = new Lang.Class({
    Name: 'GroupCyclerPopup',
    Extends: CyclerPopup,

    _init() {
        this._tracker = Shell.WindowTracker.get_default();
        this._app = this._tracker.focus_app;

        this.parent();
    },

    _getWindows() {
        let allWindows = getWindows(this._currentWorkspace);

        return allWindows.filter(w => this._tracker.get_window_app(w) == this._app);
    },

    _keyPressHandler(keysym, action) {
        if (this.parent(keysym, action) != Clutter.EVENT_PROPAGATE)
           return Clutter.EVENT_STOP;

        if (action == Meta.KeyBindingAction.CYCLE_GROUP)
            this._select(this._next());
        else if (action == Meta.KeyBindingAction.CYCLE_GROUP_BACKWARD)
            this._select(this._previous());
        else
            return Clutter.EVENT_PROPAGATE;

        return Clutter.EVENT_STOP;
    }
});

var WindowCyclerPopup = new Lang.Class({
    Name: 'WindowCyclerPopup',
    Extends: CyclerPopup,

    _getWindows() {
        return getWindows(this._currentWorkspace);
    },

    _keyPressHandler(keysym, action) {
        if (this.parent(keysym, action) != Clutter.EVENT_PROPAGATE)
           return Clutter.EVENT_STOP;

        if (action == Meta.KeyBindingAction.CYCLE_WINDOWS)
            this._select(this._next());
        else if (action == Meta.KeyBindingAction.CYCLE_WINDOWS_BACKWARD)
            this._select(this._previous());
        else
            return Clutter.EVENT_PROPAGATE;

        return Clutter.EVENT_STOP;
    }
});

var WindowSwitcherPopup = new Lang.Class({
    Name: 'WindowSwitcherPopup',
    Extends: SwitcherPopup.SwitcherPopup,

    _init() {
        this.parent();

        let settings = new Gio.Settings({ schema_id: 'org.gnome.shell.window-switcher' });

        let currentWorkspace = null;
        if (settings.get_boolean('current-workspace-only')) {
            let workspaceManager = global.workspace_manager;

            currentWorkspace = workspaceManager.get_active_workspace();
        }

        let mode = settings.get_enum('app-icon-mode');

        let windows = getWindows(currentWorkspace);

        this._switcherList = new WindowSwitcher(windows, mode, currentWorkspace);
        this._items = this._switcherList.icons;
    },

    _closeWindow(windowIndex) {
        let windowIcon = this._items[windowIndex];
        if (!windowIcon)
            return;

        windowIcon.window.delete(global.get_current_time());
    },

    _keyPressHandler(keysym, action) {
        if (action == Meta.KeyBindingAction.SWITCH_WINDOWS) {
            this._select(this._next());
        } else if (action == Meta.KeyBindingAction.SWITCH_WINDOWS_BACKWARD) {
            this._select(this._previous());
        } else {
            if (keysym == Clutter.Left)
                this._select(this._previous());
            else if (keysym == Clutter.Right)
                this._select(this._next());
            else if (keysym == Clutter.w || keysym == Clutter.W || keysym == Clutter.F4)
                this._closeWindow(this._selectedIndex);
            else
                return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_STOP;
    },

    _finish() {
        Main.activateWindow(this._items[this._selectedIndex].window);

        this.parent();
    }
});

var AppIcon = new Lang.Class({
    Name: 'AppIcon',

    _init(app) {
        this.app = app;
        this.actor = new St.BoxLayout({ style_class: 'alt-tab-app',
                                        vertical: true });

        this.icon = null;
        this._iconBin = new St.Bin({ x_fill: true, y_fill: true });
        this.actor.add(this._iconBin, { x_fill: false, y_fill: false });

        this.label = new St.Label({ text: this.app.get_name() });
        this.actor.add(this.label, { x_fill: false });
    },

    set_size(size) {
        this.icon = this.app.create_icon_texture(size);
        this._iconBin.child = this.icon;
    }
});

var AppSwitcher = new Lang.Class({
    Name: 'AppSwitcher',
    Extends: SwitcherPopup.SwitcherList,

    _init(apps, currentWorkspace, altTabPopup) {
        this.parent(true);

        this.icons = [];
        this._arrows = [];

        this._tracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();
        this._currentWorkspace = currentWorkspace;

        let allWindows = getWindows(this._currentWorkspace);

        for (let i = 0; i < apps.length; i++) {
            let appIcon = new AppIcon(apps[i]);

            // Cache the window list
            appIcon.cachedWindows = allWindows.filter(w => this._tracker.get_window_app(w) == appIcon.app);

            if (appIcon.cachedWindows.length > 0)
                this._addIcon(appIcon);
        }

        this._iconSize = 0;
        this._altTabPopup = altTabPopup;
        this._mouseTimeOutId = 0;

        if (this._currentWorkspace) {
            this._workspaceWindowAddedSignalId = this._currentWorkspace.connect_after('window-added', (workspace, window) => {
                // Workaround for a bug in Mutter: https://gitlab.gnome.org/GNOME/mutter/issues/157
                // When running under Wayland, the app tracker doesn't know about the app the new window
                // belongs to, because the gtk-application-id isn't set.
                // Wait until the id has been updated to be sure the tracker can resolve the window to an app.
                // We don't have to apply the other workaround here since we're waiting anyway.
                if (Meta.is_wayland_compositor()) {
                    let tmpId = window.connect_after('notify::gtk-application-id', () => {
                        // Another bug in Mutter, wait until the window is allocated so we can generate the clone.
                        let mutterWindow = window.get_compositor_private();
                        let tmpId2 = mutterWindow.connect('allocation-changed', () => {
                            this._onWindowAdded(window);
                            mutterWindow.disconnect(tmpId2);
                        });

                        window.disconnect(tmpId);
                    });
                // Workaround for a bug in Mutter: https://gitlab.gnome.org/GNOME/mutter/issues/156
                // The window-added signal for the workspace is emitted before the window actor is created,
                // wait until the window-created signal is emitted and then handle the new window.
                } else {
                    let tmpId = global.display.connect('window-created', () => {
                        this._onWindowAdded(window);
                        global.display.disconnect(tmpId);
                    });
                }
            });

            this._workspaceWindowRemovedSignalId = this._currentWorkspace.connect_after('window-removed', (workspace, window) => this._onWindowRemoved(window));
        } else {
            this._windowCreatedSignalId = global.display.connect('window-created', (display, window) => {
                // Workaround for a bug in Mutter: https://gitlab.gnome.org/GNOME/mutter/issues/157
                // When running under Wayland, the app tracker doesn't know about the app the new window
                // belongs to, because the gtk-application-id isn't set.
                // Wait until the id has been updated to be sure the tracker can resolve the window to an app.
                if (Meta.is_wayland_compositor()) {
                    let tmpId = window.connect_after('notify::gtk-application-id', () => {
                        // Another bug in Mutter, wait until the window is allocated so we can generate the clone.
                        let mutterWindow = window.get_compositor_private();
                        let tmpId2 = mutterWindow.connect('allocation-changed', () => {
                            this._onWindowAdded(window);
                            mutterWindow.disconnect(tmpId2);
                        });

                        window.disconnect(tmpId);
                    });
                } else {
                    this._onWindowAdded(window);
                }
            });
        }

        this.actor.connect('destroy', this._onDestroy.bind(this));
    },

    _onDestroy() {
        if (this._mouseTimeOutId != 0)
            GLib.source_remove(this._mouseTimeOutId);

        if (this._currentWorkspace) {
            this._currentWorkspace.disconnect(this._workspaceWindowAddedSignalId);
            this._currentWorkspace.disconnect(this._workspaceWindowRemovedSignalId);
        } else {
            global.display.disconnect(this._windowCreatedSignalId);
        }

        this.icons.forEach(icon => {
            icon.cachedWindows.forEach(window => window.disconnect(window._unmanagedSignalId));
        });
    },

    _setIconSize() {
        if (this._iconSize)
            return;

        let j = 0;
        while (this._items.length > 1 && this._items[j].style_class != 'item-box') {
            j++;
        }

        let themeNode = this._items[j].get_theme_node();

        let iconPadding = themeNode.get_horizontal_padding();
        let iconBorder = themeNode.get_border_width(St.Side.LEFT) + themeNode.get_border_width(St.Side.RIGHT);
        let [iconMinHeight, iconNaturalHeight] = this.icons[j].label.get_preferred_height(-1);
        let iconSpacing = iconNaturalHeight + iconPadding + iconBorder;
        let totalSpacing = this._list.spacing * (this._items.length - 1);

        // We just assume the whole screen here due to weirdness happening with the passed width
        let primary = Main.layoutManager.primaryMonitor;
        let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
        let availWidth = primary.width - parentPadding - this.actor.get_theme_node().get_horizontal_padding();

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let iconSizes = baseIconSizes.map(s => s * scaleFactor);

        if (this._items.length == 1) {
            this._iconSize = baseIconSizes[0];
        } else {
            for (let i = 0; i < baseIconSizes.length; i++) {
                this._iconSize = baseIconSizes[i];
                let height = iconSizes[i] + iconSpacing;
                let width = height * this._items.length + totalSpacing;
                if (width <= availWidth)
                    break;
            }
        }

        for (let i = 0; i < this.icons.length; i++) {
            if (this.icons[i].icon != null)
                break;

            this.icons[i].set_size(this._iconSize);
        }
    },

    _getPreferredHeight(actor, forWidth, alloc) {
        this._setIconSize();
        this.parent(actor, forWidth, alloc);
    },

    _allocate(actor, box, flags) {
        // Allocate the main list items
        this.parent(actor, box, flags);

        let arrowHeight = Math.floor(this.actor.get_theme_node().get_padding(St.Side.BOTTOM) / 3);
        let arrowWidth = arrowHeight * 2;

        // Now allocate each arrow underneath its item
        let childBox = new Clutter.ActorBox();
        for (let i = 0; i < this._items.length; i++) {
            let itemBox = this._items[i].allocation;
            childBox.x1 = Math.floor(itemBox.x1 + (itemBox.x2 - itemBox.x1 - arrowWidth) / 2);
            childBox.x2 = childBox.x1 + arrowWidth;
            childBox.y1 = itemBox.y2 + arrowHeight;
            childBox.y2 = childBox.y1 + arrowHeight;
            this._arrows[i].allocate(childBox, flags);
        }
    },

    // We override SwitcherList's _onItemEnter method to delay
    // activation when the thumbnail list is open
    _onItemEnter(index) {
        // Avoid reentrancy
        if (index == this._highlighted)
            return;

        if (this._altTabPopup.thumbnailsVisible && this._altTabPopup.mouseActive) {
            if (this._mouseTimeOutId != 0)
                return;

            this._mouseTimeOutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, APP_ICON_HOVER_TIMEOUT,
                                                        () => {
                                                            this._enterItem(index);
                                                            this._mouseTimeOutId = 0;
                                                            return GLib.SOURCE_REMOVE;
                                                        });
            GLib.Source.set_name_by_id(this._mouseTimeOutId, '[gnome-shell] this._enterItem');
        } else {
            this._itemEntered(index);
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _enterItem(index) {
        let [x, y, mask] = global.get_pointer();
        let pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
        if (this._items[index].contains(pickedActor))
            this._itemEntered(index);
    },

    // We override SwitcherList's highlight() method to also deal with
    // the AppSwitcher->ThumbnailSwitcher arrows. Apps with only 1 window
    // will hide their arrows by default, but show them when their
    // thumbnails are visible (ie, when the app icon is supposed to be
    // in justOutline mode). Apps with multiple windows will normally
    // show a dim arrow, but show a bright arrow when they are
    // highlighted.
    highlight(n, justOutline) {
        if (this.icons[this._highlighted]) {
            if (this.icons[this._highlighted].cachedWindows.length == 1)
                this._arrows[this._highlighted].hide();
            else
                this._arrows[this._highlighted].remove_style_pseudo_class('highlighted');
        }

        this.parent(n, justOutline);

        if (this._highlighted != -1) {
            if (justOutline && this.icons[this._highlighted].cachedWindows.length == 1)
                this._arrows[this._highlighted].show();
            else
                this._arrows[this._highlighted].add_style_pseudo_class('highlighted');
        }
    },

    _onWindowAdded(window) {
        let app = this._tracker.get_window_app(window);

        let index = this.icons.findIndex(icon => icon.app == app);
        let appIcon = this.icons[index];

        let allWindows = getWindows(this._currentWorkspace);
        let appWindows = allWindows.filter(w => this._tracker.get_window_app(w) == app);
        let windowIndex = appWindows.indexOf(window);

        // We don't want to add windows not included in the list (eg. dialogs)
        if (windowIndex === -1)
            return;

        if (!appIcon) {
            appIcon = new AppIcon(app);
            appIcon.cachedWindows = appWindows;

            let runningApps = this._appSystem.get_running();
            index = runningApps.indexOf(appIcon.app);

            // Sometimes the app is not included in the running apps list
            if (index === -1)
                index = 0;

            if (appIcon.cachedWindows.length > 0)
                this._addIcon(appIcon, index);
        } else {
            window._unmanagedSignalId = window.connect('unmanaged', this._onWindowRemoved.bind(this));
            appIcon.cachedWindows.splice(windowIndex, 0, window);
        }

        // If the app has more than one windows now, show the arrow and
        // create the thumbnails if it is selected right now
        if (appIcon.cachedWindows.length > 1) {
            this._arrows[index].show();
            this._altTabPopup.onWindowAdded(index);
        }

        // Notify the ThumbnailSwitcher about the added window
        if (appIcon.onWindowAdded)
            appIcon.onWindowAdded(window, windowIndex);
    },

    _onWindowRemoved(window) {
        let index = this.icons.findIndex(icon => icon.cachedWindows.includes(window));
        let appIcon = this.icons[index];
        if (!appIcon)
            return;

        let windowIndex = appIcon.cachedWindows.indexOf(window);

        window = appIcon.cachedWindows.splice(windowIndex, 1)[0];
        window.disconnect(window._unmanagedSignalId);

        // If we have no more windows, remove the icon
        if (appIcon.cachedWindows.length == 0) {
            this._removeIcon(index);
        } else {
            // If this is the last window, remove the arrow
            if (appIcon.cachedWindows.length == 1)
                this._arrows[index].hide();

            // Notify the ThumbnailSwitcher about the removed window
            if (appIcon.onWindowRemoved)
                appIcon.onWindowRemoved(window, windowIndex);
        }
    },

    _addIcon(appIcon, index) {
        let arrow = new St.DrawingArea({ style_class: 'switcher-arrow' });
        arrow.connect('repaint', () => SwitcherPopup.drawArrow(arrow, St.Side.BOTTOM));

        if (index != undefined) {
            this.icons.splice(index, 0, appIcon);
            this._arrows.splice(index, 0, arrow);

            this._list.insert_child_at_index(arrow, (index * 2) + 1);
        } else {
            this.icons.push(appIcon);
            this._arrows.push(arrow);

            this._list.add_child(arrow);
        }

        // Add item after pushing the arrow since the allocation function needs the arrow list
        let item = this.addItem(appIcon.actor, appIcon.label, index, index * 2);

        appIcon.cachedWindows.forEach(window => {
            window._unmanagedSignalId = window.connect('unmanaged', this._onWindowRemoved.bind(this))
        });

        if (appIcon.cachedWindows.length == 1)
            arrow.hide();
        else
            item.add_accessible_state(Atk.StateType.EXPANDABLE);

        // Set icon size if the item is added later
        if (this._iconSize)
            appIcon.set_size(this._iconSize);
    },

    _removeIcon(index) {
        let arrow = this._arrows.splice(index, 1)[0];
        arrow.destroy();

        this.icons.splice(index, 1);

        this.removeItem(index);
    }
});

var ThumbnailSwitcher = new Lang.Class({
    Name: 'ThumbnailSwitcher',
    Extends: SwitcherPopup.SwitcherList,

    _init(icon) {
        this.parent(false);

        this._thumbnailBins = [];
        this._clones = [];
        this._currentIndex = -1;

        icon.onWindowAdded = this._addThumbnail.bind(this);
        icon.onWindowRemoved = this._removeThumbnail.bind(this);

        this.icon = icon;

        this.icon.cachedWindows.forEach(window => this._addThumbnail(window));
    },

    addClones(availHeight) {
        if (!this._thumbnailBins.length)
            return;

        let totalPadding = this._items[0].get_theme_node().get_horizontal_padding() + this._items[0].get_theme_node().get_vertical_padding();
        totalPadding += this.actor.get_theme_node().get_horizontal_padding() + this.actor.get_theme_node().get_vertical_padding();
        let [labelMinHeight, labelNaturalHeight] = this._lastLabel.get_preferred_height(-1);
        let spacing = this._items[0].child.get_theme_node().get_length('spacing');
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let thumbnailSize = THUMBNAIL_DEFAULT_SIZE * scaleFactor;

        availHeight = Math.min(availHeight - labelNaturalHeight - totalPadding - spacing, thumbnailSize);
        let binHeight = availHeight + this._items[0].get_theme_node().get_vertical_padding() + this.actor.get_theme_node().get_vertical_padding() - spacing;
        binHeight = Math.min(thumbnailSize, binHeight);

        // this._thumbnailBins will only include one item if this._currentIndex is set
        for (let i = 0; i < this._thumbnailBins.length; i++) {
            let mutterWindow = null;
            if (this._currentIndex >= 0)
                mutterWindow = this.icon.cachedWindows[this._currentIndex].get_compositor_private();
            else
                mutterWindow = this.icon.cachedWindows[i].get_compositor_private();

            if (!mutterWindow)
                continue;

            let clone = _createWindowClone(mutterWindow, thumbnailSize);
            this._thumbnailBins[i].set_height(binHeight);
            this._thumbnailBins[i].add_actor(clone);

            if (this._currentIndex >= 0)
                this._clones.splice(this._currentIndex, 0, clone);
            else
                this._clones.push(clone);
        }

        this._thumbnailBins = [];
    },

    _addThumbnail(window, index) {
        if (index != undefined)
            this._currentIndex = index;

        let box = new St.BoxLayout({ style_class: 'thumbnail-box',
                                     vertical: true });
        let bin = new St.Bin({ style_class: 'thumbnail' });

        box.add_actor(bin);

        // We don't splice here because this is a temporary list for
        // stuff to draw on the next allocation
        this._thumbnailBins.push(bin);

        let title = window.get_title();
        let name = null;

        if (title) {
            name = new St.Label({ text: title });
            // St.Label doesn't support text-align so use a Bin
            let bin = new St.Bin({ x_align: St.Align.MIDDLE });

            bin.add_actor(name);
            box.add_actor(bin);

            this._lastLabel = bin;
        }

        this.addItem(box, name, index);
    },

    _removeThumbnail(window, index) {
        this._clones.splice(index, 1);
        this.removeItem(index);
    },

    disconnectHandlers() {
        this._items.forEach(item => {
            item.disconnect(item._clickEventId);
            item.disconnect(item._motionEventId);
        });

        this.icon.onWindowAdded = null;
        this.icon.onWindowRemoved = null;
    }
});

var WindowIcon = new Lang.Class({
    Name: 'WindowIcon',

    _init(window, mode) {
        this.window = window;

        this.actor = new St.BoxLayout({ style_class: 'alt-tab-app',
                                        vertical: true });
        this._icon = new St.Widget({ layout_manager: new Clutter.BinLayout() });

        this.actor.add(this._icon, { x_fill: false, y_fill: false } );
        this.label = new St.Label({ text: window.get_title() });

        let tracker = Shell.WindowTracker.get_default();
        this.app = tracker.get_window_app(window);

        let mutterWindow = this.window.get_compositor_private();
        let size;

        this._icon.destroy_all_children();

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        switch (mode) {
            case AppIconMode.THUMBNAIL_ONLY:
                size = WINDOW_PREVIEW_SIZE;
                this._icon.add_actor(_createWindowClone(mutterWindow, size * scaleFactor));
                break;

            case AppIconMode.BOTH:
                size = WINDOW_PREVIEW_SIZE;
                this._icon.add_actor(_createWindowClone(mutterWindow, size * scaleFactor));

                if (this.app)
                    this._icon.add_actor(this._createAppIcon(this.app, APP_ICON_SIZE_SMALL));

                break;

            case AppIconMode.APP_ICON_ONLY:
                size = APP_ICON_SIZE;
                this._icon.add_actor(this._createAppIcon(this.app, size));
        }

        this._icon.set_size(size * scaleFactor, size * scaleFactor);
    },

    _createAppIcon(app, size) {
        let appIcon = app ? app.create_icon_texture(size)
                          : new St.Icon({ icon_name: 'icon-missing',
                                          icon_size: size });
        appIcon.x_expand = appIcon.y_expand = true;
        appIcon.x_align = appIcon.y_align = Clutter.ActorAlign.END;

        return appIcon;
    }
});

var WindowSwitcher = new Lang.Class({
    Name: 'WindowSwitcher',
    Extends: SwitcherPopup.SwitcherList,

    _init(windows, mode, workspace) {
        this.parent(true);

        this._label = new St.Label({ x_align: Clutter.ActorAlign.CENTER,
                                     y_align: Clutter.ActorAlign.CENTER });
        this.actor.add_actor(this._label);

        this.icons = [];
        this._mode = mode;
        this._currentWorkspace = workspace;

        windows.forEach(window => this._addWindow(window));

        if (this._currentWorkspace) {
            this._workspaceWindowAddedSignalId = this._currentWorkspace.connect_after('window-added', (workspace, window) => {
                // Workaround for a bug in Mutter: https://gitlab.gnome.org/GNOME/mutter/issues/157
                // When running under Wayland, the app tracker doesn't know about the app the new window
                // belongs to, because the gtk-application-id isn't set.
                // Wait until the id has been updated to be sure the tracker can resolve the window to an app.
                // We don't have to apply the other workaround here since we're waiting anyway.
                if (Meta.is_wayland_compositor()) {
                    let tmpId = window.connect_after('notify::gtk-application-id', () => {
                        // Another bug in Mutter, wait until the window is allocated so we can generate the clone.
                        let mutterWindow = window.get_compositor_private();
                        let tmpId2 = mutterWindow.connect('allocation-changed', () => {
                            this._onWindowAdded(window);
                            mutterWindow.disconnect(tmpId2);
                        });

                        window.disconnect(tmpId);
                    });
                // Workaround for a bug in Mutter: https://gitlab.gnome.org/GNOME/mutter/issues/156
                // The window-added signal for the workspace is emitted before the window actor is created,
                // wait until the window-created signal is emitted and then handle the new window.
                } else {
                    let tmpId = global.display.connect('window-created', () => {
                        this._onWindowAdded(window);
                        global.display.disconnect(tmpId);
                    });
                }
            });

            this._workspaceWindowRemovedSignalId = this._currentWorkspace.connect_after('window-removed', (workspace, window) => this._removeWindow(window));
        } else {
            this._windowCreatedSignalId = global.display.connect('window-created', (display, window) => {
                // Workaround for a bug in Mutter: https://gitlab.gnome.org/GNOME/mutter/issues/157
                // When running under Wayland, the app tracker doesn't know about the app the new window
                // belongs to, because the gtk-application-id isn't set.
                // Wait until the id has been updated to be sure the tracker can resolve the window to an app.
                if (Meta.is_wayland_compositor()) {
                    let tmpId = window.connect_after('notify::gtk-application-id', () => {
                        // Another bug in Mutter, wait until the window is allocated so we can generate the clone.
                        let mutterWindow = window.get_compositor_private();
                        let tmpId2 = mutterWindow.connect('allocation-changed', () => {
                            this._onWindowAdded(window);
                            mutterWindow.disconnect(tmpId2);
                        });

                        window.disconnect(tmpId);
                    });
                } else {
                    this._onWindowAdded(window);
                }
            });
        }

        this.actor.connect('destroy', this._onDestroy.bind(this));
    },

    _onDestroy() {
        if (this._currentWorkspace) {
            this._currentWorkspace.disconnect(this._workspaceWindowAddedSignalId);
            this._currentWorkspace.disconnect(this._workspaceWindowRemovedSignalId);
        } else {
            global.display.disconnect(this._windowCreatedSignalId);
        }

        this.icons.forEach(icon => {
            icon.window.disconnect(icon._unmanagedSignalId);
        });
    },

    _onWindowAdded(window) {
        let windows = getWindows(this._currentWorkspace);
        let index = windows.indexOf(window);
        if (index === -1)
            return;

        this._addWindow(window, index);
    },

    _getPreferredHeight(actor, forWidth, alloc) {
        this.parent(actor, forWidth, alloc);

        let spacing = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);
        let [labelMin, labelNat] = this._label.get_preferred_height(-1);
        alloc.min_size += labelMin + spacing;
        alloc.natural_size += labelNat + spacing;
    },

    _allocateTop(actor, box, flags) {
        let childBox = new Clutter.ActorBox();
        childBox.x1 = box.x1;
        childBox.x2 = box.x2;
        childBox.y2 = box.y2;
        childBox.y1 = childBox.y2 - this._label.height;
        this._label.allocate(childBox, flags);

        let spacing = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);
        box.y2 -= this._label.height + spacing;
        this.parent(actor, box, flags);
    },

    highlight(index, justOutline) {
        this.parent(index, justOutline);

        this._label.set_text(index == -1 ? '' : this.icons[index].label.text);
    },

    _addWindow(window, index) {
        let icon = new WindowIcon(window, this._mode);

        if (index != undefined)
            this.icons.splice(index, 0, icon);
        else
            this.icons.push(icon);

        this.addItem(icon.actor, icon.label, index);

        icon._unmanagedSignalId = window.connect('unmanaged', this._removeWindow.bind(this));
    },

    _removeWindow(window) {
        let index = this.icons.findIndex(icon => icon.window == window);
        if (index === -1)
            return;

        let icon = this.icons.splice(index, 1)[0];
        window.disconnect(icon._unmanagedSignalId);

        this.removeItem(index);
    }
});
