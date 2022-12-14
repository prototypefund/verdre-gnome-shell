/* exported CheckBox */
const { Clutter, GObject, Pango, St } = imports.gi;

var CheckBox = GObject.registerClass(
class CheckBox extends St.Button {
    _init(label) {
        let container = new St.BoxLayout();
        super._init({
            style_class: 'check-box',
            child: container,
            button_mask: St.ButtonMask.ONE,
            toggle_mode: true,
            can_focus: true,
            x_fill: true,
            y_fill: true
        });

        this._box = new St.Bin();
        this._box.set_y_align(Clutter.ActorAlign.START);
        container.add_actor(this._box);

        this._label = new St.Label();
        this._label.clutter_text.set_line_wrap(true);
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        container.add_actor(this._label);

        if (label)
            this.setLabel(label);
    }

    setLabel(label) {
        this._label.set_text(label);
    }

    getLabelActor() {
        return this._label;
    }
});
