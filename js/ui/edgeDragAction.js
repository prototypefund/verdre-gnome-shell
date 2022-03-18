// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported EdgeDragAction */

const { Clutter, GLib, GObject, Meta, St } = imports.gi;

const Main = imports.ui.main;

var EDGE_THRESHOLD = 20;
var DRAG_DISTANCE = 80;
var CANCEL_THRESHOLD = 100;
var CANCEL_TIMEOUT_MS = 200;

var EdgeDragAction = GObject.registerClass({
    Signals: {
        'activated': {},
        'progress': { param_types: [GObject.TYPE_DOUBLE] },
        'cancelled': {},
    },
}, class EdgeDragAction extends Clutter.Gesture {
    _init(side, allowedModes) {
        super._init();
        this._side = side;
        this._allowedModes = allowedModes;
    }

    _getMonitorForCoords(coords) {
        const rect = new Meta.Rectangle({ x: coords.x - 1, y: coords.y - 1, width: 1, height: 1 });
        const monitorIndex = global.display.get_monitor_index_for_rect(rect);

        return Main.layoutManager.monitors[monitorIndex];
    }

    _isNearMonitorEdge(point) {
        const monitor = this._getMonitorForCoords(point.latest_coords);

        switch (this._side) {
        case St.Side.LEFT:
            return point.latest_coords.x < monitor.x + EDGE_THRESHOLD;
        case St.Side.RIGHT:
            return point.latest_coords.x > monitor.x + monitor.width - EDGE_THRESHOLD;
        case St.Side.TOP:
            return point.latest_coords.y < monitor.y + EDGE_THRESHOLD;
        case St.Side.BOTTOM:
            return point.latest_coords.y > monitor.y + monitor.height - EDGE_THRESHOLD;
        }
    }

    _exceedsCancelThreshold(point) {
        const [_distance, offsetX, offsetY] = point.begin_coords.distance(point.latest_coords);

        switch (this._side) {
        case St.Side.LEFT:
        case St.Side.RIGHT:
            return offsetY > CANCEL_THRESHOLD;
        case St.Side.TOP:
        case St.Side.BOTTOM:
            return offsetX > CANCEL_THRESHOLD;
        }
    }

    _passesDistanceNeeded(point) {
        const monitor = this._getMonitorForCoords(point.begin_coords);

        switch (this._side) {
        case St.Side.LEFT:
            return point.latest_coords.x > monitor.x + DRAG_DISTANCE;
        case St.Side.RIGHT:
            return point.latest_coords.x < monitor.x + monitor.width - DRAG_DISTANCE;
        case St.Side.TOP:
            return point.latest_coords.y > monitor.y + DRAG_DISTANCE;
        case St.Side.BOTTOM:
            return point.latest_coords.y < monitor.y + monitor.height - DRAG_DISTANCE;
        }
    }

    vfunc_points_began(points) {
        const point = points[0];
        const nPoints = this.get_points().length;

        if (nPoints > 1 ||
            !(this._allowedModes & Main.actionMode) ||
            !this._isNearMonitorEdge(point)) {
            this.set_state(Clutter.GestureState.CANCELLED);
            return;
        }

        this._cancelTimeoutId =
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, CANCEL_TIMEOUT_MS, () => {
                if (this._isNearMonitorEdge(point))
                    this.set_state(Clutter.GestureState.CANCELLED);

                delete this._cancelTimeoutId;
                return GLib.SOURCE_REMOVE;
            });
    }

    vfunc_points_moved(points) {
        const point = points[0];

        if (this._exceedsCancelThreshold(point)) {
            this.set_state(Clutter.GestureState.CANCELLED);
            return;
        }

        if (this.state === Clutter.GestureState.POSSIBLE &&
            !this._isNearMonitorEdge(point))
            this.set_state(Clutter.GestureState.RECOGNIZING);
    
        if (this.state === Clutter.GestureState.RECOGNIZING) {
            const [_distance, offsetX, offsetY] =
                point.begin_coords.distance(point.move_coords);

            if (this._side === St.Side.TOP ||
                this._side === St.Side.BOTTOM)
                this.emit('progress', offsetY);
            else
                this.emit('progress', offsetX);

            if (this._passesDistanceNeeded(point))
                this.set_state(Clutter.GestureState.RECOGNIZED);
        }
    }

    vfunc_points_ended(points) {
        this.set_state(Clutter.GestureState.CANCELLED);
    }

    vfunc_points_cancelled(points) {
        this.set_state(Clutter.GestureState.CANCELLED);
    }

    vfunc_state_changed(oldState, newState) {
        if (newState === Clutter.GestureState.RECOGNIZED)
            this.emit('activated');

        if (oldState === Clutter.GestureState.RECOGNIZING &&
            newState === Clutter.GestureState.CANCELLED)
            this.emit('cancelled');

        if (newState === Clutter.GestureState.CANCELLED ||
            newState === Clutter.GestureState.RECOGNIZED) {
            if (this._cancelTimeoutId) {
                GLib.source_remove(this._cancelTimeoutId);
                this._cancelTimeoutId = 0;
            }
        }
    }
});
