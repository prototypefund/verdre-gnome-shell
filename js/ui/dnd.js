// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported addDragMonitor, removeDragMonitor, makeDraggable */

const { Clutter, GObject, GLib, Meta, Shell, St } = imports.gi;
const Signals = imports.misc.signals;

const Main = imports.ui.main;
const Params = imports.misc.params;

// Time to scale down to maxDragActorSize
var SCALE_ANIMATION_TIME = 250;
// Time to animate to original position on cancel
var SNAP_BACK_ANIMATION_TIME = 250;
// Time to animate to original position on success
var REVERT_ANIMATION_TIME = 750;

var DragMotionResult = {
    NO_DROP:   0,
    COPY_DROP: 1,
    MOVE_DROP: 2,
    CONTINUE:  3,
};

var DRAG_CURSOR_MAP = {
    0: Meta.Cursor.DND_UNSUPPORTED_TARGET,
    1: Meta.Cursor.DND_COPY,
    2: Meta.Cursor.DND_MOVE,
};

var DragDropResult = {
    FAILURE:  0,
    SUCCESS:  1,
    CONTINUE: 2,
};
var dragMonitors = [];

function _getRealActorScale(actor) {
    let scale = 1.0;
    while (actor) {
        scale *= actor.scale_x;
        actor = actor.get_parent();
    }
    return scale;
}

function addDragMonitor(monitor) {
    dragMonitors.push(monitor);
}

function removeDragMonitor(monitor) {
    for (let i = 0; i < dragMonitors.length; i++) {
        if (dragMonitors[i] == monitor) {
            dragMonitors.splice(i, 1);
            return;
        }
    }
}

/**
 * DndGesture:
 * @params: (optional) Additional parameters
 *
 * A sub-class of ClutterGesture that allows dragging actors.
 *
 * If %manualMode is %true in @params, do not automatically start
 * drag and drop on click. The drag has to be started by calling
 * startDrag() instead.
 *
 * If %restoreOnSuccess is %true in @params, the drag actor will be
 * faded back in at its initial position after a successful drag.
 *
 * If %dragActorMaxSize is present in @params, the drag actor will
 * be scaled down to be no larger than that size in pixels.
 *
 * If %dragActorOpacity is present in @params, the drag actor will
 * be set to have that opacity during the drag.
 *
 * Note that when the drag actor is the source actor and the drop
 * succeeds, the actor scale and opacity aren't reset; if the drop
 * target wants to reuse the actor, it's up to the drop target to
 * reset these values.
 */
