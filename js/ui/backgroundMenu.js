// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported addBackgroundMenu */

const { Clutter, St } = imports.gi;

const BoxPointer = imports.ui.boxpointer;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

var BackgroundMenu = class BackgroundMenu extends PopupMenu.PopupMenu {
    constructor(layoutManager) {
        super(layoutManager.dummyCursor, 0, St.Side.TOP);

        this.addSettingsAction(_("Change Background…"), 'gnome-background-panel.desktop');
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.addSettingsAction(_("Display Settings"), 'gnome-display-panel.desktop');
        this.addSettingsAction(_('Settings'), 'org.gnome.Settings.desktop');

        this.actor.add_style_class_name('background-menu');

        layoutManager.uiGroup.add_actor(this.actor);
        this.actor.hide();
    }
};

function addBackgroundMenu(actor, layoutManager) {
    actor.reactive = true;
    actor._backgroundMenu = new BackgroundMenu(layoutManager);
    actor._backgroundManager = new PopupMenu.PopupMenuManager(actor);
    actor._backgroundManager.addMenu(actor._backgroundMenu);

    function openMenu(x, y) {
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        actor._backgroundMenu.open(BoxPointer.PopupAnimation.FULL);
    }

    const longPressGesture = new Clutter.LongPressGesture();
    longPressGesture.connect('long-press-begin', () => {
        if (actor._backgroundMenu.isOpen ||
            (longPressGesture.get_button() != 0 &&
             longPressGesture.get_button() != Clutter.BUTTON_PRIMARY))
            return;

        const coords = longPressGesture.get_coords();
        openMenu(coords.x, coords.y);
    });
    actor.add_action(longPressGesture);

    const clickGesture = new Clutter.ClickGesture();
    clickGesture.connect('clicked', () => {
        if (clickGesture.get_button() === Clutter.BUTTON_SECONDARY) {
            const coords = clickGesture.get_coords();
            openMenu(coords.x, coords.y);
        }
    });
    actor.add_action(clickGesture);

    actor.connect('destroy', () => {
        actor._backgroundMenu.destroy();
        actor._backgroundMenu = null;
        actor._backgroundManager = null;
    });
}
