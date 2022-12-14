// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// A widget showing the user avatar and name
/* exported UserWidget */

const { Clutter, GLib, GObject, St } = imports.gi;

const Params = imports.misc.params;

var AVATAR_ICON_SIZE = 64;

// Adapted from gdm/gui/user-switch-applet/applet.c
//
// Copyright (C) 2004-2005 James M. Cape <jcape@ignore-your.tv>.
// Copyright (C) 2008,2009 Red Hat, Inc.

var Avatar = GObject.registerClass({
    GTypeName: 'UserWidget_Avatar'
}, class Avatar extends St.Bin {
    _init(user, params) {
        let themeContext = St.ThemeContext.get_for_stage(global.stage);
        params = Params.parse(params, { reactive: false,
                                        iconSize: AVATAR_ICON_SIZE,
                                        styleClass: 'user-icon' });

        super._init({
            style_class: params.styleClass,
            reactive: params.reactive,
            width: params.iconSize * themeContext.scaleFactor,
            height: params.iconSize * themeContext.scaleFactor
        });

        this._iconSize = params.iconSize;
        this._user = user;

        this.bind_property('reactive', this, 'track-hover',
            GObject.BindingFlags.SYNC_CREATE);
        this.bind_property('reactive', this, 'can-focus',
            GObject.BindingFlags.SYNC_CREATE);

        // Monitor the scaling factor to make sure we recreate the avatar when needed.
        this._scaleFactorChangeId =
            themeContext.connect('notify::scale-factor', this.update.bind(this));

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._scaleFactorChangeId) {
            let themeContext = St.ThemeContext.get_for_stage(global.stage);
            themeContext.disconnect(this._scaleFactorChangeId);
            delete this._scaleFactorChangeId;
        }
    }

    setSensitive(sensitive) {
        this.reactive = sensitive;
    }

    update() {
        let iconFile = this._user.get_icon_file();
        if (iconFile && !GLib.file_test(iconFile, GLib.FileTest.EXISTS))
            iconFile = null;

        if (iconFile) {
            this.child = null;
            let { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            this.set_size(
                this._iconSize * scaleFactor,
                this._iconSize * scaleFactor);
            this.style = `
                background-image: url("${iconFile}");
                background-size: cover;`;
        } else {
            this.style = null;
            this.child = new St.Icon({ icon_name: 'avatar-default-symbolic',
                                       icon_size: this._iconSize });
        }
    }
});

var UserWidgetLabel = GObject.registerClass(
class UserWidgetLabel extends St.Widget {
    _init(user) {
        super._init({ layout_manager: new Clutter.BinLayout() });

        this._user = user;

        this._realNameLabel = new St.Label({ style_class: 'user-widget-label',
                                             y_align: Clutter.ActorAlign.CENTER });
        this.add_child(this._realNameLabel);

        this._userNameLabel = new St.Label({ style_class: 'user-widget-label',
                                             y_align: Clutter.ActorAlign.CENTER });
        this.add_child(this._userNameLabel);

        this._currentLabel = null;

        this._userLoadedId = this._user.connect('notify::is-loaded', this._updateUser.bind(this));
        this._userChangedId = this._user.connect('changed', this._updateUser.bind(this));
        this._updateUser();

        // We can't override the destroy vfunc because that might be called during
        // object finalization, and we can't call any JS inside a GC finalize callback,
        // so we use a signal, that will be disconnected by GObject the first time
        // the actor is destroyed (which is guaranteed to be as part of a normal
        // destroy() call from JS, possibly from some ancestor)
        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._userLoadedId != 0) {
            this._user.disconnect(this._userLoadedId);
            this._userLoadedId = 0;
        }

        if (this._userChangedId != 0) {
            this._user.disconnect(this._userChangedId);
            this._userChangedId = 0;
        }
    }

    vfunc_allocate(box, flags) {
        this.set_allocation(box, flags);

        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;

        let [, , natRealNameWidth] = this._realNameLabel.get_preferred_size();

        if (natRealNameWidth <= availWidth)
            this._currentLabel = this._realNameLabel;
        else
            this._currentLabel = this._userNameLabel;
        this.label_actor = this._currentLabel;

        let childBox = new Clutter.ActorBox();
        childBox.x1 = 0;
        childBox.y1 = 0;
        childBox.x2 = availWidth;
        childBox.y2 = availHeight;

        this._currentLabel.allocate(childBox, flags);
    }

    vfunc_paint() {
        this._currentLabel.paint();
    }

    _updateUser() {
        if (this._user.is_loaded) {
            this._realNameLabel.text = this._user.get_real_name();
            this._userNameLabel.text = this._user.get_user_name();
        } else {
            this._realNameLabel.text = '';
            this._userNameLabel.text = '';
        }
    }
});

var UserWidget = GObject.registerClass(
class UserWidget extends St.BoxLayout {
    _init(user) {
        super._init({ style_class: 'user-widget', vertical: false });

        this._user = user;

        this.connect('destroy', this._onDestroy.bind(this));

        this._avatar = new Avatar(user);
        this.add_child(this._avatar);

        this._label = new UserWidgetLabel(user);
        this.add_child(this._label);

        this._label.bind_property('label-actor', this, 'label-actor',
                                  GObject.BindingFlags.SYNC_CREATE);

        this._userLoadedId = this._user.connect('notify::is-loaded', this._updateUser.bind(this));
        this._userChangedId = this._user.connect('changed', this._updateUser.bind(this));
        this._updateUser();
    }

    _onDestroy() {
        if (this._userLoadedId != 0) {
            this._user.disconnect(this._userLoadedId);
            this._userLoadedId = 0;
        }

        if (this._userChangedId != 0) {
            this._user.disconnect(this._userChangedId);
            this._userChangedId = 0;
        }
    }

    _updateUser() {
        this._avatar.update();
    }
});
