// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;

const Lang = imports.lang;
const Layout = imports.ui.layout;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Tweener = imports.ui.tweener;
const Meta = imports.gi.Meta;

const HIDE_TIMEOUT = 1500;
const FADE_TIME = 0.1;
const LEVEL_ANIMATION_TIME = 0.1;

const LevelBar = new Lang.Class({
    Name: 'LevelBar',

    _init: function() {
        this._level = 0;

        this.actor = new St.Bin({ style_class: 'level',
                                  x_align: St.Align.START,
                                  y_fill: true });
        this._bar = new St.Widget({ style_class: 'level-bar' });

        this.actor.set_child(this._bar);

        this.actor.connect('notify::width', () => { this.level = this.level; });
    },

    get level() {
        return this._level;
    },

    set level(value) {
        this._level = Math.max(0, Math.min(value, 100));

        let alloc = this.actor.get_allocation_box();
        let newWidth = Math.round((alloc.x2 - alloc.x1) * this._level / 100);
        if (newWidth != this._bar.width)
            this._bar.width = newWidth;
    }
});

const OsdWindow = new Lang.Class({
    Name: 'OsdWindow',

    _init: function(monitorIndex) {
        this._popupSize = 0;
        this.actor = new St.Widget({ x_expand: true,
                                     y_expand: true,
                                     x_align: Clutter.ActorAlign.CENTER,
                                     y_align: Clutter.ActorAlign.CENTER });

        this._monitorIndex = monitorIndex;
        let constraint = new Layout.MonitorConstraint({ index: monitorIndex });
        this.actor.add_constraint(constraint);

        this._box = new St.BoxLayout({ style_class: 'osd-window',
                                       vertical: true });
        this.actor.add_actor(this._box);

        this._box.connect('style-changed', Lang.bind(this, this._onStyleChanged));
        this._box.connect('notify::height', Lang.bind(this,
            function() {
                Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this,
                    function() {
                        this._box.width = this._box.height;
                    }));
            }));

        this._icon = new St.Icon();
        this._box.add(this._icon, { expand: true });

        this._label = new St.Label();
        this._box.add(this._label);

        this._level = new LevelBar();
        this._box.add(this._level.actor);

        this._hideTimeoutId = 0;
        this._reset();

        Main.layoutManager.connect('monitors-changed',
                                   Lang.bind(this, this._monitorsChanged));
        this._monitorsChanged();
        Main.uiGroup.add_child(this.actor);
    },

    setIcon: function(icon) {
        this._icon.gicon = icon;
    },

    setLabel: function(label) {
        this._label.visible = (label != undefined);
        if (label)
            this._label.text = label;
    },

    setLevel: function(level) {
        this._level.actor.visible = (level != undefined);
        if (level != undefined) {
            if (this.actor.visible)
                Tweener.addTween(this._level,
                                 { level: level,
                                   time: LEVEL_ANIMATION_TIME,
                                   transition: 'easeOutQuad' });
            else
                this._level.level = level;
        }
    },

    show: function() {
        if (!this._icon.gicon)
            return;

        if (!this.actor.visible) {
            Meta.disable_unredirect_for_screen(global.screen);
            this.actor.show();
            this.actor.opacity = 0;
            this.actor.get_parent().set_child_above_sibling(this.actor, null);

            Tweener.addTween(this.actor,
                             { opacity: 255,
                               time: FADE_TIME,
                               transition: 'easeOutQuad' });
        }

        if (this._hideTimeoutId)
            Mainloop.source_remove(this._hideTimeoutId);
        this._hideTimeoutId = Mainloop.timeout_add(HIDE_TIMEOUT,
                                                   Lang.bind(this, this._hide));
        GLib.Source.set_name_by_id(this._hideTimeoutId, '[gnome-shell] this._hide');
    },

    cancel: function() {
        if (!this._hideTimeoutId)
            return;

        Mainloop.source_remove(this._hideTimeoutId);
        this._hide();
    },

    _hide: function() {
        this._hideTimeoutId = 0;
        Tweener.addTween(this.actor,
                         { opacity: 0,
                           time: FADE_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this, function() {
                              this._reset();
                              Meta.enable_unredirect_for_screen(global.screen);
                           })
                         });
        return GLib.SOURCE_REMOVE;
    },

    _reset: function() {
        this.actor.hide();
        this.setLabel(null);
        this.setLevel(null);
    },

    _monitorsChanged: function() {
        /* assume 110x110 on a 640x480 display and scale from there */
        let monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (!monitor)
            return; // we are about to be removed

        let scalew = monitor.width / 640.0;
        let scaleh = monitor.height / 480.0;
        let scale = Math.min(scalew, scaleh);
        this._popupSize = 110 * Math.max(1, scale);

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._icon.icon_size = this._popupSize / (2 * scaleFactor);
        this._box.translation_y = monitor.height / 4;
        this._box.style_changed();
    },

    _onStyleChanged: function() {
        let themeNode = this._box.get_theme_node();
        let horizontalPadding = themeNode.get_horizontal_padding();
        let verticalPadding = themeNode.get_vertical_padding();
        let topBorder = themeNode.get_border_width(St.Side.TOP);
        let bottomBorder = themeNode.get_border_width(St.Side.BOTTOM);
        let leftBorder = themeNode.get_border_width(St.Side.LEFT);
        let rightBorder = themeNode.get_border_width(St.Side.RIGHT);

        let minWidth = this._popupSize - verticalPadding - leftBorder - rightBorder;
        let minHeight = this._popupSize - horizontalPadding - topBorder - bottomBorder;

        // minWidth/minHeight here are in real pixels,
        // but the theme takes measures in unscaled dimensions
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._box.style = 'min-height: %dpx;'.format(Math.max(minWidth, minHeight) / scaleFactor);
    }
});

const OsdWindowManager = new Lang.Class({
    Name: 'OsdWindowManager',

    _init: function() {
        this._osdWindows = [];
        Main.layoutManager.connect('monitors-changed',
                                    Lang.bind(this, this._monitorsChanged));
        this._monitorsChanged();
    },

    _monitorsChanged: function() {
        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            if (this._osdWindows[i] == undefined)
                this._osdWindows[i] = new OsdWindow(i);
        }

        for (let i = Main.layoutManager.monitors.length; i < this._osdWindows.length; i++) {
            this._osdWindows[i].actor.destroy();
            this._osdWindows[i] = null;
        }

        this._osdWindows.length = Main.layoutManager.monitors.length;
    },

    _showOsdWindow: function(monitorIndex, icon, label, level) {
        this._osdWindows[monitorIndex].setIcon(icon);
        this._osdWindows[monitorIndex].setLabel(label);
        this._osdWindows[monitorIndex].setLevel(level);
        this._osdWindows[monitorIndex].show();
    },

    show: function(monitorIndex, icon, label, level) {
        if (monitorIndex != -1) {
            for (let i = 0; i < this._osdWindows.length; i++) {
                if (i == monitorIndex)
                    this._showOsdWindow(i, icon, label, level);
                else
                    this._osdWindows[i].cancel();
            }
        } else {
            for (let i = 0; i < this._osdWindows.length; i++)
                this._showOsdWindow(i, icon, label, level);
        }
    },

    hideAll: function() {
        for (let i = 0; i < this._osdWindows.length; i++)
            this._osdWindows[i].cancel();
    }
});
