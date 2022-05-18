// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported SwipeTracker */

const { Clutter, Gio, GLib, GObject, Meta } = imports.gi;

const Main = imports.ui.main;
const Params = imports.misc.params;

// FIXME: ideally these values matches physical touchpad size. We can get the
// correct values for gnome-shell specifically, since mutter uses libinput
// directly, but GTK apps cannot get it, so use an arbitrary value so that
// it's consistent with apps.
const TOUCHPAD_BASE_HEIGHT = 300;
const TOUCHPAD_BASE_WIDTH = 400;

const EVENT_HISTORY_THRESHOLD_MS = 150;

const SCROLL_MULTIPLIER = 10;

const MIN_ANIMATION_DURATION = 100;
const MAX_ANIMATION_DURATION = 400;
const VELOCITY_THRESHOLD_TOUCH = 0.3;
const VELOCITY_THRESHOLD_TOUCHPAD = 0.6;
const DECELERATION_TOUCH = 0.998;
const DECELERATION_TOUCHPAD = 0.997;
const VELOCITY_CURVE_THRESHOLD = 2;
const DECELERATION_PARABOLA_MULTIPLIER = 0.35;

// Derivative of easeOutCubic at t=0
const DURATION_MULTIPLIER = 3;
const ANIMATION_BASE_VELOCITY = 0.002;
const EPSILON = 0.005;

const GESTURE_FINGER_COUNT = 3;

const EventHistory = class {
    constructor() {
        this.reset();
    }

    reset() {
        this._data = [];
    }

    trim(time) {
        const thresholdTime = time - EVENT_HISTORY_THRESHOLD_MS;
        const index = this._data.findIndex(r => r.time >= thresholdTime);

        this._data.splice(0, index);
    }

    append(time, delta) {
        this.trim(time);

        this._data.push({ time, delta });
    }

    calculateVelocity() {
        if (this._data.length < 2)
            return 0;

        const firstTime = this._data[0].time;
        const lastTime = this._data[this._data.length - 1].time;

        if (firstTime === lastTime)
            return 0;

        const totalDelta = this._data.slice(1).map(a => a.delta).reduce((a, b) => a + b);
        const period = lastTime - firstTime;

        return totalDelta / period;
    }
};

// USAGE:
//
// To correctly implement the gesture, there must be handlers for the following
// signals:
//
// begin(tracker, monitor)
//   The handler should check whether a deceleration animation is currently
//   running. If it is, it should stop the animation (without resetting
//   progress). Then it should call:
//   tracker.confirmSwipe(distance, snapPoints, currentProgress, cancelProgress)
//   If it's not called, the swipe would be ignored.
//   The parameters are:
//    * distance: the page size;
//    * snapPoints: an (sorted with ascending order) array of snap points;
//    * currentProgress: the current progress;
//    * cancelprogress: a non-transient value that would be used if the gesture
//      is cancelled.
//   If no animation was running, currentProgress and cancelProgress should be
//   same. The handler may set 'orientation' property here.
//
// update(tracker, progress)
//   The handler should set the progress to the given value.
//
// end(tracker, duration, endProgress)
//   The handler should animate the progress to endProgress. If endProgress is
//   0, it should do nothing after the animation, otherwise it should change the
//   state, e.g. change the current page or switch workspace.
//   NOTE: duration can be 0 in some cases, in this case it should finish
//   instantly.

