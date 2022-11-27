// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported KeyboardManager */

const {Clutter, Gio, GLib, GObject, Graphene, IBus, Meta, Shell, St} = imports.gi;
const Signals = imports.misc.signals;

const EdgeDragAction = imports.ui.edgeDragAction;
const InputSourceManager = imports.ui.status.keyboard;
const IBusManager = imports.misc.ibusManager;
const BoxPointer = imports.ui.boxpointer;
const Main = imports.ui.main;
const PageIndicators = imports.ui.pageIndicators;
const PopupMenu = imports.ui.popupMenu;
const SwipeTracker = imports.ui.swipeTracker;

var KEYBOARD_ANIMATION_TIME = 150;
var KEYBOARD_REST_TIME = KEYBOARD_ANIMATION_TIME * 2;
var KEY_LONG_PRESS_TIME = 250;

const A11Y_APPLICATIONS_SCHEMA = 'org.gnome.desktop.a11y.applications';
const SHOW_KEYBOARD = 'screen-keyboard-enabled';
const EMOJI_PAGE_SEPARATION = 32;

/* KeyContainer puts keys in a grid where a 1:1 key takes this size */
const KEY_SIZE = 4;

const KEY_RELEASE_TIMEOUT = 50;
const BACKSPACE_WORD_DELETE_THRESHOLD = 50;

var AspectContainer = GObject.registerClass(
class AspectContainer extends St.Widget {
    _init(params) {
        super._init(params);
        this._ratio = 1;
    }

    setRatio(ratio) {
        this._ratio = ratio;
        this.queue_relayout();
    }

    vfunc_get_preferred_width(forHeight) {
        let [min, nat] = super.vfunc_get_preferred_width(forHeight);

        if (forHeight > 0)
            nat = forHeight * this._ratio;

        return [min, nat];
    }

    vfunc_get_preferred_height(forWidth) {
        let [min, nat] = super.vfunc_get_preferred_height(forWidth);

        if (forWidth > 0)
            nat = forWidth / this._ratio;

        return [min, nat];
    }

    vfunc_allocate(box) {
        if (box.get_width() > 0 && box.get_height() > 0) {
            let sizeRatio = box.get_width() / box.get_height();
            if (sizeRatio >= this._ratio) {
                /* Restrict horizontally */
                let width = box.get_height() * this._ratio;
                let diff = box.get_width() - width;

                box.x1 += Math.floor(diff / 2);
                box.x2 -= Math.ceil(diff / 2);
            }
        }

        super.vfunc_allocate(box);
    }
});

var KeyContainer = GObject.registerClass(
class KeyContainer extends St.Widget {
    _init() {
        const gridLayout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        super._init({
            layout_manager: gridLayout,
            x_expand: true,
            y_expand: true,
            reactive: true,
        //    name: 'keysContainer',
        });
        this._gridLayout = gridLayout;
        this._currentRow = 0;
        this._currentCol = 0;
        this._maxCols = 0;

        this._currentRow = null;
        this._rows = [];

        this._keyContainerGesture = new KeyContainerGesture(this._rows);
        this.add_action(this._keyContainerGesture);
    }

    appendRow() {
        this._currentRow++;
        this._currentCol = 0;

        let row = {
            keys: [],
            width: 0,
        };
        this._rows.push(row);
    }

    appendKey(key, width = 1, height = 1) {
        let keyInfo = {
            key,
            left: this._currentCol,
            top: this._currentRow,
            width,
            height,
        };

        let row = this._rows[this._rows.length - 1];
        row.keys.push(keyInfo);
        row.width += width;

        this._currentCol += width;
        this._maxCols = Math.max(this._currentCol, this._maxCols);
    }

    layoutButtons() {
        let nCol = 0, nRow = 0;

        for (let i = 0; i < this._rows.length; i++) {
            let row = this._rows[i];

            /* When starting a new row, see if we need some padding */
            if (nCol == 0) {
                let diff = this._maxCols - row.width;
                if (diff >= 1)
                    nCol = diff * 0.5;
                else
                    nCol = diff;
            }

            for (let j = 0; j < row.keys.length; j++) {
                let keyInfo = row.keys[j];

                if (i === 0)
                    keyInfo.key.add_style_class_name('topmost-row');
                else if (i === this._rows.length - 1)
                    keyInfo.key.add_style_class_name('bottommost-row');
                if (j === 0)
                    keyInfo.key.add_style_class_name('leftmost-column');
                else if (j === row.keys.length - 1)
                    keyInfo.key.add_style_class_name('rightmost-column');

                const layoutCol = nCol * KEY_SIZE;
                const layoutRow = nRow * KEY_SIZE;
                const layoutWidth = keyInfo.width * KEY_SIZE;
                const layoutHeight = keyInfo.height * KEY_SIZE;

                this._gridLayout.attach(keyInfo.key, layoutCol, layoutRow, layoutWidth, layoutHeight);
                this._keyContainerGesture.addKey(keyInfo.key, layoutCol, layoutRow, layoutWidth, layoutHeight);
                nCol += keyInfo.width;
            }

            nRow += 1;
            nCol = 0;
        }
    }

    getSize() {
        return [this._maxCols, this._rows.length];
    }
});

var Suggestions = GObject.registerClass(
class Suggestions extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'word-suggestions',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.show();
    }

    add(word, callback) {
        let button = new St.Button({ label: word });
        button.connect('button-press-event', () => {
            callback();
            return Clutter.EVENT_STOP;
        });
        button.connect('touch-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;

            callback();
            return Clutter.EVENT_STOP;
        });
        this.add_child(button);
    }

    clear() {
        this.remove_all_children();
    }

    setVisible(visible) {
        for (const child of this)
            child.visible = visible;
    }
});