var DndGesture = GObject.registerClass({
    Signals: {
        'drag-begin':  { param_types: [GObject.TYPE_UINT] },
        'drag-end': { param_types: [GObject.TYPE_UINT, GObject.TYPE_BOOLEAN] },
        'drag-cancelled': { param_types: [GObject.TYPE_UINT] },
    },
}, class DndGesture extends Clutter.Gesture {
    _init(params) {
        params = Params.parse(params, {
            manualMode: false,
            timeoutThreshold: 0,
            restoreOnSuccess: false,
            dragActorMaxSize: undefined,
            dragActorOpacity: undefined,
        });

        this._restoreOnSuccess = params.restoreOnSuccess;
        this._dragActorMaxSize = params.dragActorMaxSize;
        this._dragActorOpacity = params.dragActorOpacity;
        this._dragTimeoutThreshold = params.timeoutThreshold;

        this._animationInProgress = false; // The drag is over and the item is in the process of animating to its original position (snapping back or reverting).
        this._dragCancellable = true;

        super._init();
    }

    vfunc_set_actor(actor) {
        if (this.state === Clutter.GestureState.RECOGNIZING && this._dragCancellable)
            this.set_state(Clutter.GestureState.CANCELLED);

        super.vfunc_set_actor(actor);
        this._actor = actor;
    }

    /**
     * fakeRelease:
     *
     * Fake a release event.
     * Must be called if you want to intercept release events on draggable
     * actors for other purposes (for example if you're using
     * PopupMenu.ignoreRelease())
     */
    fakeRelease() {
        this.set_state(Clutter.GestureState.CANCELLED);
    }

    _gestureRecognizing() {
        const pressCoords = this.get_points()[0].begin_coords;

        this.emit('drag-begin', this.get_points()[0].event_time);
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);

        this._dragX = this._dragStartX = pressCoords.x;
        this._dragY = this._dragStartY = pressCoords.y;

        let scaledWidth, scaledHeight;

        if (this._actor._delegate && this._actor._delegate.getDragActor) {
            this._dragActor = this._actor._delegate.getDragActor();
            Main.uiGroup.add_child(this._dragActor);
            Main.uiGroup.set_child_above_sibling(this._dragActor, null);
            Shell.util_set_hidden_from_pick(this._dragActor, true);

            // Drag actor does not always have to be the same as actor. For example drag actor
            // can be an image that's part of the actor. So to perform "snap back" correctly we need
            // to know what was the drag actor source.
            if (this._actor._delegate.getDragActorSource) {
                this._dragActorSource = this._actor._delegate.getDragActorSource();
                // If the user dragged from the source, then position
                // the dragActor over it. Otherwise, center it
                // around the pointer
                let [sourceX, sourceY] = this._dragActorSource.get_transformed_position();
                let x, y;
                if (pressCoords.x > sourceX && pressCoords.x <= sourceX + this._dragActor.width &&
                    pressCoords.y > sourceY && pressCoords.y <= sourceY + this._dragActor.height) {
                    x = sourceX;
                    y = sourceY;
                } else {
                    x = pressCoords.x - this._dragActor.width / 2;
                    y = pressCoords.y - this._dragActor.height / 2;
                }
                this._dragActor.set_position(x, y);

                this._dragActorSourceDestroyId = this._dragActorSource.connect('destroy', () => {
                    this._dragActorSource = null;
                });
            } else {
                this._dragActorSource = this._actor;
            }
            this._dragOrigParent = undefined;

            this._dragOffsetX = this._dragActor.x - this._dragStartX;
            this._dragOffsetY = this._dragActor.y - this._dragStartY;

            [scaledWidth, scaledHeight] = this._dragActor.get_transformed_size();
        } else {
            this._dragActor = this._actor;

            this._dragActorSource = undefined;
            this._dragOrigParent = this._actor.get_parent();

            this._dragActorHadFixedPos = this._dragActor.fixed_position_set;
            this._dragOrigX = this._dragActor.allocation.x1;
            this._dragOrigY = this._dragActor.allocation.y1;
            this._dragActorHadNatWidth = this._dragActor.natural_width_set;
            this._dragActorHadNatHeight = this._dragActor.natural_height_set;
            this._dragOrigWidth = this._dragActor.allocation.get_width();
            this._dragOrigHeight = this._dragActor.allocation.get_height();
            this._dragOrigScale = this._dragActor.scale_x;

            // Ensure actors with an allocation smaller than their natural size
            // retain their size
            this._dragActor.set_size(...this._dragActor.allocation.get_size());

            const transformedExtents = this._dragActor.get_transformed_extents();

            this._dragOffsetX = transformedExtents.origin.x - this._dragStartX;
            this._dragOffsetY = transformedExtents.origin.y - this._dragStartY;

            scaledWidth = transformedExtents.size.width;
            scaledHeight = transformedExtents.size.height;
            this._dragActor.scale_x = scaledWidth / this._dragOrigWidth;
            this._dragActor.scale_y = scaledHeight / this._dragOrigHeight;

            this._dragOrigParent.remove_actor(this._dragActor);
            Main.uiGroup.add_child(this._dragActor);
            Main.uiGroup.set_child_above_sibling(this._dragActor, null);
            Shell.util_set_hidden_from_pick(this._dragActor, true);

            this._dragOrigParentDestroyId = this._dragOrigParent.connect('destroy', () => {
                this._dragOrigParent = null;
            });
        }

        this._escKeyPressId = global.stage.connect('captured-event::key', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape &&
                event.type() === Clutter.EventType.KEY_PRESS) {
                this.set_state(Clutter.GestureState.CANCELLED);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        this._dragActorDestroyId = this._dragActor.connect('destroy', () => {
            // Cancel ongoing animation (if any)
            this._finishAnimation();

            this._dragActor = null;

            if (this.state === Clutter.GestureState.RECOGNIZING && this._dragCancellable)
                this.set_state(Clutter.GestureState.CANCELLED);
        });
        this._dragOrigOpacity = this._dragActor.opacity;
        if (this._dragActorOpacity != undefined)
            this._dragActor.opacity = this._dragActorOpacity;

        this._snapBackX = this._dragStartX + this._dragOffsetX;
        this._snapBackY = this._dragStartY + this._dragOffsetY;
        this._snapBackScale = this._dragActor.scale_x;

        let origDragOffsetX = this._dragOffsetX;
        let origDragOffsetY = this._dragOffsetY;
        let [transX, transY] = this._dragActor.get_translation();
        this._dragOffsetX -= transX;
        this._dragOffsetY -= transY;

        this._dragActor.set_position(
            this._dragX + this._dragOffsetX,
            this._dragY + this._dragOffsetY);

        if (this._dragActorMaxSize != undefined) {
            let currentSize = Math.max(scaledWidth, scaledHeight);
            if (currentSize > this._dragActorMaxSize) {
                let scale = this._dragActorMaxSize / currentSize;
                let origScale =  this._dragActor.scale_x;

                // The position of the actor changes as we scale
                // around the drag position, but we can't just tween
                // to the final position because that tween would
                // fight with updates as the user continues dragging
                // the mouse; instead we do the position computations in
                // a ::new-frame handler.
                this._dragActor.ease({
                    scale_x: scale * origScale,
                    scale_y: scale * origScale,
                    duration: SCALE_ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        this._updateActorPosition(origScale,
                            origDragOffsetX, origDragOffsetY, transX, transY);
                    },
                });

                this._dragActor.get_transition('scale-x').connect('new-frame', () => {
                    this._updateActorPosition(origScale,
                        origDragOffsetX, origDragOffsetY, transX, transY);
                });
            }
        }
    }

    /**
     * startDrag:
     *
     * Directly initiate a drag and drop operation from the given actor.
     * This function is useful to call if you've specified manualMode
     * for the drag action.
     */
    startDrag() {
        if (this.get_points().length !== 1)
            return;

        if (this.state === Clutter.GestureState.POSSIBLE)
            this.set_state(Clutter.GestureState.RECOGNIZING);
    }

    _updateActorPosition(origScale, origDragOffsetX, origDragOffsetY, transX, transY) {
        const currentScale = this._dragActor.scale_x / origScale;
        this._dragOffsetX = currentScale * origDragOffsetX - transX;
        this._dragOffsetY = currentScale * origDragOffsetY - transY;
        this._dragActor.set_position(
            this._dragX + this._dragOffsetX,
            this._dragY + this._dragOffsetY);
    }

    _maybeStartDrag(point) {
        const [stageX, stageY] = [point.latest_coords.x, point.latest_coords.y];

        if (this._dragThresholdIgnored)
            return;

        // See if the user has moved the mouse enough to trigger a drag
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let threshold = St.Settings.get().drag_threshold * scaleFactor;
        if ((Math.abs(stageX - this._dragStartX) > threshold ||
             Math.abs(stageY - this._dragStartY) > threshold)) {
            const deviceType = point.latest_event.get_source_device().get_device_type();
            const isPointerOrTouchpad =
                deviceType === Clutter.InputDeviceType.POINTER_DEVICE ||
                deviceType === Clutter.InputDeviceType.TOUCHPAD_DEVICE;
            const ellapsedTime = point.event_time - this._dragStartTime;

            // Pointer devices (e.g. mouse) start the drag immediately
            if (isPointerOrTouchpad || ellapsedTime > this._dragTimeoutThreshold) {
                this.startDrag();
                this._updateDragPosition(point);
            } else {
                this._dragThresholdIgnored = true;
            }
        }
    }

    _pickTargetActor() {
        return this._dragActor.get_stage().get_actor_at_pos(Clutter.PickMode.ALL,
                                                            this._dragX, this._dragY);
    }

    _updateDragHover() {
        this._updateHoverId = 0;
        let target = this._pickTargetActor();

        let dragEvent = {
            x: this._dragX,
            y: this._dragY,
            dragActor: this._dragActor,
            source: this._actor._delegate,
            targetActor: target,
        };

        let targetActorDestroyHandlerId;
        let handleTargetActorDestroyClosure;
        handleTargetActorDestroyClosure = () => {
            target = this._pickTargetActor();
            dragEvent.targetActor = target;
            targetActorDestroyHandlerId =
                target.connect('destroy', handleTargetActorDestroyClosure);
        };
        targetActorDestroyHandlerId =
            target.connect('destroy', handleTargetActorDestroyClosure);

        for (let i = 0; i < dragMonitors.length; i++) {
            let motionFunc = dragMonitors[i].dragMotion;
            if (motionFunc) {
                let result = motionFunc(dragEvent);
                if (result != DragMotionResult.CONTINUE) {
                    global.display.set_cursor(DRAG_CURSOR_MAP[result]);
                    return GLib.SOURCE_REMOVE;
                }
            }
        }
        dragEvent.targetActor.disconnect(targetActorDestroyHandlerId);

        while (target) {
            if (target._delegate && target._delegate.handleDragOver) {
                let [r_, targX, targY] = target.transform_stage_point(this._dragX, this._dragY);
                // We currently loop through all parents on drag-over even if one of the children has handled it.
                // We can check the return value of the function and break the loop if it's true if we don't want
                // to continue checking the parents.
                let result = target._delegate.handleDragOver(this._actor._delegate,
                                                             this._dragActor,
                                                             targX,
                                                             targY,
                                                             0);
                if (result != DragMotionResult.CONTINUE) {
                    global.display.set_cursor(DRAG_CURSOR_MAP[result]);
                    return GLib.SOURCE_REMOVE;
                }
            }
            target = target.get_parent();
        }
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);
        return GLib.SOURCE_REMOVE;
    }

    _queueUpdateDragHover() {
        if (this._updateHoverId)
            return;

        this._updateHoverId = GLib.idle_add(GLib.PRIORITY_DEFAULT,
                                            this._updateDragHover.bind(this));
        GLib.Source.set_name_by_id(this._updateHoverId, '[gnome-shell] this._updateDragHover');
    }

    _updateDragPosition(point) {
        const coords = point.latest_coords;
        this._dragX = coords.x;
        this._dragY = coords.y;
        this._dragActor.set_position(coords.x + this._dragOffsetX,
                                     coords.y + this._dragOffsetY);

        this._queueUpdateDragHover();
        return true;
    }

    _dragActorDropped(point) {
        const [dropX, dropY] = [point.end_coords.x, point.end_coords.y];

        let target = this._dragActor.get_stage().get_actor_at_pos(Clutter.PickMode.ALL,
                                                                  dropX, dropY);

        // We call observers only once per motion with the innermost
        // target actor. If necessary, the observer can walk the
        // parent itself.
        let dropEvent = {
            dropActor: this._dragActor,
            targetActor: target,
            clutterEvent: point.latest_event,
        };
        for (let i = 0; i < dragMonitors.length; i++) {
            let dropFunc = dragMonitors[i].dragDrop;
            if (dropFunc) {
                switch (dropFunc(dropEvent)) {
                case DragDropResult.FAILURE:
                    this.set_state(Clutter.GestureState.CANCELLED);
                    return;
                case DragDropResult.SUCCESS:
                    this.set_state(Clutter.GestureState.COMPLETED);
                    return;
                case DragDropResult.CONTINUE:
                    continue;
                }
            }
        }

        // At this point it is too late to cancel a drag by destroying
        // the actor, the fate of which is decided by acceptDrop and its
        // side-effects
        this._dragCancellable = false;

        while (target) {
            if (target._delegate && target._delegate.acceptDrop) {
                let [r_, targX, targY] = target.transform_stage_point(dropX, dropY);
                let accepted = false;
                try {
                    accepted = target._delegate.acceptDrop(this._actor._delegate,
                        this._dragActor, targX, targY, point.event_time);
                } catch (e) {
                    // On error, skip this target
                    logError(e, "Skipping drag target");
                }
                if (accepted) {
                    this.set_state(Clutter.GestureState.COMPLETED);

                    // If it accepted the drop without taking the actor,
                    // handle it ourselves.
                    if (this._dragActor && this._dragActor.get_parent() == Main.uiGroup) {
                        if (this._restoreOnSuccess) {
                            this._restoreDragActor(point.event_time);
                            return;
                        } else {
                            this._dragActor.destroy();
                        }
                    }

                    global.display.set_cursor(Meta.Cursor.DEFAULT);
                    this.emit('drag-end', point.event_time, true);
                    this._dragComplete();
                    return;
                }
            }
            target = target.get_parent();
        }

        // If no target has been found, cancel the drag
        this.set_state(Clutter.GestureState.CANCELLED);
    }

    _getRestoreLocation() {
        let x, y, scale;

        if (this._dragActorSource && this._dragActorSource.visible) {
            // Snap the clone back to its source
            [x, y] = this._dragActorSource.get_transformed_position();
            let [sourceScaledWidth] = this._dragActorSource.get_transformed_size();
            scale = sourceScaledWidth ? sourceScaledWidth / this._dragActor.width : 0;
        } else if (this._dragOrigParent) {
            // Snap the actor back to its original position within
            // its parent, adjusting for the fact that the parent
            // may have been moved or scaled
            let [parentX, parentY] = this._dragOrigParent.get_transformed_position();
            let parentScale = _getRealActorScale(this._dragOrigParent);

            x = parentX + parentScale * this._dragOrigX;
            y = parentY + parentScale * this._dragOrigY;
            scale = this._dragOrigScale * parentScale;
        } else {
            // Snap back actor to its original stage position
            x = this._snapBackX;
            y = this._snapBackY;
            scale = this._snapBackScale;
        }

        return [x, y, scale];
    }

    _restoreDragActor(eventTime) {
        let [restoreX, restoreY, restoreScale] = this._getRestoreLocation();

        // fade the actor back in at its original location
        this._dragActor.set_position(restoreX, restoreY);
        this._dragActor.set_scale(restoreScale, restoreScale);
        this._dragActor.opacity = 0;

        this._animateDragEnd(eventTime, {
            duration: REVERT_ANIMATION_TIME,
        });
    }

    _animateDragEnd(eventTime, params) {
        this._animationInProgress = true;

        // start the animation
        this._dragActor.ease(Object.assign(params, {
            opacity: this._dragOrigOpacity,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this._onAnimationComplete(eventTime);
            },
        }));
    }

    _finishAnimation() {
        if (!this._animationInProgress)
            return;

        this._animationInProgress = false;
        this._dragComplete();

        global.display.set_cursor(Meta.Cursor.DEFAULT);
    }

    _onAnimationComplete(eventTime) {
        if (this._dragOrigParent) {
            Main.uiGroup.remove_child(this._dragActor);
            this._dragOrigParent.add_actor(this._dragActor);
            this._dragActor.set_scale(this._dragOrigScale, this._dragOrigScale);
            if (this._dragActorHadFixedPos)
                this._dragActor.set_position(this._dragOrigX, this._dragOrigY);
            else
                this._dragActor.fixed_position_set = false;
            if (this._dragActorHadNatWidth)
                this._dragActor.set_width(-1);
            if (this._dragActorHadNatHeight)
                this._dragActor.set_height(-1);
        } else {
            this._dragActor?.destroy();
        }

        this.emit('drag-end', eventTime, false);
        this._finishAnimation();
    }

    _dragComplete() {
        if (this._dragActor)
            Shell.util_set_hidden_from_pick(this._dragActor, false);

        if (this._updateHoverId) {
            GLib.source_remove(this._updateHoverId);
            this._updateHoverId = 0;
        }

        global.stage.disconnect(this._escKeyPressId);
        delete this._escKeyPressId;

        if (this._dragActor) {
            this._dragActor.disconnect(this._dragActorDestroyId);
            this._dragActor = null;
        }

        if (this._dragOrigParent) {
            this._dragOrigParent.disconnect(this._dragOrigParentDestroyId);
            this._dragOrigParent = null;
        }

        if (this._dragActorSource) {
            this._dragActorSource.disconnect(this._dragActorSourceDestroyId);
            this._dragActorSource = null;
        }
    }

    vfunc_points_began(points) {
        const point = points[0];

        if (this.get_points().length > 1) {
            this.set_state(Clutter.GestureState.CANCELLED);
            return;
        }

        this._dragStartTime = point.event_time;
        this._dragThresholdIgnored = false;
        this._dragStartX = point.begin_coords.x;
        this._dragStartY = point.begin_coords.y;

        if (!this._manualMode &&
            this.state === Clutter.GestureState.POSSIBLE)
            this._maybeStartDrag(point);
    }

    vfunc_points_moved(points) {
        const point = points[0];

        if (!this._manualMode &&
            this.state === Clutter.GestureState.POSSIBLE)
            this._maybeStartDrag(point);

        if (this.state === Clutter.GestureState.RECOGNIZING)
            this._updateDragPosition(point);
    }

    vfunc_points_ended(points) {
        const point = points[0];

        if (this.state === Clutter.GestureState.RECOGNIZING)
            this._dragActorDropped(point);

        if (this.state === Clutter.GestureState.POSSIBLE &&
            this.get_points().length === points.length) {
            // All points were removed and we're still in POSSIBLE, this means
            // we're in manual mode and nobody told us to start the drag.
            this.set_state(Clutter.GestureState.CANCELLED);
        }
    }

    vfunc_points_cancelled(points) {
        this.set_state(Clutter.GestureState.CANCELLED);
    }

    vfunc_state_changed(oldState, newState) {
        if (newState === Clutter.GestureState.RECOGNIZING)
            this._gestureRecognizing();

        if (oldState === Clutter.GestureState.RECOGNIZING &&
            newState === Clutter.GestureState.CANCELLED) {
            const cancelTime = global.get_current_time();

            this.emit('drag-cancelled', cancelTime);

            if (!this._dragActor) {
                global.display.set_cursor(Meta.Cursor.DEFAULT);
                this._dragComplete();
                this.emit('drag-end', cancelTime, false);
                if (!this._dragOrigParent && this._dragActor)
                    this._dragActor.destroy();

                return;
            }

            let [snapBackX, snapBackY, snapBackScale] = this._getRestoreLocation();

            this._animateDragEnd(cancelTime, {
                x: snapBackX,
                y: snapBackY,
                scale_x: snapBackScale,
                scale_y: snapBackScale,
                duration: SNAP_BACK_ANIMATION_TIME,
            });
        }
    }
});

/**
 * makeDraggable:
 * @param {Clutter.Actor} actor: Source actor
 * @param {Object=} params: Additional parameters
 * @returns {Object} a new Draggable
 *
 * Create an object which controls drag and drop for the given actor.
 *
 * If %manualMode is %true in @params, do not automatically start
 * drag and drop on click
 *
 * If %dragActorMaxSize is present in @params, the drag actor will
 * be scaled down to be no larger than that size in pixels.
 *
 * If %dragActorOpacity is present in @params, the drag actor will
 * will be set to have that opacity during the drag.
 *
 * Note that when the drag actor is the source actor and the drop
 * succeeds, the actor scale and opacity aren't reset; if the drop
 * target wants to reuse the actor, it's up to the drop target to
 * reset these values.
 */
function makeDraggable(actor, params) {
    const dndGesture = new DndGesture(params);
    actor.add_action(dndGesture);
    return dndGesture;
}