/** A class for handling swipe gestures */
var SwipeTracker = GObject.registerClass({
    Properties: {
        'orientation': GObject.ParamSpec.enum(
            'orientation', 'orientation', 'orientation',
            GObject.ParamFlags.READWRITE,
            Clutter.Orientation, Clutter.Orientation.HORIZONTAL),
        'distance': GObject.ParamSpec.double(
            'distance', 'distance', 'distance',
            GObject.ParamFlags.READWRITE,
            0, Infinity, 0),
        'allow-long-swipes': GObject.ParamSpec.boolean(
            'allow-long-swipes', 'allow-long-swipes', 'allow-long-swipes',
            GObject.ParamFlags.READWRITE,
            false),
        'scroll-modifiers': GObject.ParamSpec.flags(
            'scroll-modifiers', 'scroll-modifiers', 'scroll-modifiers',
            GObject.ParamFlags.READWRITE,
            Clutter.ModifierType, 0),
        'allow-drag': GObject.ParamSpec.boolean(
            'allow-drag', 'allow-drag', 'allow-drag',
            GObject.ParamFlags.READWRITE,
            true),
        'dont-snap': GObject.ParamSpec.boolean(
            'dont-snap', 'dont-snap', 'dont-snap',
            GObject.ParamFlags.READWRITE,
            false),
    },
    Signals: {
        'begin':  { param_types: [GObject.TYPE_UINT] },
        'update': { param_types: [GObject.TYPE_DOUBLE] },
        'end':    { param_types: [GObject.TYPE_UINT64, GObject.TYPE_DOUBLE, GObject.TYPE_JSOBJECT] },
    },
}, class SwipeTracker extends Clutter.PanGesture {
    _init(orientation, allowedModes, params) {
        params = Params.parse(params, { allowDrag: true, allowScroll: true });

        super._init({
            pan_axis: orientation === Clutter.Orientation.HORIZONTAL
                ? Clutter.PanAxis.X : Clutter.PanAxis.Y,
            min_n_points: 1,
            max_n_points: GESTURE_FINGER_COUNT,
        });

        this.orientation = orientation;
        this._allowedModes = allowedModes;
        this._enabled = true;
        this._distance = global.screen_height;
        this._allowDrag = true;

        this.begin_threshold = 16;

        this.connect('pan-begin', this._beginGesture.bind(this));
        this.connect('pan-update', this._updateTouchGesture.bind(this));
        this.connect('pan-end', this._endTouchGesture.bind(this));
        this.connect('pan-cancel', this._cancelTouchGesture.bind(this));

        this._scrollEnabled = params.allowScroll;

        this._cumulativeX = 0;
        this._cumulativeY = 0;
        this._touchpadSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.touchpad',
        });
        this._history = new EventHistory();

      //  this.connect('notify::enabled', () => {
      //      if (!this.enabled && this.state === Clutter.GestureState.RECOGNIZING)
      //          this.set_state(Clutter.GestureState.CANCELLED);
      //  });

        this._snapPoints = [];
        this._initialProgress = 0;
        this._cancelProgress = 0;
        this._progress = 0;

        this._reset();
    }

    vfunc_set_actor(actor) {
        if (actor) {
            actor.connectObject(
                'event::scroll', this._handleScrollEvent.bind(this),
                'event::touchpad', this._handleTouchpadEvent.bind(this),
                this);
        }

        super.vfunc_set_actor(actor);
    }

    vfunc_may_recognize() {
        return (this._allowedModes & Main.actionMode) !== 0;
    }

    /**
     * canHandleScrollEvent:
     * @param {Clutter.Event} scrollEvent: an event to check
     * @returns {bool} whether the event can be handled by the tracker
     *
     * This function can be used to combine swipe gesture and mouse
     * scrolling.
     */
    canHandleScrollEvent(event) {
        if (!this.enabled || !this._scrollEnabled)
            return false;

        if (event.type() !== Clutter.EventType.SCROLL)
            return false;

        if (event.get_scroll_source() !== Clutter.ScrollSource.FINGER &&
            event.get_source_device().get_device_type() !== Clutter.InputDeviceType.TOUCHPAD_DEVICE)
            return false;

        if (!this.enabled)
            return false;

        if ((this._allowedModes & Main.actionMode) === 0)
            return false;

        if (this.state !== Clutter.GestureState.RECOGNIZING && this.scrollModifiers !== 0 &&
            (event.get_state() & this.scrollModifiers) === 0)
            return false;

        return true;
    }

    get distance() {
        return this._distance;
    }

    set distance(distance) {
        if (this._distance === distance)
            return;

        this._distance = distance;
        this.notify('distance');
    }

    get allowDrag() {
        return this._allowDrag;
    }

    set allowDrag(allowDrag) {
        if (this._allowDrag === allowDrag)
            return;

        this._allowDrag = allowDrag;
        if (this._allowDrag)
            this.min_n_points = 1;
        else
            this.min_n_points = GESTURE_FINGER_COUNT;

        this.notify('allow-drag');
    }

    _reset() {
        this._history.reset();

        this._isTouchpadGesture = false;
        this.set_allowed_device_types([
            Clutter.InputDeviceType.TOUCHSCREEN_DEVICE,
            Clutter.InputDeviceType.TABLET_DEVICE,
        ]);
    }

    _endAnimationDoneCb() {
        this.begin_threshold = this._oldBeginThreshold;
    }

    vfunc_state_changed(oldState, newState) {
        if (this._isTouchpadGesture) {
            if (oldState === Clutter.GestureState.WAITING &&
                newState === Clutter.GestureState.POSSIBLE) {
                this.set_allowed_device_types([]);

                this._cumulativeX = 0;
                this._cumulativeY = 0;
            }

            if (oldState !== Clutter.GestureState.RECOGNIZING &&
                newState === Clutter.GestureState.RECOGNIZING)
                this._beginGesture(this, this._beginX, this._beginY);

            if (oldState === Clutter.GestureState.RECOGNIZING &&
                newState === Clutter.GestureState.CANCELLED)
                this.emit('end', 0, this._cancelProgress, () => {});
        } else {
            super.vfunc_state_changed(oldState, newState);
        }

        if (newState === Clutter.GestureState.RECOGNIZED ||
            newState === Clutter.GestureState.CANCELLED)
            this._reset();
    }

    _handleScrollEvent(actor, event) {
        if (!this.canHandleScrollEvent(event))
            return Clutter.EVENT_PROPAGATE;

        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;

        const vertical = this.orientation === Clutter.Orientation.VERTICAL;

        let time = event.get_time();
        let [dx, dy] = event.get_scroll_delta();

        if (this.state === Clutter.GestureState.WAITING) {
            this._isTouchpadGesture = true;

            this.set_state(Clutter.GestureState.POSSIBLE);
            if (this.state === Clutter.GestureState.POSSIBLE) {
                let [x, y] = event.get_coords();
                this._beginX = x;
                this._beginY = y;
                this._history.append(time, 0);

                this.set_state(Clutter.GestureState.RECOGNIZING);
            } else {
                this._isTouchpadGesture = false;
            }
        }

        if (!this._isTouchpadGesture)
            return Clutter.EVENT_PROPAGATE;

        if (this.state === Clutter.GestureState.RECOGNIZING) {
            if (this._holdEndedId) {
                GLib.source_remove(this._holdEndedId);
                delete this._holdEndedId;
            }

            if (dx === 0 && dy === 0) {
                this._history.trim(time);
                const velocity = this._history.calculateVelocity();

                this.set_state(Clutter.GestureState.RECOGNIZED);
                this._endTouchpadGesture(this, velocity);
                return;
            }

            const delta = (vertical ? dy : dx) * SCROLL_MULTIPLIER;

            this._history.append(time, delta);
            this._updateTouchpadGesture(this, delta);
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _handleHoldEvent(event) {
        const phase = event.get_gesture_phase();

        const mods = global.get_pointer()[2];
        const scrollEnabled = this._scrollEnabled &&
            (this.scrollModifiers === 0 || (mods & this.scrollModifiers) !== 0);

         if (event.get_touchpad_gesture_finger_count() !== GESTURE_FINGER_COUNT &&
             (!scrollEnabled || event.get_touchpad_gesture_finger_count() !== 2))
            return Clutter.EVENT_PROPAGATE;

        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            if (this.state === Clutter.GestureState.WAITING && this.begin_threshold === 0) {
                this._isTouchpadGesture = true;
                [this._beginX, this._beginY] = event.get_coords();
                this._history.append(event.get_time(), 0);

                this.set_state(Clutter.GestureState.POSSIBLE);
                if (this.state === Clutter.GestureState.POSSIBLE)
                    this.set_state(Clutter.GestureState.RECOGNIZING);
                else
                    this._isTouchpadGesture = false;
            }
        } else if (phase === Clutter.TouchpadGesturePhase.END ||
                   phase === Clutter.TouchpadGesturePhase.CANCEL) {
            if (this.state === Clutter.GestureState.RECOGNIZING) {
                this._holdEndedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this.set_state(Clutter.GestureState.RECOGNIZED);
                    this._endTouchpadGesture(this, 0);

                    delete this._holdEndedId;
                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _handleTouchpadEvent(actor, event) {
        if (!this.enabled)
            return Clutter.EVENT_PROPAGATE;

        if (event.type() === Clutter.EventType.TOUCHPAD_HOLD)
            return this._handleHoldEvent(event);

        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        const phase = event.get_gesture_phase();

        if (event.get_touchpad_gesture_finger_count() !== GESTURE_FINGER_COUNT)
            return Clutter.EVENT_PROPAGATE;

        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            if (this.state === Clutter.GestureState.WAITING) {
                this._isTouchpadGesture = true;

                this.set_state(Clutter.GestureState.POSSIBLE);
                if (this.state !== Clutter.GestureState.POSSIBLE)
                    this._isTouchpadGesture = false;
            }
        }

        if (!this._isTouchpadGesture)
            return Clutter.EVENT_PROPAGATE;

        let time = event.get_time();

        const [x, y] = event.get_coords();
        const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();

        if (this.state === Clutter.GestureState.POSSIBLE) {
            if (phase === Clutter.TouchpadGesturePhase.END ||
                phase === Clutter.TouchpadGesturePhase.CANCEL) {
                this.set_state(Clutter.GestureState.CANCELLED);
                return;
            }

            this._cumulativeX += dx;
            this._cumulativeY += dy;

            if ((this.orientation === Clutter.Orientation.VERTICAL &&
                 Math.abs(this._cumulativeY) >= this.begin_threshold) ||
                (this.orientation === Clutter.Orientation.HORIZONTAL &&
                 Math.abs(this._cumulativeX) >= this.begin_threshold)) {
                this._beginX = x;
                this._beginY = y;
                this._history.append(time, 0);

                this.set_state(Clutter.GestureState.RECOGNIZING);
            } else {
                return Clutter.EVENT_PROPAGATE;
            }
        }

        if (this.state === Clutter.GestureState.RECOGNIZING) {
            const vertical = this.orientation === Clutter.Orientation.VERTICAL;
            let delta = vertical ? dy : dx;

            if (this._holdEndedId) {
                GLib.source_remove(this._holdEndedId);
                delete this._holdEndedId;
            }

            switch (phase) {
            case Clutter.TouchpadGesturePhase.BEGIN:
            case Clutter.TouchpadGesturePhase.UPDATE:
                if (this._touchpadSettings.get_boolean('natural-scroll'))
                    delta = -delta;

                this._history.append(time, delta);

                this._updateTouchpadGesture(this, delta);
                break;

            case Clutter.TouchpadGesturePhase.END:
            case Clutter.TouchpadGesturePhase.CANCEL:
                this._history.trim(time);
                const velocity = this._history.calculateVelocity();

                this.set_state(Clutter.GestureState.RECOGNIZED);
                this._endTouchpadGesture(this, velocity);
                break;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _beginGesture(gesture, x, y) {
        let rect = new Meta.Rectangle({ x, y, width: 1, height: 1 });
        let monitor = global.display.get_monitor_index_for_rect(rect);

        this.emit('begin', monitor);
    }

    _findClosestPoint(pos) {
        const distances = this._snapPoints.map(x => Math.abs(x - pos));
        const min = Math.min(...distances);
        return distances.indexOf(min);
    }

    _findNextPoint(pos) {
        return this._snapPoints.findIndex(p => p >= pos);
    }

    _findPreviousPoint(pos) {
        const reversedIndex = this._snapPoints.slice().reverse().findIndex(p => p <= pos);
        return this._snapPoints.length - 1 - reversedIndex;
    }

    _findPointForProjection(pos, velocity) {
        const initial = this._findClosestPoint(this._initialProgress);
        const prev = this._findPreviousPoint(pos);
        const next = this._findNextPoint(pos);

        // If the swipe was so small that the projection landed on the current
        // page, we still choose the next page (feels better in real use).
        if ((velocity > 0 ? prev : next) === initial)
            return velocity > 0 ? next : prev;

        return this._findClosestPoint(pos);
    }

    _updateGesture(delta, isTouchpad) {
        if (this.orientation === Clutter.Orientation.HORIZONTAL &&
            Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
            delta = -delta;

        const vertical = this.orientation === Clutter.Orientation.VERTICAL;
        const distance = isTouchpad
            ? vertical ? TOUCHPAD_BASE_HEIGHT : TOUCHPAD_BASE_WIDTH
            : this._distance;

        if (distance === 0)
            throw new Error();

        this._progress += delta / distance;

        if (!this.dontSnap) {
            const prevPoint = this._findPreviousPoint(this._progress);
            const nextPoint = this._findNextPoint(this._progress);
            if (prevPoint < this._peekedMinSnapPoint)
                this._peekedMinSnapPoint = prevPoint;
            if (nextPoint > this._peekedMaxSnapPoint)
                this._peekedMaxSnapPoint = nextPoint;

            this._progress = Math.clamp(this._progress, this._snapPoints[0], this._snapPoints[this._snapPoints.length - 1]);
        }

        this.emit('update', this._progress);
    }

    _updateTouchGesture(gesture, deltaX, deltaY, pannedDistance) {
        const delta = this.orientation === Clutter.Orientation.HORIZONTAL
            ? -deltaX
            : -deltaY;

        this._updateGesture(delta, false);
    }

    _updateTouchpadGesture(gesture, delta) {
        this._updateGesture(delta, true);
    }

    _getEndProgress(velocity, distance, isTouchpad) {
        const threshold = isTouchpad ? VELOCITY_THRESHOLD_TOUCHPAD : VELOCITY_THRESHOLD_TOUCH;

        const decel = isTouchpad ? DECELERATION_TOUCHPAD : DECELERATION_TOUCH;
        const slope = decel / (1.0 - decel) / 1000.0;

        let pos;
        if (Math.abs(velocity) > VELOCITY_CURVE_THRESHOLD) {
            const c = slope / 2 / DECELERATION_PARABOLA_MULTIPLIER;
            const x = Math.abs(velocity) - VELOCITY_CURVE_THRESHOLD + c;

            pos = slope * VELOCITY_CURVE_THRESHOLD +
                DECELERATION_PARABOLA_MULTIPLIER * x * x -
                DECELERATION_PARABOLA_MULTIPLIER * c * c;
        } else {
            pos = Math.abs(velocity) * slope;
        }

        pos = pos * Math.sign(velocity) + this._progress;
        if (this.dontSnap)
            return pos;

        if (Math.abs(velocity) < threshold)
            return this._snapPoints[this._findClosestPoint(this._progress)];

        const boundsMin = this.allowLongSwipes
            ? this._snapPoints[0] : this._snapPoints[this._peekedMinSnapPoint];
        const boundsMax = this.allowLongSwipes
            ? this._snapPoints[this._snapPoints.length - 1]
            : this._snapPoints[this._peekedMaxSnapPoint];
        pos = Math.clamp(pos, boundsMin, boundsMax);

        const index = this._findPointForProjection(pos, velocity);

        return this._snapPoints[index];
    }

    _getAnimateOutParams(velocity, isTouchpad) {
        const vertical = this.orientation === Clutter.Orientation.VERTICAL;
        const distance = isTouchpad
            ? vertical ? TOUCHPAD_BASE_HEIGHT : TOUCHPAD_BASE_WIDTH
            : this._distance;

        const endProgress = this._getEndProgress(velocity, distance, isTouchpad);

        velocity /= distance;

        if ((endProgress - this._progress) * velocity <= 0)
            velocity = ANIMATION_BASE_VELOCITY;

        const nPoints = Math.max(1, Math.ceil(Math.abs(this._progress - endProgress)));
        const maxDuration = MAX_ANIMATION_DURATION * Math.log2(1 + nPoints);

        let duration = Math.abs((this._progress - endProgress) / velocity * DURATION_MULTIPLIER);
        if (duration > 0)
            duration = Math.clamp(duration, MIN_ANIMATION_DURATION, maxDuration);

        return [duration, endProgress];
    }

    _endGesture(velocity, isTouchpad) {
        if (this._otherDimensionTracker) {
            const otherTracker = this._otherDimensionTracker;

            if (otherTracker.state === Clutter.GestureState.RECOGNIZING) {
                this._endVelocity = velocity;
                this._endIsTouchpad = isTouchpad;
                return;
            }

            if (otherTracker._endVelocity !== undefined) {
                if (Math.abs(velocity) < Math.abs(otherTracker._endVelocity))
                    velocity = 0;
                else
                    otherTracker._endVelocity = 0;

                const [ourDuration, ourEndProgress] = this._getAnimateOutParams(velocity, isTouchpad);
                const [otherDuration, otherEndProgress] =
                    otherTracker._getAnimateOutParams(otherTracker._endVelocity, otherTracker._endIsTouchpad);

                const finalDuration = ourDuration > otherDuration ? ourDuration : otherDuration;

                this._oldBeginThreshold = this.begin_threshold;
                this.begin_threshold = 0;
                otherTracker._oldBeginThreshold = otherTracker.begin_threshold;
                otherTracker.begin_threshold = 0;

                otherTracker.emit('end', finalDuration, otherEndProgress, this._endAnimationDoneCb.bind(otherTracker));
                this.emit('end', finalDuration, ourEndProgress, this._endAnimationDoneCb.bind(this));

                delete otherTracker._endVelocity;
                delete otherTracker._endIsTouchpad;

                return;
            }
        }

        const [duration, endProgress] = this._getAnimateOutParams(velocity, isTouchpad);

        this._oldBeginThreshold = this.begin_threshold;
        this.begin_threshold = 0;
        this.emit('end', duration, endProgress, this._endAnimationDoneCb.bind(this));
    }

    _endTouchGesture(gesture, velocityX, velocityY) {
        const velocity = this.orientation === Clutter.Orientation.HORIZONTAL
            ? -velocityX
            : -velocityY;

        this._endGesture(velocity, false);
    }

    _endTouchpadGesture(gesture, velocity) {
        this._endGesture(velocity, true);
    }

    _cancelTouchGesture(_gesture) {
        this.emit('end', 0, this._cancelProgress, () => {});
    }

    /**
     * confirmSwipe:
     * @param {number} distance: swipe distance in pixels
     * @param {number[]} snapPoints:
     *     An array of snap points, sorted in ascending order
     * @param {number} currentProgress: initial progress value
     * @param {number} cancelProgress: the value to be used on cancelling
     * @param {number} animatingTowardsProgress:
     *
     * Confirms a swipe. User has to call this in 'begin' signal handler,
     * otherwise the swipe wouldn't start. If there's an animation running,
     * it should be stopped first.
     *
     * @cancel_progress must always be a snap point, or a value matching
     * some other non-transient state.
     */
    confirmSwipe(distance, snapPoints, currentProgress, cancelProgress, animatingTowardsProgress = null) {
        this.distance = distance;
        this._snapPoints = snapPoints;
        this._initialProgress = currentProgress;
        this._progress = currentProgress;
        this._cancelProgress = cancelProgress;

        this._peekedMinSnapPoint = this._findPreviousPoint(this._progress);
        this._peekedMaxSnapPoint = this._findNextPoint(this._progress);

        if (animatingTowardsProgress &&
            this._peekedMinSnapPoint > 0 &&
            animatingTowardsProgress === this._snapPoints[this._peekedMinSnapPoint])
            this._peekedMinSnapPoint--;

        if (animatingTowardsProgress &&
            this._peekedMaxSnapPoint < this._snapPoints.length - 1 &&
            animatingTowardsProgress === this._snapPoints[this._peekedMaxSnapPoint])
            this._peekedMaxSnapPoint++;
    }

    destroy() {
        global.stage.disconnectObject(this);
    }

    make2d(otherSwipeTracker) {
        if (!(otherSwipeTracker instanceof SwipeTracker))
            throw new Error('Must pass a SwipeTracker to make2d');

        if (this.orientation === otherSwipeTracker.orientation)
            throw new Error('Other SwipeTracker must have different orientation');

        if (this._otherDimensionTracker || otherSwipeTracker._otherDimensionTracker)
            throw new Error('Is already 2d');

        this.can_not_cancel(otherSwipeTracker);
        otherSwipeTracker.can_not_cancel(this);

        /* ClutterGesture is not aware of sequences from scroll/touchpad
         * events, so we also need to enable recognizing independently.
         */
        this.recognize_independently_from(otherSwipeTracker);
        otherSwipeTracker.recognize_independently_from(this);

        this._otherDimensionTracker = otherSwipeTracker;
        otherSwipeTracker._otherDimensionTracker = this;
    }
});
