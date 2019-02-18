// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported Animation, AnimatedIcon, Spinner */

const { Clutter, Cogl, GLib, GObject, Gio, St } = imports.gi;

const Params = imports.misc.params;

var ANIMATED_ICON_UPDATE_TIMEOUT = 16;
var SPINNER_ANIMATION_TIME = 300;
var SPINNER_ANIMATION_DELAY = 1000;

var Animation = GObject.registerClass(
class Animation extends St.Bin {
    _init(file, width, height, speed) {
        const themeContext = St.ThemeContext.get_for_stage(global.stage);

        super._init({
            style: `width: ${width}px; height: ${height}px;`,
        });

        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('resource-scale-changed',
            this._loadFile.bind(this, file, width, height));

        this._scaleChangedId = themeContext.connect('notify::scale-factor',
            () => {
                this._loadFile(file, width, height);
                this.set_size(width * themeContext.scale_factor, height * themeContext.scale_factor);
            });

        this._speed = speed;

        this._isLoaded = false;
        this._isPlaying = false;
        this._timeoutId = 0;
        this._frame = 0;

        this._loadFile(file, width, height);
    }

    play() {
        if (this._isLoaded && this._timeoutId == 0) {
            if (this._frame == 0)
                this._showFrame(0);

            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, this._speed, this._update.bind(this));
            GLib.Source.set_name_by_id(this._timeoutId, '[gnome-shell] this._update');
        }

        this._isPlaying = true;
    }

    stop() {
        if (this._timeoutId > 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        this._isPlaying = false;
    }

    _loadFile(file, width, height) {
        const resourceScale = this.get_resource_scale();
        let wasPlaying = this._isPlaying;

        if (this._isPlaying)
            this.stop();

        this._isLoaded = false;
        this.destroy_all_children();

        let textureCache = St.TextureCache.get_default();
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._animations = textureCache.load_sliced_image(file, width, height,
                                                          scaleFactor, resourceScale,
                                                          this._animationsLoaded.bind(this));
        this._animations.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._animations);

        this._colorEffect = new Clutter.ColorizeEffect();
        this._animations.add_effect(this._colorEffect);

        if (wasPlaying)
            this.play();

        this._shadowHelper = null;
        this._shadowWidth = this._shadowHeight = 0;
    }

    vfunc_get_paint_volume(volume) {
        if (!super.vfunc_get_paint_volume(volume))
            return false;

        if (!this._shadow)
            return true;

        let shadow_box = new Clutter.ActorBox();
        this._shadow.get_box(this.get_allocation_box(), shadow_box);

        volume.set_width(Math.max(shadow_box.x2 - shadow_box.x1, volume.get_width()));
        volume.set_height(Math.max(shadow_box.y2 - shadow_box.y1, volume.get_height()));

        return true;
    }

    vfunc_style_changed() {
        let node = this.get_theme_node();
        this._shadow = node.get_shadow('icon-shadow');
        if (this._shadow)
            this._shadowHelper = St.ShadowHelper.new(this._shadow);
        else
            this._shadowHelper = null;

        super.vfunc_style_changed();

        if (this._animations) {
            let color = node.get_color('color');

            this._colorEffect.set_tint(color);

            // Clutter.ColorizeEffect does not affect opacity, so set it separately
            this._animations.opacity = color.alpha;
        }
    }

    vfunc_paint() {
        if (this._shadowHelper) {
            this._shadowHelper.update(this._animations);

            let allocation = this._animations.get_allocation_box();
            let paintOpacity = this._animations.get_paint_opacity();
            let framebuffer = Cogl.get_draw_framebuffer();

            this._shadowHelper.paint(framebuffer, allocation, paintOpacity);
        }

        this._animations.paint();
    }

    _showFrame(frame) {
        let oldFrameActor = this._animations.get_child_at_index(this._frame);
        if (oldFrameActor)
            oldFrameActor.hide();

        this._frame = frame % this._animations.get_n_children();

        let newFrameActor = this._animations.get_child_at_index(this._frame);
        if (newFrameActor)
            newFrameActor.show();

        this.vfunc_style_changed();
    }

    _update() {
        this._showFrame(this._frame + 1);
        return GLib.SOURCE_CONTINUE;
    }

    _syncAnimationSize() {
        if (!this._isLoaded)
            return;

        let [width, height] = this.get_size();

        for (let i = 0; i < this._animations.get_n_children(); ++i)
            this._animations.get_child_at_index(i).set_size(width, height);

        this.vfunc_style_changed();
    }

    _animationsLoaded() {
        this._isLoaded = this._animations.get_n_children() > 0;

        this._syncAnimationSize();

        if (this._isPlaying)
            this.play();
    }

    _onDestroy() {
        this.stop();

        let themeContext = St.ThemeContext.get_for_stage(global.stage);
        if (this._scaleChangedId)
            themeContext.disconnect(this._scaleChangedId);
        this._scaleChangedId = 0;
    }
});

var AnimatedIcon = GObject.registerClass(
class AnimatedIcon extends Animation {
    _init(file, size) {
        super._init(file, size, size, ANIMATED_ICON_UPDATE_TIMEOUT);
    }
});

var Spinner = GObject.registerClass(
class Spinner extends AnimatedIcon {
    _init(size, params) {
        params = Params.parse(params, {
            animate: false,
            hideOnStop: false,
        });
        let file = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/process-working.svg');
        super._init(file, size);

        this.opacity = 0;
        this._animate = params.animate;
        this._hideOnStop = params.hideOnStop;
        this.visible = !this._hideOnStop;
        this.add_style_class_name('spinner');
    }

    _onDestroy() {
        this._animate = false;
        super._onDestroy();
    }

    play() {
        this.remove_all_transitions();
        this.show();

        if (this._animate) {
            super.play();
            this.ease({
                opacity: 255,
                delay: SPINNER_ANIMATION_DELAY,
                duration: SPINNER_ANIMATION_TIME,
                mode: Clutter.AnimationMode.LINEAR,
            });
        } else {
            this.opacity = 255;
            super.play();
        }
    }

    stop() {
        this.remove_all_transitions();

        if (this._animate) {
            this.ease({
                opacity: 0,
                duration: SPINNER_ANIMATION_TIME,
                mode: Clutter.AnimationMode.LINEAR,
                onComplete: () => {
                    super.stop();
                    if (this._hideOnStop)
                        this.hide();
                },
            });
        } else {
            this.opacity = 0;
            super.stop();

            if (this._hideOnStop)
                this.hide();
        }
    }
});