var LanguageSelectionPopup = class extends PopupMenu.PopupMenu {
    constructor(actor) {
        super(actor, 0.5, St.Side.BOTTOM);

        let inputSourceManager = InputSourceManager.getInputSourceManager();
        let inputSources = inputSourceManager.inputSources;

        let item;
        for (let i in inputSources) {
            let is = inputSources[i];

            item = this.addAction(is.displayName, () => {
                inputSourceManager.activateInputSource(is, true);
            });
            item.can_focus = false;
            item.setOrnament(is === inputSourceManager.currentSource
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        item = this.addSettingsAction(_("Region & Language Settings"), 'gnome-region-panel.desktop');
        item.can_focus = false;

        actor.connectObject('notify::mapped', () => {
            if (!actor.is_mapped())
                this.close(true);
        }, this);
    }

    _onCapturedEvent(actor, event) {
        const targetActor = global.stage.get_event_actor(event);

        if (targetActor === this.actor ||
            this.actor.contains(targetActor))
            return Clutter.EVENT_PROPAGATE;

        if (event.type() == Clutter.EventType.BUTTON_RELEASE || event.type() == Clutter.EventType.TOUCH_END)
            this.close(true);

        return Clutter.EVENT_STOP;
    }

    open(animate) {
        super.open(animate);
        global.stage.connectObject(
            'captured-event', this._onCapturedEvent.bind(this), this);
    }

    close(animate) {
        super.close(animate);
        global.stage.disconnectObject(this);
    }

    destroy() {
        global.stage.disconnectObject(this);
        this.sourceActor.disconnectObject(this);
        super.destroy();
    }
};

var LongPressAndDragGesture = GObject.registerClass({
    Signals: {
        'drag-moved': { param_types: [Clutter.Actor.$gtype] },
    },
}, class LongPressAndDragGesture extends Clutter.LongPressGesture {
    _init(params = {}) {
        params.cancel_threshold = -1;

        super._init(params);
    }

    vfunc_crossing_event(point, type, time, flags, sourceActor, relatedActor) {
        if (type === Clutter.EventType.ENTER)
            this.emit('drag-moved', sourceActor);
    }

    vfunc_state_changed(oldState, newState) {
        super.vfunc_state_changed(oldState, newState);

        if (newState === Clutter.GestureState.RECOGNIZING) {
            this.emit('drag-moved',
                global.stage.get_event_actor(this.get_points()[0].latest_event));
        }
    }
});

var KeyClickGesture = GObject.registerClass({
    Signals: {
        'press': {},
        'release': {},
        'cancel': {},
    },
}, class KeyClickGesture extends Clutter.ClickGesture {
    _init(params = {}) {
        params.cancel_threshold = -1;

        super._init(params);

        this.connect('notify::pressed', () => {
            if (!this.pressed && this.state === Clutter.GestureState.RECOGNIZING)
                this.set_state(Clutter.GestureState.CANCELLED);
        });
    }

    vfunc_points_began(points) {
        super.vfunc_points_began(points);

        if (this.state === Clutter.GestureState.POSSIBLE)
            this.set_state(Clutter.GestureState.RECOGNIZING);
    }

    vfunc_state_changed(oldState, newState) {
        if (newState === Clutter.GestureState.RECOGNIZING)
            this.emit('press');

        if (newState === Clutter.GestureState.COMPLETED)
            this.emit('release');

        if (oldState === Clutter.GestureState.RECOGNIZING &&
            newState === Clutter.GestureState.CANCELLED)
            this.emit('cancel');

        super.vfunc_state_changed(oldState, newState);
    }

    vfunc_should_influence(otherGesture, cancel, inhibit) {
        if (otherGesture instanceof Clutter.LongPressGesture)
            return [false, false];

        if (otherGesture instanceof Clutter.PanGesture)
            return [false, false];

        return [cancel, inhibit];
    }

    vfunc_other_gesture_may_start(otherGesture, shouldStart) {
        if (otherGesture instanceof KeyClickGesture) {
            log("found another key click gest should " + shouldStart);
            this.set_state(Clutter.GestureState.COMPLETED);
            return true;
        }

        return shouldStart;
    }
});

var KeyContainerGesture = GObject.registerClass({
    Signals: {
    },
}, class KeyContainerGesture extends Clutter.Gesture {
    _init(rows) {
        super._init();

        this.set_wait_points_removed(false);

        this._rows = [];
        this._height = 0;
        this._width = 0;

        this._pressedKey = null;
        this._currentPoint = null;
        this._inLongPressDrag = false;
        this._keyLongPressTimeout = 0;
    }

    _findNearestRowOrCol(array, index) {
        let prevIndex = null;
        for (let i = Math.floor(index); i >= 0; i--) {
            if (array[i]) {
                prevIndex = i;
                break;
            }
        }

        let nextIndex = null;
        for (let i = Math.ceil(index); i < array.length; i++) {
            if (array[i]) {
                nextIndex = i;
                break;
            }
        }

        if (prevIndex !== null) {
            if (prevIndex + array[prevIndex].size >= index)
                return array[prevIndex];// direct hit

            if (nextIndex !== null) {
                const distanceToPrev = index - prevIndex;
                const distanceToNext = nextIndex - index;

                if (distanceToNext < distanceToPrev)
                    return array[nextIndex];
                else
                    return array[prevIndex];
            }

            return array[prevIndex];
        }

        if (nextIndex !== null)
            return array[nextIndex];

        return null;
    }

    vfunc_points_began(points) {
        const point = points[0];

        const [success, x, y] =
            this.actor.transform_stage_point(point.begin_coords.x, point.begin_coords.y);
        if (!success) {
            this.set_state(Clutter.GestureState.CANCELLED);
            return;
        }

        const rowHeight = this.actor.height / this._height;
        const rowIndex = y / rowHeight;
        const row = this._findNearestRowOrCol(this._rows, rowIndex);
        if (!row) {
            this.set_state(Clutter.GestureState.CANCELLED);
            return;
        }

        const colWidth = this.actor.width / this._width;
        const colIndex = x / colWidth;
        const col = this._findNearestRowOrCol(row.cols, colIndex);
        if (!col) {
            this.set_state(Clutter.GestureState.CANCELLED);
            return;
        }

        // If a key is already pressed down by another finger, release it
        if (this._pressedKey) {
            this._pressedKey.release();

            if (this._keyLongPressTimeout) {
                GLib.source_remove(this._keyLongPressTimeout);
                this._keyLongPressTimeout = 0;
            }

            this._pressedKey = null;
            this._currentPoint = null;
            this._inLongPressDrag = false;
        }

        this._currentPoint = point.index;
        this._pressedKey = col.key;
        this._pressedKey.press();

        this._keyLongPressTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEY_LONG_PRESS_TIME, () => {
            this._inLongPressDrag = this._pressedKey.longPressBegin();
            if (this._inLongPressDrag) {
                this.set_state(Clutter.GestureState.RECOGNIZING);

                const points = this.get_points();
                if (points[0])
                    this._pressedKey.longPressMoved(global.stage.get_event_actor(points[0].latest_event));
            }

            this._keyLongPressTimeout = 0;
            return GLib.SOURCE_REMOVE;
        });

    }

  //  vfunc_crossing_event(point, type, time, flags, sourceActor, relatedActor) {
    vfunc_points_moved(points) {
        const point = points[0];
        if (point.index !== this._currentPoint)
            return;

        if (!this._pressedKey) {
            throw new Error('no pressed key on points moved');
        }

        if (this._inLongPressDrag)
            return;

        const [success, x, y] =
            this.actor.transform_stage_point(point.latest_coords.x, point.latest_coords.y);
        if (!success)
            return;

        const rowHeight = this.actor.height / this._height;
        const rowIndex = y / rowHeight;
        const row = this._findNearestRowOrCol(this._rows, rowIndex);
        if (row) {
            const colWidth = this.actor.width / this._width;
            const colIndex = x / colWidth;
            const col = this._findNearestRowOrCol(row.cols, colIndex);
            if (col) {
                if (this._pressedKey === col.key)
                    return;
            }
        }

        this.set_state(Clutter.GestureState.CANCELLED);
    }

    vfunc_points_ended(points) {
        const point = points[0];

        if (point.index !== this._currentPoint)
            return;

        if (!this._pressedKey)
            throw new Error('POINT no pressed key on points ended');

        this.set_state(Clutter.GestureState.COMPLETED);
    }

    vfunc_points_cancelled(points) {
        this.set_state(Clutter.GestureState.CANCELLED);
    }

    vfunc_crossing_event(point, type, time, flags, sourceActor, relatedActor) {
        if (point.index !== this._currentPoint)
            return;

        if (type === Clutter.EventType.ENTER && this._inLongPressDrag)
            this._pressedKey.longPressMoved(sourceActor);
    }

    vfunc_state_changed(oldState, newState) {
        if (newState === Clutter.GestureState.CANCELLED)
            this._pressedKey.cancel();

        if (newState === Clutter.GestureState.COMPLETED)
            this._pressedKey.release();

        if (newState === Clutter.GestureState.COMPLETED ||
            newState === Clutter.GestureState.CANCELLED) {
            if (this._keyLongPressTimeout) {
                GLib.source_remove(this._keyLongPressTimeout);
                this._keyLongPressTimeout = 0;
            }

            this._pressedKey = null;
            this._currentPoint = null;
            this._inLongPressDrag = false;
        }
    }

    vfunc_should_be_influenced_by(otherGesture, cancel, inhibit) {
        // doesn't make sense to ever inhibit this one
        return [cancel, false];
    }

    addKey(key, colIndex, rowIndex, width, height) {
        if (!this._rows[rowIndex])
            this._rows[rowIndex] = { size: height, cols: [] };

        const row = this._rows[rowIndex];

        row.cols[colIndex] = { size: width, key };

        if (this._height < rowIndex + height)
            this._height = rowIndex + height;

        if (this._width < colIndex + width)
            this._width = colIndex + width;
    }
});

var Key = GObject.registerClass({
    Signals: {
        'long-press': {},
        'pressed': {},
        'released': {},
        'cancelled': {},
        'commit': {param_types: [GObject.TYPE_UINT, GObject.TYPE_STRING]},
    },
}, class Key extends St.Button {
    _init(params, extendedKeys = []) {
        const {label, iconName, commitString, keyval, useInternalClickGesture} =
            {keyval: 0, useInternalClickGesture: true, ...params};

        super._init({ style_class: 'key-container' });

        this._keyBin = this._makeKey(commitString, label, iconName);

        /* Add the key in a container, so keys can be padded without losing
         * logical proportions between those.
         */
        this.set_child(this._keyBin);
        this.connect('destroy', this._onDestroy.bind(this));

        this._extendedKeys = extendedKeys;
        this._extendedKeyboard = null;

        this._commitString = commitString;
        this._keyval = keyval;

        if (useInternalClickGesture)
            this.connect('clicked', () => this.release());
        else
            this.get_click_gesture().enabled = false;
    }

    press() {
        this.add_style_pseudo_class('active');
        this.emit('pressed');
    }

    release() {
        this.remove_style_pseudo_class('active');

        if (this.checked) {
            if (this._currentExtendedKeyButton) {
                const extendedKey = this._currentExtendedKeyButton.extendedKey;
                this.emit('commit', this._getKeyvalFromString(extendedKey), extendedKey || '');

                this._currentExtendedKeyButton.remove_style_pseudo_class('active');
                delete this._currentExtendedKeyButton;
                this._hideSubkeys();
            }

            return;
        }

        let finalKeyval = parseInt(this._keyval, 16);
        if (!finalKeyval && this._commitString)
            finalKeyval = this._getKeyvalFromString(this._commitString);
        console.assert(finalKeyval !== undefined, 'Need keyval or commitString');

        this.emit('commit', finalKeyval, this._commitString || '');
        this.emit('released');
    }

    cancel() {
        this.remove_style_pseudo_class('active');
        this.emit('cancelled');
    }

    longPressBegin() {
        this.emit('long-press');

        if (this._extendedKeys.length > 0) {
            this._ensureExtendedKeysPopup();
            this._showSubkeys();
            return true;
        }

        return false;
    }

    longPressMoved(newActor) {
        this._currentExtendedKeyButton?.remove_style_pseudo_class('active');

        this._currentExtendedKeyButton =
            this._extendedKeyboard?.contains(newActor) ? newActor : null;

        this._currentExtendedKeyButton?.add_style_pseudo_class('active');
    }

    get iconName() {
        return this._icon.icon_name;
    }

    set iconName(value) {
        this._icon.icon_name = value;
    }

    _onDestroy() {
        if (this._boxPointer) {
            this._boxPointer.destroy();
            this._boxPointer = null;
        }
    }

    _ensureExtendedKeysPopup() {
        if (this._extendedKeys.length === 0)
            return;

        if (this._boxPointer)
            return;

        this._boxPointer = new BoxPointer.BoxPointer(St.Side.BOTTOM);
this._boxPointer.y_align = Clutter.ActorAlign.START;
        this._boxPointer.hide();
        Main.layoutManager.keyboardBox.add_child(this._boxPointer);
        this._boxPointer.setPosition(this._keyBin, 0.5);

        // Adds style to existing keyboard style to avoid repetition
        this._boxPointer.add_style_class_name('keyboard-subkeys');
        this._getExtendedKeys();
    }

    _getKeyvalFromString(string) {
        let unicode = string?.length ? string.charCodeAt(0) : undefined;
        return Clutter.unicode_to_keysym(unicode);
    }

    _showSubkeys() {
        this._boxPointer.open(BoxPointer.PopupAnimation.FULL);
        this.connectObject('notify::mapped', () => {
            if (!this.is_mapped())
                this._hideSubkeys();
        }, this);

        this.checked = true;

        this._coverActor = new Clutter.Actor({ reactive: true });
        this._coverActor.add_constraint(new Clutter.BindConstraint({
            source: Main.uiGroup,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        const hideSubkeysGesture = new KeyClickGesture({
            name: 'OSK subkeys hide gesture',
        });
        hideSubkeysGesture.connect('press', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE,
                () => { this._hideSubkeys(); return GLib.SOURCE_REMOVE; });
        });
        this._coverActor.add_action(hideSubkeysGesture);

        Main.layoutManager.keyboardBox.add_child(this._coverActor);
        Main.layoutManager.keyboardBox.set_child_below_sibling(this._coverActor, this._boxPointer);
    }

    _hideSubkeys() {
        if (this._boxPointer)
            this._boxPointer.close(BoxPointer.PopupAnimation.FULL);
        this.disconnectObject(this);

        this.checked = false;

        this._coverActor.destroy();
    }

    _makeKey(commitString, label, icon) {
        const button = new St.Bin({
            style_class: 'visible-key',
            x_expand: true,
        });

        if (icon) {
            const child = new St.Icon({icon_name: icon});
            button.set_child(child);
            this._icon = child;
        } else if (label) {
            const labelActor = new St.Label({
                text: GLib.markup_escape_text(label, -1) || '',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            labelActor.clutter_text.use_markup = true;
            button.set_child(labelActor);
        } else if (commitString) {
            const labelActor = new St.Label({
                text: GLib.markup_escape_text(commitString, -1) || '',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            labelActor.clutter_text.use_markup = true;
            button.set_child(labelActor);
        }

        return button;
    }

    _getExtendedKeys() {
        this._extendedKeyboard = new St.BoxLayout({
            style_class: 'extended-keys',
            vertical: false,
        });
        for (let i = 0; i < this._extendedKeys.length; ++i) {
            let extendedKey = this._extendedKeys[i];
            const button = new St.Button({ style_class: 'key-container' });
            button._keyBin = this._makeKey(extendedKey);
            button.set_child(button._keyBin);

            button.connect('clicked', () => {
                this.emit('commit', this._getKeyvalFromString(extendedKey), extendedKey || '');

                this._hideSubkeys();
            });

            button.extendedKey = extendedKey;
            this._extendedKeyboard.add(button);

            button._keyBin.set_size(...this._keyBin.allocation.get_size());
            this._keyBin.connect('notify::allocation',
                () => button._keyBin.set_size(...this._keyBin.allocation.get_size()));
        }
        this._boxPointer.bin.add_actor(this._extendedKeyboard);
    }

    get subkeys() {
        return this._boxPointer;
    }

    setLatched(latched) {
        if (latched)
            this.add_style_pseudo_class('latched');
        else
            this.remove_style_pseudo_class('latched');
    }
});

var KeyboardModel = class {
    constructor(groupName) {
        let names = [groupName];
        if (groupName.includes('+'))
            names.push(groupName.replace(/\+.*/, ''));
        names.push('us');

        for (let i = 0; i < names.length; i++) {
            try {
                this._model = this._loadModel(names[i]);
                break;
            } catch (e) {
            }
        }
    }

    _loadModel(groupName) {
        const file = Gio.File.new_for_uri(
            `resource:///org/gnome/shell/osk-layouts/${groupName}.json`);
        let [success_, contents] = file.load_contents(null);

        const decoder = new TextDecoder();
        return JSON.parse(decoder.decode(contents));
    }

    getLevels() {
        return this._model.levels;
    }

    getKeysForLevel(levelName) {
        return this._model.levels.find(level => level == levelName);
    }
};

var FocusTracker = class extends Signals.EventEmitter {
    constructor() {
        super();

        this._rect = null;

        global.display.connectObject(
            'notify::focus-window', () => {
                this._setCurrentWindow(global.display.focus_window);
                this.emit('window-changed', this._currentWindow);
            },
            'grab-op-begin', (display, window, op) => {
                if (window === this._currentWindow &&
                    (op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING))
                    this.emit('window-grabbed');
            }, this);

        this._setCurrentWindow(global.display.focus_window);

        /* Valid for wayland clients */
        Main.inputMethod.connectObject('cursor-location-changed',
            (o, rect) => this._setCurrentRect(rect), this);

        this._ibusManager = IBusManager.getIBusManager();
        this._ibusManager.connectObject(
            'set-cursor-location', (manager, rect) => {
                /* Valid for X11 clients only */
                if (Main.inputMethod.currentFocus)
                    return;

                const grapheneRect = new Graphene.Rect();
                grapheneRect.init(rect.x, rect.y, rect.width, rect.height);

                this._setCurrentRect(grapheneRect);
            },
            'focus-in', () => this.emit('focus-changed', true),
            'focus-out', () => this.emit('focus-changed', false),
            this);
    }

    destroy() {
        this._currentWindow?.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.inputMethod.disconnectObject(this);
        this._ibusManager.disconnectObject(this);
    }

    get currentWindow() {
        return this._currentWindow;
    }

    _setCurrentWindow(window) {
        this._currentWindow?.disconnectObject(this);
log("KEYBOARD: setting cur window to " + window);
        this._currentWindow = window;

        if (this._currentWindow) {
            this._currentWindow.connectObject(
                'position-changed', () => this.emit('window-moved'), this);
        }
    }

    _setCurrentRect(rect) {
        // Some clients give us 0-sized rects, in that case set size to 1
        if (rect.size.width <= 0)
            rect.size.width = 1;
        if (rect.size.height <= 0)
            rect.size.height = 1;

        if (this._currentWindow) {
            const frameRect = this._currentWindow.get_frame_rect();
            const grapheneFrameRect = new Graphene.Rect();
            grapheneFrameRect.init(frameRect.x, frameRect.y,
                frameRect.width, frameRect.height);

            const rectInsideFrameRect = grapheneFrameRect.intersection(rect)[0];
            if (!rectInsideFrameRect) {
log("KEYBOARD: rect not equal to fr rect");
                return;
}


        }
//IM could have been disabled in the mean time
    //    if (this._rect && this._rect.equal(rect)) {
//log("KEYBOARD: rect equal to old one");
  //          return;
//}

log("KEYBORAD: emitting position ccahnged");
        this._rect = rect;
        this.emit('position-changed');

    }

    getCurrentRect() {
        const rect = {
            x: this._rect.origin.x,
            y: this._rect.origin.y,
            width: this._rect.size.width,
            height: this._rect.size.height,
        };

        return rect;
    }
};

var EmojiPager = GObject.registerClass({
    Properties: {
        'delta': GObject.ParamSpec.int(
            'delta', 'delta', 'delta',
            GObject.ParamFlags.READWRITE,
            GLib.MININT32, GLib.MAXINT32, 0),
    },
    Signals: {
        'emoji': { param_types: [GObject.TYPE_STRING] },
        'page-changed': {
            param_types: [GObject.TYPE_STRING, GObject.TYPE_INT, GObject.TYPE_INT],
        },
    },
}, class EmojiPager extends St.Widget {
    _init(sections) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            clip_to_allocation: true,
            y_expand: true,
        });
        this._sections = sections;

        this._pages = [];
        this._panel = null;
        this._curPage = null;
        this._followingPage = null;
        this._followingPanel = null;
        this._delta = 0;
        this._width = null;

        const swipeTracker = new SwipeTracker.SwipeTracker(
            Clutter.Orientation.HORIZONTAL,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            {allowDrag: true, allowScroll: true});
        swipeTracker.connect('begin', this._onSwipeBegin.bind(this));
        swipeTracker.connect('update', this._onSwipeUpdate.bind(this));
        swipeTracker.connect('end', this._onSwipeEnd.bind(this));
        this._swipeTracker = swipeTracker;

        this.add_action(swipeTracker);
    }

    get delta() {
        return this._delta;
    }

    set delta(value) {
        if (this._delta == value)
            return;

        this._delta = value;
        this.notify('delta');

        let followingPage = this.getFollowingPage();

        if (this._followingPage != followingPage) {
            if (this._followingPanel) {
                this._followingPanel.destroy();
                this._followingPanel = null;
            }

            if (followingPage != null) {
                this._followingPanel = this._generatePanel(followingPage);
                this.add_child(this._followingPanel);
            }

            this._followingPage = followingPage;
        }

        const multiplier = this.text_direction === Clutter.TextDirection.RTL
            ? -1 : 1;

        this._panel.translation_x = value * multiplier;
        if (this._followingPanel) {
            const translation = value < 0
                ? this._width + EMOJI_PAGE_SEPARATION
                : -this._width - EMOJI_PAGE_SEPARATION;

            this._followingPanel.translation_x =
                (value * multiplier) + (translation * multiplier);
        }
    }

    _prevPage(nPage) {
        return (nPage + this._pages.length - 1) % this._pages.length;
    }

    _nextPage(nPage) {
        return (nPage + 1) % this._pages.length;
    }

    getFollowingPage() {
        if (this.delta == 0)
            return null;

        if (this.delta < 0)
            return this._nextPage(this._curPage);
        else
            return this._prevPage(this._curPage);
    }

    _onSwipeUpdate(tracker, progress) {
        this.delta = -progress * this._width;
    }

    _onSwipeBegin(tracker) {
        this.remove_transition('delta');

        this._width = this.width;
        const points = [-1, 0, 1];
        tracker.confirmSwipe(this._width, points, 0, 0);
    }

    _onSwipeEnd(tracker, duration, endProgress, endCb) {
        this.remove_all_transitions();
        if (endProgress === 0) {
            this.ease_property('delta', 0, {
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                duration,
                onStopped: () => endCb(),
            });
        } else {
            const value = endProgress < 0
                ? this._width + EMOJI_PAGE_SEPARATION
                : -this._width - EMOJI_PAGE_SEPARATION;
            this.ease_property('delta', value, {
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                duration,
                onStopped: () => {
                    this.setCurrentPage(this.getFollowingPage());
                    endCb();
                },
            });
        }
    }

    _initPagingInfo() {
        this._pages = [];

        for (let i = 0; i < this._sections.length; i++) {
            let section = this._sections[i];
            let itemsPerPage = this._nCols * this._nRows;
            let nPages = Math.ceil(section.keys.length / itemsPerPage);
            let page = -1;
            let pageKeys;

            for (let j = 0; j < section.keys.length; j++) {
                if (j % itemsPerPage == 0) {
                    page++;
                    pageKeys = [];
                    this._pages.push({ pageKeys, nPages, page, section: this._sections[i] });
                }

                pageKeys.push(section.keys[j]);
            }
        }
    }

    _lookupSection(section, nPage) {
        for (let i = 0; i < this._pages.length; i++) {
            let page = this._pages[i];

            if (page.section == section && page.page == nPage)
                return i;
        }

        return -1;
    }

    _generatePanel(nPage) {
        const gridLayout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        const panel = new St.Widget({
            layout_manager: gridLayout,
            style_class: 'emoji-page',
            x_expand: true,
            y_expand: true,
        });

        /* Set an expander actor so all proportions are right despite the panel
         * not having all rows/cols filled in.
         */
        let expander = new Clutter.Actor();
        gridLayout.attach(expander, 0, 0, this._nCols * KEY_SIZE, this._nRows * KEY_SIZE);

        let page = this._pages[nPage];
        let col = 0;
        let row = 0;

        for (let i = 0; i < page.pageKeys.length; i++) {
            let modelKey = page.pageKeys[i];
            let key = new Key({commitString: modelKey.label}, modelKey.variants);
            key.add_style_class_name('emoji');

            key.connect('commit', (actor, keyval, str) => {
                this.emit('emoji', str);
            });

            gridLayout.attach(key, col, row, KEY_SIZE, KEY_SIZE);

            col += KEY_SIZE;
            if (col >= this._nCols * KEY_SIZE) {
                col = 0;
                row += KEY_SIZE;
            }
        }

        return panel;
    }

    setCurrentPage(nPage) {
        if (this._curPage == nPage)
            return;

        this._curPage = nPage;

        if (this._panel) {
            this._panel.destroy();
            this._panel = null;
        }

        /* Reuse followingPage if possible */
        if (nPage == this._followingPage) {
            this._panel = this._followingPanel;
            this._followingPanel = null;
        }

        if (this._followingPanel)
            this._followingPanel.destroy();

        this._followingPanel = null;
        this._followingPage = null;
        this._delta = 0;

        if (!this._panel) {
            this._panel = this._generatePanel(nPage);
            this.add_child(this._panel);
        }

        let page = this._pages[nPage];
        this.emit('page-changed', page.section.first, page.page, page.nPages);
    }

    setCurrentSection(section, nPage) {
        for (let i = 0; i < this._pages.length; i++) {
            let page = this._pages[i];

            if (page.section == section && page.page == nPage) {
                this.setCurrentPage(i);
                break;
            }
        }
    }

    setSize(nCols, nRows) {
        this._nCols = Math.floor(nCols);
        this._nRows = Math.floor(nRows);
        this._initPagingInfo();
    }
});

var EmojiSelection = GObject.registerClass({
    Signals: {
        'emoji-selected': { param_types: [GObject.TYPE_STRING] },
        'close-request': {},
        'toggle': {},
        'keyval': { param_types: [GObject.TYPE_UINT] },
    },
}, class EmojiSelection extends St.Widget {
    _init() {
        const gridLayout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        super._init({
            layout_manager: gridLayout,
            style_class: 'emoji-panel',
            x_expand: true,
            y_expand: true,
            text_direction: global.stage.text_direction,
        });

        this._sections = [
            { first: 'grinning face', iconName: 'emoji-people-symbolic' },
            { first: 'monkey face', iconName: 'emoji-nature-symbolic' },
            { first: 'grapes', iconName: 'emoji-food-symbolic' },
            { first: 'globe showing Europe-Africa', iconName: 'emoji-travel-symbolic' },
            { first: 'jack-o-lantern', iconName: 'emoji-activities-symbolic' },
            { first: 'muted speaker', iconName: 'emoji-objects-symbolic' },
            { first: 'ATM sign', iconName: 'emoji-symbols-symbolic' },
        ];

        this._gridLayout = gridLayout;
        this._populateSections();

        this._pagerBox = new Clutter.Actor({
            layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
            }),
        });

        this._emojiPager = new EmojiPager(this._sections);
        this._emojiPager.connect('page-changed', (pager, sectionLabel, page, nPages) => {
            this._onPageChanged(sectionLabel, page, nPages);
        });
        this._emojiPager.connect('emoji', (pager, str) => {
            this.emit('emoji-selected', str);
        });
        this._pagerBox.add_child(this._emojiPager);

        this._pageIndicator = new PageIndicators.PageIndicators(
            Clutter.Orientation.HORIZONTAL);
        this._pageIndicator.y_expand = false;
        this._pageIndicator.y_align = Clutter.ActorAlign.START;
        this._pagerBox.add_child(this._pageIndicator);
        this._pageIndicator.setReactive(false);

        this._emojiPager.connect('notify::delta', () => {
            this._updateIndicatorPosition();
        });

        this._bottomRow = this._createBottomRow();

        this._curPage = 0;
    }

    vfunc_map() {
        this._emojiPager.setCurrentPage(0);
        super.vfunc_map();
    }

    _onPageChanged(sectionFirst, page, nPages) {
        this._curPage = page;
        this._pageIndicator.setNPages(nPages);
        this._updateIndicatorPosition();

        for (let i = 0; i < this._sections.length; i++) {
            let sect = this._sections[i];
            sect.button.setLatched(sectionFirst === sect.first);
        }
    }

    _updateIndicatorPosition() {
        this._pageIndicator.setCurrentPosition(this._curPage -
            this._emojiPager.delta / this._emojiPager.width);
    }

    _findSection(emoji) {
        for (let i = 0; i < this._sections.length; i++) {
            if (this._sections[i].first == emoji)
                return this._sections[i];
        }

        return null;
    }

    _populateSections() {
        let file = Gio.File.new_for_uri('resource:///org/gnome/shell/osk-layouts/emoji.json');
        let [success_, contents] = file.load_contents(null);

        let emoji = JSON.parse(new TextDecoder().decode(contents));

        let variants = [];
        let currentKey = 0;
        let currentSection = null;

        for (let i = 0; i < emoji.length; i++) {
            /* Group variants of a same emoji so they appear on the key popover */
            if (emoji[i].name.startsWith(emoji[currentKey].name)) {
                variants.push(emoji[i].char);
                if (i < emoji.length - 1)
                    continue;
            }

            let newSection = this._findSection(emoji[currentKey].name);
            if (newSection != null) {
                currentSection = newSection;
                currentSection.keys = [];
            }

            /* Create the key */
            let label = emoji[currentKey].char + String.fromCharCode(0xFE0F);
            currentSection.keys.push({ label, variants });
            currentKey = i;
            variants = [];
        }
    }

    _createBottomRow() {
        let row = new KeyContainer();
        let key;

        row.appendRow();

        key = new Key({
            label: 'ABC',
            useInternalClickGesture: false,
        }, []);
        key.add_style_class_name('default-key');
        key.add_style_class_name('bottom-row-key');
        key.connect('released', () => this.emit('toggle'));
        row.appendKey(key, 1.5);

        for (let i = 0; i < this._sections.length; i++) {
            let section = this._sections[i];

            const pageKey = new Key({
                iconName: section.iconName,
                useInternalClickGesture: false,
            }, []);
            pageKey.add_style_class_name('bottom-row-key');
            pageKey.connect('released', () => {
                this._emojiPager.setCurrentSection(section, 0)
            });
            row.appendKey(pageKey, 1);

            section.button = pageKey;
        }

        key = new Key({
            iconName: 'edit-clear-symbolic',
            useInternalClickGesture: false,
        }, []);
        key.add_style_class_name('default-key');
        key.add_style_class_name('bottom-row-key');
        key.connect('released', () => {
            this.emit('keyval', Clutter.KEY_BackSpace);
        });
        row.appendKey(key, 1.5);

    /*    key = new Key({iconName: 'go-down-symbolic'});
        key.add_style_class_name('default-key');
        key.add_style_class_name('hide-key');
        key.connect('released', () => {
            this.emit('close-request');
        });
        row.appendKey(key);*/
        row.layoutButtons();

      /*  const actor = new AspectContainer({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        actor.add_child(row);
*/
        return row;
    }

    setSize(nCols, nRows) {
        const bottomRowHeight = 1;
        const pagerHeight = nRows - bottomRowHeight;

        this._gridLayout.attach(this._pagerBox, 0, 0, 1, pagerHeight * KEY_SIZE);
        this._gridLayout.attach(this._bottomRow, 0, pagerHeight * KEY_SIZE, 1, bottomRowHeight * KEY_SIZE);
    }

    setNEmojis(nCols, nRows) {
        this._emojiPager.setSize(nCols, nRows);
    }
});

var Keypad = GObject.registerClass({
    Signals: {
        'keyval': { param_types: [GObject.TYPE_UINT] },
    },
}, class Keypad extends AspectContainer {
    _init() {
        let keys = [
            { label: '1', keyval: Clutter.KEY_1, left: 0, top: 0 },
            { label: '2', keyval: Clutter.KEY_2, left: 1, top: 0 },
            { label: '3', keyval: Clutter.KEY_3, left: 2, top: 0 },
            { label: '4', keyval: Clutter.KEY_4, left: 0, top: 1 },
            { label: '5', keyval: Clutter.KEY_5, left: 1, top: 1 },
            { label: '6', keyval: Clutter.KEY_6, left: 2, top: 1 },
            { label: '7', keyval: Clutter.KEY_7, left: 0, top: 2 },
            { label: '8', keyval: Clutter.KEY_8, left: 1, top: 2 },
            { label: '9', keyval: Clutter.KEY_9, left: 2, top: 2 },
            { label: '0', keyval: Clutter.KEY_0, left: 1, top: 3 },
            { keyval: Clutter.KEY_BackSpace, icon: 'edit-clear-symbolic', left: 3, top: 0 },
            { keyval: Clutter.KEY_Return, extraClassName: 'enter-key', icon: 'keyboard-enter-symbolic', left: 3, top: 1, height: 2 },
        ];

        super._init({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        const gridLayout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        this._box = new St.Widget({ layout_manager: gridLayout, x_expand: true, y_expand: true });
        this.add_child(this._box);

        for (let i = 0; i < keys.length; i++) {
            let cur = keys[i];
            let key = new Key({
                label: cur.label,
                iconName: cur.icon,
            });

            if (keys[i].extraClassName)
                key.add_style_class_name(cur.extraClassName);

            let w, h;
            w = cur.width || 1;
            h = cur.height || 1;
            gridLayout.attach(key, cur.left, cur.top, w, h);

            key.connect('released', () => {
                this.emit('keyval', cur.keyval);
            });
        }
    }
});

var KeyboardManager = class extends Signals.EventEmitter {
    constructor() {
        super();

        this._keyboard = null;
        this._a11yApplicationsSettings = new Gio.Settings({ schema_id: A11Y_APPLICATIONS_SCHEMA });
        this._a11yApplicationsSettings.connect('changed', this._syncEnabled.bind(this));

        this._seat = Clutter.get_default_backend().get_default_seat();
        this._seat.connect('notify::touch-mode', this._syncEnabled.bind(this));

        this._lastDevice = null;
        global.backend.connect('last-device-changed', (backend, device) => {
            if (device.device_type === Clutter.InputDeviceType.KEYBOARD_DEVICE)
                return;

            this._lastDevice = device;
            this._syncEnabled();
        });

        const mode = Shell.ActionMode.ALL & ~Shell.ActionMode.LOCK_SCREEN;
    /*    const bottomDragAction = new EdgeDragAction.EdgeDragAction(St.Side.BOTTOM, mode);
        bottomDragAction.connect('activated', () => {
            if (this._keyboard)
                this._keyboard.gestureActivate(Main.layoutManager.bottomIndex);
        });
        bottomDragAction.connect('progress', (_action, progress) => {
            if (this._keyboard)
                this._keyboard.gestureProgress(progress);
        });
        bottomDragAction.connect('cancelled', () => {
            if (this._keyboard)
                this._keyboard.gestureCancel();
        });
        global.stage.add_action_full('osk', Clutter.EventPhase.CAPTURE, bottomDragAction);
        this._bottomDragAction = bottomDragAction;
*/
        this._syncEnabled();
    }

    _lastDeviceIsTouchscreen() {
        if (!this._lastDevice)
            return false;

        let deviceType = this._lastDevice.get_device_type();
        return deviceType == Clutter.InputDeviceType.TOUCHSCREEN_DEVICE;
    }

    _syncEnabled() {
        let enableKeyboard = this._a11yApplicationsSettings.get_boolean(SHOW_KEYBOARD);
        let autoEnabled = this._seat.get_touch_mode() && this._lastDeviceIsTouchscreen();
        let enabled = enableKeyboard || autoEnabled;

        if (!enabled && !this._keyboard)
            return;

        if (enabled && !this._keyboard) {
            this._keyboard = new Keyboard();
            this._keyboard.connect('visibility-changed', () => {
                this.emit('visibility-changed');
      //          this._bottomDragAction.enabled = !this._keyboard.visible;
            });
        } else if (!enabled && this._keyboard) {
            this._keyboard.setCursorLocation(null);
            this._keyboard.destroy();
            this._keyboard = null;
       //     this._bottomDragAction.enabled = true;
        }
    }

    get keyboardActor() {
        return this._keyboard;
    }

    get visible() {
        return this._keyboard && this._keyboard.visible;
    }

    open(monitor) {
        Main.layoutManager.keyboardIndex = monitor;

        if (this._keyboard)
            this._keyboard.open();
    }

    close() {
        if (this._keyboard)
            this._keyboard.close();
    }

    addSuggestion(text, callback) {
        if (this._keyboard)
            this._keyboard.addSuggestion(text, callback);
    }

    resetSuggestions() {
        if (this._keyboard)
            this._keyboard.resetSuggestions();
    }

    setSuggestionsVisible(visible) {
        this._keyboard?.setSuggestionsVisible(visible);
    }

    maybeHandleEvent(event) {
        if (!this._keyboard)
            return false;

        const actor = global.stage.get_event_actor(event);

        if (Main.layoutManager.keyboardBox.contains(actor) ||
            !!actor._extendedKeys || !!actor.extendedKey) {
            actor.event(event, true);
            actor.event(event, false);
            return true;
        }

        return false;
    }
};

var Keyboard = GObject.registerClass({
    Signals: {
        'visibility-changed': {},
    },
}, class Keyboard extends St.BoxLayout {
    _init() {
        super._init({
            name: 'keyboard',
            reactive: true,
            // Keyboard models are defined in LTR, we must override
            // the locale setting in order to avoid flipping the
            // keyboard on RTL locales.
            text_direction: Clutter.TextDirection.LTR,
            vertical: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
        });

        this._focusInExtendedKeys = false;
        this._emojiActive = false;

        this._languagePopup = null;
        this._focusWindow = null;
        this._focusWindowStartY = null;

        this._latched = false; // current level is latched
        this._modifiers = new Set();
        this._modifierKeys = new Map();

        this._suggestions = null;
        this._emojiKeyVisible = Meta.is_wayland_compositor();

        this._focusTracker = new FocusTracker();
        this._focusTracker.connectObject(
            'position-changed', this._onFocusChanged.bind(this),
            'window-changed', this._onFocusChanged.bind(this),
            'window-grabbed', this._onFocusWindowMoving.bind(this), this);

        this._windowMovedId = this._focusTracker.connect('window-moved',
            this._onFocusWindowMoving.bind(this));

        // Valid only for X11
        if (!Meta.is_wayland_compositor()) {
            this._focusTracker.connectObject('focus-changed', (_tracker, focused) => {
                if (focused)
                    this.open(Main.layoutManager.focusIndex);
                else
                    this.close();
            }, this);
        }

        this._showIdleId = 0;

        this._keyboardVisible = false;
        this._keyboardRequested = false;
        this._keyboardRestingId = 0;

        Main.layoutManager.connectObject('monitors-changed',
            this._relayout.bind(this), this);

        this._setupKeyboard();

        this.opacity = 0;
        this.translation_y = this.get_preferred_height(-1)[1];
        this._keyboardHeightNotifyId = this.connect('notify::allocation', () => {
            if (this.mapped)
                return;

            this.translation_y = this.height;
        });

        Main.overview.connect('showing', () => {
            this.close(true);
        });

        this._panGesture = new Clutter.PanGesture({
            pan_axis: Clutter.PanAxis.Y,
            max_n_points: 1,
            begin_threshold: 25,
        });
        this._panGesture.connect('may-recognize', this._panMayRecognize.bind(this));
        this._panGesture.connect('pan-begin', this._panBegin.bind(this));
        this._panGesture.connect('pan-update', this._panUpdate.bind(this));
        this._panGesture.connect('pan-end', this._panEnd.bind(this));
        this._panGesture.enabled = false;
        Main.uiGroup.add_action(this._panGesture); // don't add to stage so that Metagesture tracker doesn't complain

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _panMayRecognize(gesture) {
        const points = gesture.get_points();
        if (!points[0])
            return true;

        if (!this.get_transformed_extents().contains_point(points[0].latest_coords))
            return true;

        const delta = points[0].latest_coords.y - points[0].begin_coords.y;

        return delta > 0;
    }

    _panBegin(gesture, x, y) {
        this.remove_transition('translation-y');

        const windowActor = this._focusWindow?.get_compositor_private();
        windowActor?.remove_transition('y');

        this._keyboardBeginY = this.get_transformed_extents().origin.y;
        this._panCurY = y;
    }

    _panUpdate(gesture, deltaX, deltaY, pannedDistance) {
        if (this._panCurY < this._keyboardBeginY) {
            this._panCurY += deltaY;
            return;
        }
        this._panCurY += deltaY;

        let newTranslation = this.translation_y + deltaY;
        if (newTranslation < 0)
            newTranslation = 0;

        this.translation_y = newTranslation;

        const bottomPanelHeight = this._bottomPanelBox ? this._bottomPanelBox.height : 0;

        const panHeight = this.get_transformed_extents().size.height;

        const windowActor = this._focusWindow?.get_compositor_private();

        // subtract the bottom panel here because we don't want the window to include the panel
        if (windowActor)
            windowActor.y = this._focusWindowStartY - (panHeight - bottomPanelHeight - newTranslation);
    }

    _panEnd(gesture, velocityX, velocityY) {
        const bottomPanelHeight = this._bottomPanelBox ? this._bottomPanelBox.height : 0;
        const panHeight = this.get_transformed_extents().size.height;

        const remainingHeight = panHeight - this.translation_y;

        const windowActor = this._focusWindow?.get_compositor_private();

        if (this._panCurY >= this._keyboardBeginY && (velocityY > 0.9 || (remainingHeight < panHeight / 2 && velocityY >= 0))) {
            this.ease({
                translation_y: panHeight,
                duration: Math.clamp(remainingHeight / Math.abs(velocityY), 160, 450),
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
                onStopped: () => this.close(),
            });

            if (windowActor) {
                windowActor.ease({
                    y: this._focusWindowStartY,
                    duration: KEYBOARD_ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        windowActor.y = this._focusWindowStartY;
                        this._windowSlideAnimationComplete(this._focusWindow, this._focusWindowStartY);
                    },
                });
            }
        } else {
            this.ease({
                translation_y: 0,
                duration: Math.clamp((panHeight - remainingHeight) / Math.abs(velocityY), 100, 250),
                mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });

            if (windowActor) {
                windowActor.ease({
                    // subtract the bottom panel here because we don't want the window to include the panel
                    y: this._focusWindowStartY - (panHeight - bottomPanelHeight),
                    duration: KEYBOARD_ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        windowActor.y = this._focusWindowStartY - (panHeight - bottomPanelHeight);
                     //   this._windowSlideAnimationComplete(window, finalY);
                    },
                });
            }
        }
    }

    get visible() {
        return this._keyboardVisible && super.visible;
    }

    set visible(visible) {
        super.visible = visible;
    }

    _onFocusChanged(focusTracker) {
        let rect = focusTracker.getCurrentRect();
        this.setCursorLocation(focusTracker.currentWindow, rect.x, rect.y, rect.width, rect.height);
    }

    _onDestroy() {
        if (this._windowMovedId) {
            this._focusTracker.disconnect(this._windowMovedId);
            delete this._windowMovedId;
        }

        if (this._focusTracker) {
            this._focusTracker.destroy();
            delete this._focusTracker;
        }

        this._clearShowIdle();

        this._keyboardController.destroy();

        Main.layoutManager.untrackChrome(this);
        Main.layoutManager.keyboardBox.remove_actor(this);
        Main.layoutManager.keyboardBox.hide();

        if (this._languagePopup) {
            this._languagePopup.destroy();
            this._languagePopup = null;
        }

        IBusManager.getIBusManager().setCompletionEnabled(false, () => Main.inputMethod.update());

        if (this._keyboardHeightNotifyId) {
            Main.layoutManager.keyboardBox.disconnect(this._keyboardHeightNotifyId);
            this._keyboardHeightNotifyId = 0;
        }
    }

    _setupKeyboard() {
        Main.layoutManager.keyboardBox.add_actor(this);
        Main.layoutManager.trackChrome(this);

        this.y_align = Clutter.ActorAlign.END;

        this._keyboardController = new KeyboardController();

        this._groups = {};
        this._currentPage = null;

        this._suggestions = new Suggestions();
        this.add_child(this._suggestions);

        this._aspectContainer = new AspectContainer({
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
        });
        this.add_child(this._aspectContainer);

        this._emojiSelection = new EmojiSelection();
        this._emojiSelection.connect('toggle', this._toggleEmoji.bind(this));
        this._emojiSelection.connect('close-request', () => this.close());
        this._emojiSelection.connect('emoji-selected', (selection, emoji) => {
            this._keyboardController.commitString(emoji);
        });
        this._emojiSelection.connectObject('keyval', (_emojiSelection, keyval) => {
            this._keyboardController.keyvalPress(keyval);
            this._keyboardController.keyvalRelease(keyval);
        }, this);

        this._emojiSelection.hide();
        this._aspectContainer.add_child(this._emojiSelection);

        this._keypad = new Keypad();
        this._keypad.connectObject('keyval', (_keypad, keyval) => {
            this._keyboardController.keyvalPress(keyval);
            this._keyboardController.keyvalRelease(keyval);
        }, this);
        this._aspectContainer.add_child(this._keypad);
        this._keypad.hide();
        this._keypadVisible = false;

        this._ensureKeysForGroup(this._keyboardController.getCurrentGroup());
        this._setActiveLayer(0);

        Main.inputMethod.connectObject(
            'terminal-mode-changed', this._onTerminalModeChanged.bind(this),
            this);

        this._keyboardController.connectObject(
            'active-group', this._onGroupChanged.bind(this),
            'groups-changed', this._onKeyboardGroupsChanged.bind(this),
            'panel-state', this._onKeyboardStateChanged.bind(this),
            'keypad-visible', this._onKeypadVisible.bind(this),
            this);
        global.stage.connectObject('notify::key-focus',
            this._onKeyFocusChanged.bind(this), this);

        if (Meta.is_wayland_compositor()) {
            this._keyboardController.connectObject('emoji-visible',
                this._onEmojiKeyVisible.bind(this), this);
        }

        if (Main.layoutManager.bottomPanelBox.height > 0) {
            this._bottomPanelBox = new St.Bin({
                name: 'bottomPanelBox',
                reactive: true,
                pivot_point: new Graphene.Point({ x: 0, y: 1 }),
            });

            this._bottomPanelBox.add_style_class_name('dark-mode-enabled');

            this._bottomPanelBox.child = new St.Widget({
                name: 'bottomPanelLine',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            });

            this.add_child(this._bottomPanelBox);
        }

        this._relayout();
    }

    _onKeyFocusChanged() {
        let focus = global.stage.key_focus;

        // Showing an extended key popup and clicking a key from the extended keys
        // will grab focus, but ignore that
        let extendedKeysWereFocused = this._focusInExtendedKeys;
        this._focusInExtendedKeys = focus && (focus._extendedKeys || focus.extendedKey);
        if (this._focusInExtendedKeys || extendedKeysWereFocused)
            return;

        if (!(focus instanceof Clutter.Text)) {
            this.close();
            return;
        }

        if (!this._showIdleId) {
            this._showIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this.open(Main.layoutManager.focusIndex);
                this._showIdleId = 0;
                return GLib.SOURCE_REMOVE;
            });
            GLib.Source.set_name_by_id(this._showIdleId, '[gnome-shell] this.open');
        }
    }

    _createLayersForGroup(groupName) {
        let keyboardModel = new KeyboardModel(groupName);
        let layers = {};
        let levels = keyboardModel.getLevels();
        for (let i = 0; i < levels.length; i++) {
            let currentLevel = levels[i];
            /* There are keyboard maps which consist of 3 levels (no uppercase,
             * basically). We however make things consistent by skipping that
             * second level.
             */
            let level = i >= 1 && levels.length == 3 ? i + 1 : i;

            let layout = new KeyContainer();
            layout.shiftKeys = [];

            this._loadRows(currentLevel, level, levels.length, layout);
            layers[level] = layout;
            this._aspectContainer.add_child(layout);
            layout.layoutButtons();

            layout.hide();
        }

        return layers;
    }

    _ensureKeysForGroup(group) {
        if (!this._groups[group])
            this._groups[group] = this._createLayersForGroup(group);
    }

    _addRowKeys(keys, layout) {
        for (let i = 0; i < keys.length; ++i) {
            const key = keys[i];
            const {strings} = key;
            const commitString = strings?.shift();
            let width = 1;

            let button = new Key({
                commitString,
                label: key.label,
                iconName: key.iconName,
                keyval: key.keyval,
                useInternalClickGesture: false,
            }, strings);

            if (key.width !== null)
                width = key.width;

            if (key.action !== 'modifier') {
                button.connect('commit', (_actor, keyval, str) => {
                    this._commitAction(keyval, str);
                });
            }

            if (key.action !== null) {
                button.connect('released', () => {
                    if (key.action === 'hide') {
                        this.close();
                    } else if (key.action === 'languageMenu') {
                        this._popupLanguageMenu(button);
                    } else if (key.action === 'emoji') {
                        this._toggleEmoji();
                    } else if (key.action === 'modifier') {
                        this._toggleModifier(key.keyval);
                    } else if (key.action === 'delete') {
                        this._toggleDelete(true);
                        this._toggleDelete(false);
                    } else if (key.action === 'levelSwitch') {
                        this._layer1 = key.level === 1;
                        this._setActiveLayer(key.level);
                        this._setLatched(
                            key.level === 1 &&
                                key.iconName === 'keyboard-caps-lock-symbolic');
                    }
                });

                button.connect('cancelled', () => {
                    if (key.action === 'delete') {
                        this._toggleDelete(false);
                    }
                });
            }

            if (key.action === 'levelSwitch' &&
                key.iconName === 'keyboard-shift-symbolic') {
                layout.shiftKeys.push(button);
                if (key.level === 1) {
                    button.connect('long-press', () => {
                        this._setActiveLayer(key.level);
                        this._setLatched(true);
                    });
                }
            }

            if (key.action === 'delete') {
                button.connect('long-press',
                    () => this._toggleDelete(true));
            }

            if (key.action === 'modifier') {
                let modifierKeys = this._modifierKeys[key.keyval] || [];
                modifierKeys.push(button);
                this._modifierKeys[key.keyval] = modifierKeys;
            }

            if (key.action || key.keyval)
                button.add_style_class_name('default-key');

            if (key.action)
                button.add_style_class_name('action-' + key.action);

            layout.appendKey(button, width);
        }
    }

    async _commitAction(keyval, str) {
        if (this._modifiers.size === 0 && str !== '' &&
            keyval && this._oskCompletionEnabled) {
            if (await Main.inputMethod.handleVirtualKey(keyval))
                return;
        }

        if (str === '' || !Main.inputMethod.currentFocus ||
            (keyval && this._oskCompletionEnabled) ||
            this._modifiers.size > 0 ||
            !this._keyboardController.commitString(str, true)) {
            if (keyval !== 0) {
                this._forwardModifiers(this._modifiers, Clutter.EventType.KEY_PRESS);
                this._keyboardController.keyvalPress(keyval);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEY_RELEASE_TIMEOUT, () => {
                    this._keyboardController.keyvalRelease(keyval);
                    this._forwardModifiers(this._modifiers, Clutter.EventType.KEY_RELEASE);
                    this._disableAllModifiers();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        if (!this._latched && this._layer1) {
            this._setActiveLayer(0);
            delete this._layer1;
        }
    }

    _previousWordPosition(text, cursor) {
        /* Skip word prior to cursor */
        let pos = Math.max(0, text.slice(0, cursor).search(/\s+\S+\s*$/));
        if (pos < 0)
            return 0;

        /* Skip contiguous spaces */
        for (; pos >= 0; pos--) {
            if (text.charAt(pos) !== ' ')
                return GLib.utf8_strlen(text.slice(0, pos + 1), -1);
        }

        return 0;
    }

    _toggleDelete(enabled) {
        if (this._deleteEnabled === enabled)
            return;

        this._deleteEnabled = enabled;
        this._timesDeleted = 0;

        if (true || !Main.inputMethod.currentFocus ||
            Main.inputMethod.hasPreedit() ||
            Main.inputMethod.terminalMode) {
            /* If there is no IM focus or are in the middle of preedit,
             * fallback to keypresses */
            if (enabled)
                this._keyboardController.keyvalPress(Clutter.KEY_BackSpace);
            else
                this._keyboardController.keyvalRelease(Clutter.KEY_BackSpace);
            return;
        }

        if (enabled) {
            let func = (text, cursor) => {
                if (cursor === 0)
                    return;

                let encoder = new TextEncoder();
                let decoder = new TextDecoder();

                /* Find cursor/anchor position in characters */
                const cursorIdx = GLib.utf8_strlen(decoder.decode(encoder.encode(
                    text).slice(0, cursor)), -1);
                const anchorIdx = this._timesDeleted < BACKSPACE_WORD_DELETE_THRESHOLD
                    ? cursorIdx - 1
                    : this._previousWordPosition(text, cursor);
                /* Now get offset from cursor */
                const offset = anchorIdx - cursorIdx;

                this._timesDeleted++;
                Main.inputMethod.delete_surrounding(offset, Math.abs(offset));
            };

            this._surroundingUpdateId = Main.inputMethod.connect(
                'surrounding-text-set', () => {
                    let [text, cursor] = Main.inputMethod.getSurroundingText();
                    if (this._timesDeleted === 0) {
                        func(text, cursor);
                    } else {
                        if (this._surroundingUpdateTimeoutId > 0) {
                            GLib.source_remove(this._surroundingUpdateTimeoutId);
                            this._surroundingUpdateTimeoutId = 0;
                        }
                        this._surroundingUpdateTimeoutId =
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEY_RELEASE_TIMEOUT, () => {
                                func(text, cursor);
                                this._surroundingUpdateTimeoutId = 0;
                                return GLib.SOURCE_REMOVE;
                            });
                    }
                });

            let [text, cursor] = Main.inputMethod.getSurroundingText();
            if (text)
                func(text, cursor);
            else
                Main.inputMethod.request_surrounding();
        } else {
            if (this._surroundingUpdateId > 0) {
                Main.inputMethod.disconnect(this._surroundingUpdateId);
                this._surroundingUpdateId = 0;
            }
            if (this._surroundingUpdateTimeoutId > 0) {
                GLib.source_remove(this._surroundingUpdateTimeoutId);
                this._surroundingUpdateTimeoutId = 0;
            }
        }
    }

    _setLatched(latched) {
        this._latched = latched;
        this._setCurrentLevelLatched(this._currentPage, this._latched);
    }

    _setModifierEnabled(keyval, enabled) {
        if (enabled)
            this._modifiers.add(keyval);
        else
            this._modifiers.delete(keyval);

        for (const key of this._modifierKeys[keyval])
            key.setLatched(enabled);
    }

    _toggleModifier(keyval) {
        const isActive = this._modifiers.has(keyval);
        this._setModifierEnabled(keyval, !isActive);
    }

    _forwardModifiers(modifiers, type) {
        for (const keyval of modifiers) {
            if (type === Clutter.EventType.KEY_PRESS)
                this._keyboardController.keyvalPress(keyval);
            else if (type === Clutter.EventType.KEY_RELEASE)
                this._keyboardController.keyvalRelease(keyval);
        }
    }

    _disableAllModifiers() {
        for (const keyval of this._modifiers)
            this._setModifierEnabled(keyval, false);
    }

    _popupLanguageMenu(keyActor) {
        if (this._languagePopup)
            this._languagePopup.destroy();

        this._languagePopup = new LanguageSelectionPopup(keyActor);
        Main.layoutManager.addTopChrome(this._languagePopup.actor);
        this._languagePopup.open(true);
    }

    _updateCurrentPageVisible() {
        if (this._currentPage)
            this._currentPage.visible = !this._emojiActive && !this._keypadVisible;
    }

    _setEmojiActive(active) {
        this._emojiActive = active;
        this._emojiSelection.visible = this._emojiActive;
        this._updateCurrentPageVisible();
    }

    _toggleEmoji() {
        this._setEmojiActive(!this._emojiActive);
    }

    _setCurrentLevelLatched(layout, latched) {
        for (let i = 0; i < layout.shiftKeys.length; i++) {
            let key = layout.shiftKeys[i];
            key.setLatched(latched);
            key.iconName = latched
                ? 'keyboard-caps-lock-symbolic' : 'keyboard-shift-symbolic';
        }
    }

    _loadRows(model, level, numLevels, layout) {
        let rows = model.rows;
        for (let i = 0; i < rows.length; ++i) {
            layout.appendRow();
            this._addRowKeys(rows[i], layout);
        }
    }

    _getGridSlots() {
        let numOfHorizSlots = 0, numOfVertSlots;
        let rows = this._currentPage.get_children();
        numOfVertSlots = rows.length;

        for (let i = 0; i < rows.length; ++i) {
            let keyboardRow = rows[i];
            let keys = keyboardRow.get_children();

            numOfHorizSlots = Math.max(numOfHorizSlots, keys.length);
        }

        return [numOfHorizSlots, numOfVertSlots];
    }
/*
    vfunc_get_preferred_height(forWidth) {
        let monitor = Main.layoutManager.keyboardMonitor;
        const maxHeight = Main.layoutManager.isPhone
            ? monitor.height * 0.55 : monitor.height / 3;

        const [minH, natH] = super.vfunc_get_preferred_height(forWidth);

        return [minH, natH];
    }
*/
    vfunc_allocate(box) {
        const monitor = Main.layoutManager.keyboardMonitor;

        if (monitor) {
            const maxHeight = Main.layoutManager.isPhone
                ? monitor.height * 0.55 : monitor.height / 3;

            if (box.get_height() > maxHeight)
                box.y1 = box.y2 - maxHeight;
        }

        super.vfunc_allocate(box);
    }

    _relayout() {
        let monitor = Main.layoutManager.keyboardMonitor;

        if (!monitor)
            return;
    }

    _updateKeys() {
        this._ensureKeysForGroup(this._keyboardController.getCurrentGroup());
        this._setActiveLayer(0);
    }

    _onGroupChanged() {
        this._updateKeys();
    }

    _onTerminalModeChanged() {
        this._updateKeys();
    }

    _onKeyboardGroupsChanged() {
        let nonGroupActors = [this._emojiSelection, this._keypad];
        this._aspectContainer.get_children().filter(c => !nonGroupActors.includes(c)).forEach(c => {
            c.destroy();
        });

        this._groups = {};
        this._onGroupChanged();
    }

    _onKeypadVisible(controller, visible) {
        if (visible == this._keypadVisible)
            return;

        this._keypadVisible = visible;
        this._keypad.visible = this._keypadVisible;
        this._updateCurrentPageVisible();
    }

    _onEmojiKeyVisible(controller, visible) {
        if (visible == this._emojiKeyVisible)
            return;

        this._emojiKeyVisible = visible;
        /* Rebuild keyboard widgetry to include emoji button */
        this._onKeyboardGroupsChanged();
    }

    _onKeyboardStateChanged(controller, state) {
        let enabled;
        if (state == Clutter.InputPanelState.OFF)
            enabled = false;
        else if (state == Clutter.InputPanelState.ON)
            enabled = true;
        else if (state == Clutter.InputPanelState.TOGGLE)
            enabled = this._keyboardVisible == false;
        else
            return;

        if (enabled)
            this.open(Main.layoutManager.focusIndex);
        else
            this.close();
    }

    _setActiveLayer(activeLevel) {
        let activeGroupName = this._keyboardController.getCurrentGroup();
        let layers = this._groups[activeGroupName];
        let currentPage = layers[activeLevel];

        if (this._currentPage == currentPage) {
            this._updateCurrentPageVisible();
            return;
        }

        if (this._currentPage != null) {
            this._setCurrentLevelLatched(this._currentPage, false);
            this._currentPage.disconnect(this._currentPage._destroyID);
            this._currentPage.hide();
            delete this._currentPage._destroyID;
        }

      //  this._disableAllModifiers();
        this._currentPage = currentPage;
        this._currentPage._destroyID = this._currentPage.connect('destroy', () => {
            this._currentPage = null;
        });
        this._updateCurrentPageVisible();

        let [nCols, nRows] = this._currentPage.getSize();

        this._emojiSelection.setSize(nCols, nRows);


        const monitor = Main.layoutManager.keyboardMonitor;
       // on phones we make keys taller than wide
        if (monitor && Main.layoutManager.isPhone) {
            if (monitor.width > monitor.height)
                nCols *= 1.5;
            else
                nRows *= 1.5;
        }

        this._aspectContainer.setRatio(nCols / nRows);

        const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
        const emojiSize = 34 * scaleFactor;
        const emojiPageHeight = this._suggestions.visible ? this.height * 0.5 : this.height * 0.7;
        this._emojiSelection.setNEmojis(Math.floor(nCols), Math.floor(emojiPageHeight / emojiSize));
    }

    _clearKeyboardRestTimer() {
        if (!this._keyboardRestingId)
            return;
        GLib.source_remove(this._keyboardRestingId);
        this._keyboardRestingId = 0;
    }

    open(immediate = false) {
        this._clearShowIdle();
        this._keyboardRequested = true;

        if (this._keyboardVisible) {
            this._relayout();
            return;
        }

        this._oskCompletionEnabled =
            IBusManager.getIBusManager().setCompletionEnabled(true, () => Main.inputMethod.update());
        this._clearKeyboardRestTimer();

        if (immediate) {
            this._open();
            return;
        }

        this._keyboardRestingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            KEYBOARD_REST_TIME,
            () => {
                this._clearKeyboardRestTimer();
                this._open();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(this._keyboardRestingId, '[gnome-shell] this._clearKeyboardRestTimer');
    }

    _open() {
        if (!this._keyboardRequested)
            return;

        if (this._bottomPanelBox) {
            this._bottomPanelBox.child.visible =
                !Main.overview.visible && Main.sessionMode.hasBottomPanel;
        }

        this._relayout();
        this._animateShow();

        this._setEmojiActive(false);
        this._setActiveLayer(0);

        this._panGesture.enabled = true;
    }

    close(immediate = false) {
        this._clearShowIdle();
        this._keyboardRequested = false;

        if (!this._keyboardVisible)
            return;

        IBusManager.getIBusManager().setCompletionEnabled(false, () => Main.inputMethod.update());
        this._oskCompletionEnabled = false;
        this._clearKeyboardRestTimer();

        if (immediate) {
            this._close();
            return;
        }

        this._keyboardRestingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            KEYBOARD_REST_TIME,
            () => {
                this._clearKeyboardRestTimer();
                this._close();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(this._keyboardRestingId, '[gnome-shell] this._clearKeyboardRestTimer');
    }

    _close() {
        if (this._keyboardRequested)
            return;

        this._animateHide();
        this.setCursorLocation(null);
        this._disableAllModifiers();

        this._panGesture.enabled = false;
    }

    _animateShow() {
        if (this._focusWindow)
            this._animateWindow(this._focusWindow, true);

        Main.layoutManager.keyboardBox.show();
        this.ease({
            translation_y: 0,
            opacity: 255,
            duration: KEYBOARD_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._animateShowComplete();
            },
        });
        this._keyboardVisible = true;
        this.emit('visibility-changed');
    }

    _animateShowComplete() {
        let keyboardBox = Main.layoutManager.keyboardBox;

        // Toggle visibility so the keyboardBox can update its chrome region.
        if (!Meta.is_wayland_compositor()) {
            keyboardBox.hide();
            keyboardBox.show();
        }
    }

    _animateHide() {
        if (this._focusWindow)
            this._animateWindow(this._focusWindow, false);

        this.ease({
            translation_y: this.height,
            opacity: 0,
            duration: KEYBOARD_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._animateHideComplete();
            },
        });

        this._keyboardVisible = false;
        this.emit('visibility-changed');
    }

    _animateHideComplete() {
        Main.layoutManager.keyboardBox.hide();
    }

    gestureProgress(delta) {
        this._gestureInProgress = true;
        Main.layoutManager.keyboardBox.show();
        let progress = Math.min(delta, this.height) / this.height;
        this.translation_y = this.height * (1 - progress);
        this.opacity = 255 * progress;
        const windowActor = this._focusWindow?.get_compositor_private();
        if (windowActor)
            windowActor.y = this._focusWindowStartY - (this.height * progress);
    }

    gestureActivate() {
        this.open(true);
        this._gestureInProgress = false;
    }

    gestureCancel() {
        if (this._gestureInProgress)
            this._animateHide();
        this._gestureInProgress = false;
    }

    resetSuggestions() {
        if (this._suggestions)
            this._suggestions.clear();
    }

    setSuggestionsVisible(visible) {
        this._suggestions.visible = visible;
        this._suggestions?.setVisible(visible);
    }

    addSuggestion(text, callback) {
        if (!this._suggestions)
            return;
        this._suggestions.add(text, callback);
        this._suggestions.show();
    }

    _clearShowIdle() {
        if (!this._showIdleId)
            return;
        GLib.source_remove(this._showIdleId);
        this._showIdleId = 0;
    }

    _windowSlideAnimationComplete(window, finalY) {
        // Synchronize window positions again.
        const frameRect = window.get_frame_rect();
        const bufferRect = window.get_buffer_rect();

        finalY += frameRect.y - bufferRect.y;

        frameRect.y = finalY;

        this._focusTracker.disconnect(this._windowMovedId);
        window.move_frame(true, frameRect.x, frameRect.y);
        this._windowMovedId = this._focusTracker.connect('window-moved',
            this._onFocusWindowMoving.bind(this));
    }

    _animateWindow(window, show) {
        let windowActor = window.get_compositor_private();
        if (!windowActor)
            return;

        const bottomPanelHeight = this._bottomPanelBox ? this._bottomPanelBox.height : 0;

        const finalY = show
            ? this._focusWindowStartY - (this.get_transformed_extents().size.height - bottomPanelHeight)
            : this._focusWindowStartY;

        windowActor.ease({
            y: finalY,
            duration: KEYBOARD_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                windowActor.y = finalY;
                this._windowSlideAnimationComplete(window, finalY);
            },
        });
    }

    _onFocusWindowMoving() {
        if (this._focusTracker.currentWindow === this._focusWindow) {
            // Don't use _setFocusWindow() here because that would move the
            // window while the user has grabbed it. Instead we simply "let go"
            // of the window.
            this._focusWindow = null;
            this._focusWindowStartY = null;
        }

        this.close(true);
    }

    _setFocusWindow(window) {
        if (this._focusWindow === window)
            return;

        if (this._keyboardVisible && this._focusWindow)
            this._animateWindow(this._focusWindow, false);

        const windowActor = window?.get_compositor_private();
        windowActor?.remove_transition('y');
        this._focusWindowStartY = windowActor ? windowActor.y : null;

        if (this._keyboardVisible && window)
            this._animateWindow(window, true);

        this._focusWindow = window;
    }

    setCursorLocation(window, x, y, w, h) {
        let monitor = Main.layoutManager.keyboardMonitor;

        if (window && monitor && window.get_monitor() === monitor.index) {
            const keyboardHeight = this.height;
            const keyboardY1 = (monitor.y + monitor.height) - keyboardHeight;

            if (this._focusWindow === window) {
                if (y + h + keyboardHeight < keyboardY1)
                    this._setFocusWindow(null);

                return;
            }

            if (y + h >= keyboardY1) {
log("KEYBOARD: there's y overlap, setting window");
                this._setFocusWindow(window);
            } else {
log("KEYBOARD: no y olverlap");
                this._setFocusWindow(null);
}
        } else {
log("KEYBOARD: no window");
            this._setFocusWindow(null);
        }
    }
});

var KeyboardController = class extends Signals.EventEmitter {
    constructor() {
        super();

        let seat = Clutter.get_default_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._inputSourceManager = InputSourceManager.getInputSourceManager();
        this._inputSourceManager.connectObject(
            'current-source-changed', this._onSourceChanged.bind(this),
            'sources-changed', this._onSourcesModified.bind(this), this);
        this._currentSource = this._inputSourceManager.currentSource;

        Main.inputMethod.connectObject(
            'notify::content-purpose', this._onContentPurposeHintsChanged.bind(this),
            'notify::content-hints', this._onContentPurposeHintsChanged.bind(this),
            'input-panel-state', (o, state) => this.emit('panel-state', state), this);
    }

    destroy() {
        this._inputSourceManager.disconnectObject(this);
        Main.inputMethod.disconnectObject(this);

        // Make sure any buttons pressed by the virtual device are released
        // immediately instead of waiting for the next GC cycle
        this._virtualDevice.run_dispose();
    }

    _onSourcesModified() {
        this.emit('groups-changed');
    }

    _onSourceChanged(inputSourceManager, _oldSource) {
        let source = inputSourceManager.currentSource;
        this._currentSource = source;
        this.emit('active-group', source.id);
    }

    _onContentPurposeHintsChanged(method) {
        let purpose = method.content_purpose;
        let emojiVisible = false;
        let keypadVisible = false;

        if (purpose == Clutter.InputContentPurpose.NORMAL ||
            purpose == Clutter.InputContentPurpose.ALPHA ||
            purpose == Clutter.InputContentPurpose.PASSWORD ||
            purpose == Clutter.InputContentPurpose.TERMINAL)
            emojiVisible = true;
        if (purpose == Clutter.InputContentPurpose.DIGITS ||
            purpose == Clutter.InputContentPurpose.NUMBER ||
            purpose == Clutter.InputContentPurpose.PHONE)
            keypadVisible = true;

        this.emit('emoji-visible', emojiVisible);
        this.emit('keypad-visible', keypadVisible);
    }

    getGroups() {
        let inputSources = this._inputSourceManager.inputSources;
        let groups = [];

        for (let i in inputSources) {
            let is = inputSources[i];
            groups[is.index] = is.xkbId;
        }

        return groups;
    }

    getCurrentGroup() {
        // Special case for Korean, if Hangul mode is disabled, use the 'us' keymap
        if (this._currentSource.id === 'hangul') {
            const inputSourceManager = InputSourceManager.getInputSourceManager();
            const currentSource = inputSourceManager.currentSource;
            let prop;
            for (let i = 0; (prop = currentSource.properties.get(i)) !== null; ++i) {
                if (prop.get_key() === 'InputMode' &&
                    prop.get_prop_type() === IBus.PropType.TOGGLE &&
                    prop.get_state() !== IBus.PropState.CHECKED)
                    return 'us';
            }
        }

        let group = this._currentSource.xkbId;

        if (Main.inputMethod.terminalMode)
            group += '-extended';

        if (Main.layoutManager.isPhone)
            group += '-mobile';

        return group;
    }

    commitString(string, fromKey) {
        if (string == null)
            return false;
        /* Let ibus methods fall through keyval emission */
        if (fromKey && this._currentSource.type == InputSourceManager.INPUT_SOURCE_TYPE_IBUS)
            return false;

        Main.inputMethod.commit(string);
        return true;
    }

    keyvalPress(keyval) {
        this._virtualDevice.notify_keyval(Clutter.get_current_event_time() * 1000,
                                          keyval, Clutter.KeyState.PRESSED);
    }

    keyvalRelease(keyval) {
        this._virtualDevice.notify_keyval(Clutter.get_current_event_time() * 1000,
                                          keyval, Clutter.KeyState.RELEASED);
    }
};
