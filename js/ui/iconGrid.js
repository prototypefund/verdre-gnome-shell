// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported BaseIcon, IconGrid, PaginatedIconGrid */

const { Clutter, GLib, GObject, Graphene, Meta, Pango, St } = imports.gi;

const Params = imports.misc.params;
const Main = imports.ui.main;

var ICON_SIZE = 96;
var MIN_ICON_SIZE = 16;

var EXTRA_SPACE_ANIMATION_TIME = 250;

var ANIMATION_TIME_IN = 350;
var ANIMATION_TIME_OUT = 1 / 2 * ANIMATION_TIME_IN;
var ANIMATION_MAX_DELAY_FOR_ITEM = 2 / 3 * ANIMATION_TIME_IN;
var ANIMATION_BASE_DELAY_FOR_ITEM = 1 / 4 * ANIMATION_MAX_DELAY_FOR_ITEM;
var ANIMATION_MAX_DELAY_OUT_FOR_ITEM = 2 / 3 * ANIMATION_TIME_OUT;
var ANIMATION_FADE_IN_TIME_FOR_ITEM = 1 / 4 * ANIMATION_TIME_IN;

var ANIMATION_BOUNCE_ICON_SCALE = 1.1;

var AnimationDirection = {
    IN: 0,
    OUT: 1,
};

var APPICON_ANIMATION_OUT_SCALE = 3;
var APPICON_ANIMATION_OUT_TIME = 250;

var IconGridLayout = GObject.registerClass({
    Signals: {
        'children-layout': {},
    },
}, class IconGridLayout extends Clutter.LayoutManager {
  _init(params) {
    super._init(params);

    // The horizontal spacing
    this._hSpacing = 70;

    // The vertical spacing
    this._vSpacing = 70;

    // The percentage we allow items to expand vertically into the bottom-spacing,
    // to use this `_defaultItemHeight` has to be set.
    this._maxExpandIntoVSpacing = 0.4;

    // The amount of icons to try to fit into the layout when filling the whole
    // allocation (x_align and y_align are both set to Clutter.ActorAlign.FILL).
    // In this case the spacing properties are not used, but a dynamically
    // calculated spacing is used instead.
    this._nLayoutItems = 24;

    // The default height of an item needed when expanding items into the
    // vertical spacing or when filling the whole allocation.
    this._defaultItemHeight = 0;
  }

  getItemWidth(container) {
      // We allocate the minimum width of children and use the same width for
      // all children...
      let firstChild = container.get_first_child();
      if (!firstChild)
          return 0;

      // TODO: This is a hack :(
      let [,natH] = firstChild.get_preferred_height(-1);
      this._defaultItemHeight = natH;

      return firstChild.get_preferred_width(-1)[0];
  }

  getVisibleChildren(container) {
      return container.get_children().filter(i => i.visible)
  }

  nColumnsForWidth(container, rowWidth) {
    let childWidth = this.getItemWidth(container);
    let curWidth = 0;
    let nChildren = 0;

    if (childWidth === 0)
        return 0;

    while (curWidth + childWidth <= rowWidth) {
        curWidth += childWidth + this._hSpacing;
        nChildren++;
    }

    return nChildren;
  }

  _calculateHSpacing(container, forWidth) {
    let childWidth = this.getItemWidth(container);
    let nChildren = container.get_n_children();
    let nChildrenPerRow = this.nColumnsForWidth(container, forWidth);
    let combinedChildrenWidthPerRow = childWidth * nChildrenPerRow;

    // Special case: Only one child fits in, here we want to return 0
    if (nChildrenPerRow == 1)
        return 0;

    let unusedWidth = forWidth - combinedChildrenWidthPerRow;
    let spacing = unusedWidth / (nChildrenPerRow - 1);

    return spacing;
  }

  /* I don't know yet what's the best thing to return by default in the
   * get_preferred_width/height functions, a few options would be:
   * 1) A square layout of icons (could be done using sqrt(nIcons)). This would
   *    have the benefit of returning something useful without any fixed
   *    dimensions, the downside is obviously that we have to calculate a
   *    squareroot (is it that expensive though?)...
   * 2) A single row/column for get_preferred_width() and get_preferred_height()
   * 3) Nothing, i.e. [0, 0]. While this is the easiest and resource friendliest
   *    solution, it feels wrong and will probably haunt us...
   */
  vfunc_get_preferred_width(container, forHeight) {
    let childWidth = this.getItemWidth(container);
    let natWidth = 0;

    // Let's go with option 2) for now here, this always returns the width of a
    // single row with all items in it.
    this.getVisibleChildren(container).forEach((child, i) => {
        if (this._nLayoutItems > 0 && i > this._nLayoutItems &&
            container.get_x_align() == Clutter.ActorAlign.FILL &&
            container.get_y_align() == Clutter.ActorAlign.FILL)
            return;

        natWidth += childWidth + this._hSpacing;
    });

    natWidth -= this._hSpacing;

    return [childWidth, natWidth];
  }

  vfunc_get_preferred_height(container, forWidth) {
    let childWidth = this.getItemWidth(container);
    let curWidth = 0;
    let minHeight = 0;
    let natHeight = 0;
    let rowMinHeight = 0;
    let rowNatHeight = 0;

    // If no forWidth is given, this returns the height of a single row with
    // all items in it.
    this.getVisibleChildren(container).forEach((child, i) => {
        if (this._nLayoutItems > 0 && i > this._nLayoutItems &&
            container.get_x_align() == Clutter.ActorAlign.FILL &&
            container.get_y_align() == Clutter.ActorAlign.FILL)
            return;

        let [childMinHeight, childNatHeight] = this._defaultItemHeight > 0
            ? [this._defaultItemHeight, this._defaultItemHeight]
            : child.get_preferred_height(childWidth);

        if (curWidth + childWidth > forWidth) {
            minHeight += rowMinHeight + this._vSpacing;
            natHeight += rowNatHeight + this._vSpacing;

            curWidth = rowMinHeight = rowNatHeight = 0;
        }

        curWidth += childWidth + this._hSpacing;

        rowMinHeight = Math.max(rowMinHeight, childMinHeight);
        rowNatHeight = Math.max(rowNatHeight, childNatHeight);
    });

    minHeight += rowMinHeight;
    natHeight += rowNatHeight;

    return [minHeight, natHeight];
  }

  _calculateFillLayout(width, height, nItems) {
    let aspectRatio = width / height;
    let lastNCols = 0;
    let lastNRows = 0;
    let lastLayoutARDiff = Infinity;

    /* A small algorithm to find the best number of rows and colums for a given
     * aspect ratio: Try different layouts starting with 1 column and
     * (nItems / 1) rows and calculate the difference between the given aspect
     * ratio and the layout aspect ratio. Do this until the difference doesn't
     * get smaller anymore, but starts growing, which means the last layout we
     * calculated was the best one.
     */
    for (let nCols = 1; nCols <= nItems; nCols++) {
        let nRows = nItems / nCols;
        if (!Number.isInteger(nRows))
            continue;

        let layoutARDiff = Math.abs(aspectRatio - (nCols / nRows));

        if (layoutARDiff > lastLayoutARDiff)
            break;

        lastNCols = nCols;
        lastNRows = nRows;
        lastLayoutARDiff = layoutARDiff;
    }

    return [lastNCols, lastNRows];
  }

  _calculateFillSpacing(childWidth, childHeight, width, height, nItems) {
    let [nCols, nRows] = this._calculateFillLayout(width, height, nItems);

    let combinedChildrenWidthPerRow = childWidth * nCols;
    let combinedChildrenHeightPerCol = childHeight * nRows;

    let unusedWidth = width - combinedChildrenWidthPerRow;
    let unusedHeight = height - combinedChildrenHeightPerCol;

    let hSpacing = unusedWidth / (nCols - 1);
    let vSpacing = unusedHeight / (nRows - 1);

    /* In case expand into vSpacing is allowed, make sure the last row can also
     * expand. We do this by assuming one row (the last row) always expands by
     * the allowed expansion height and then recalculating the vSpacing. This
     * is not too great in case items in the last row don't actually expand
     * that much, because then we have bottom padding.
     */
    if (this._maxExpandIntoVSpacing > 0) {
        let allowedExpansionHeight = Math.floor(vSpacing * this._maxExpandIntoVSpacing);
        unusedHeight -= allowedExpansionHeight;
        vSpacing = unusedHeight / (nRows - 1);
    }

    return [hSpacing, vSpacing];
  }

  vfunc_allocate(container, box, flags) {
    if (container.get_request_mode() != Clutter.RequestMode.HEIGHT_FOR_WIDTH)
        throw new GObject.NotImplementedError("Currently, only the WIDTH_FOR_HEIGHT " +
                                              "request mode is implemented.");

    let availWidth = box.x2 - box.x1;
    let availHeight = box.y2 - box.y1;

    let childBox = new Clutter.ActorBox();
    childBox.x1 = box.x1;
    childBox.y1 = box.y1;
    let nextRowY1 = box.y1;

    let childWidth = this.getItemWidth(container);
    let hSpacing, vSpacing;

    if (this._nLayoutItems > 0 &&
        container.get_x_align() == Clutter.ActorAlign.FILL &&
        container.get_y_align() == Clutter.ActorAlign.FILL) {
        // Right now we use `this._defaultItemHeight` as the height when
        // calculating the layout to fill the allocation and just fail if it
        // isn't set. We could also find the smallest item in the container
        // and use that to calculate the layout.
        if (this._defaultItemHeight == 0)
            throw new Error("this._defaultItemHeight needs to be set for fill requests.");

        [hSpacing, vSpacing] = this._calculateFillSpacing(childWidth,
            this._defaultItemHeight, availWidth, availHeight, this._nLayoutItems);
    } else {
        hSpacing = this._calculateHSpacing(container, availWidth);
        vSpacing = this._vSpacing;
    }

    this.getVisibleChildren(container).forEach(child => {
        let [childMinHeight, childNatHeight] =
            child.get_preferred_height(childWidth);

        if (childBox.x1 + childWidth > box.x1 + availWidth) {
            childBox.x1 = box.x1;

            // The spacing we apply to the next row might make this a float and
            // we don't want that, because it will introduce float precision issues.
            // TODO: figure out a way where the errors don't add up...
            childBox.y1 = Math.floor(nextRowY1);
        }
  
        childBox.x2 = childBox.x1 + childWidth;
        childBox.y2 = childBox.y1 + childNatHeight;

        // Limit the allocations of the last row to the container size
        if (childBox.y2 > box.y2)
            childBox.y2 = box.y2;

        /* Okay, this might look a little weird, some explanation:
         * We want to allow items with extraordinary heights to expand
         * vertically into the spacing underneath them. This is only
         * possible if we're given a reference height for items (this._defaultItemHeight).
         * Using this, we can check how far the item expands into the
         * spacing underneath it.
         */
        let defaultChildY2 = childBox.y1 + this._defaultItemHeight;
        let allowedExpansionHeight = Math.floor(vSpacing * this._maxExpandIntoVSpacing);

        // If the item expands more than allowed, just limit the allocation to
        // the allowed expansion height. This means we never fall into case 2)
        // in the next check and the vSpacing is always the same.
        if (this._defaultItemHeight > 0 && this._maxExpandIntoVSpacing > 0 &&
            childBox.y2 - defaultChildY2 > allowedExpansionHeight)
            childBox.y2 = defaultChildY2 + allowedExpansionHeight;

        child.allocate(childBox, flags);

        // Same here as with the Math.floor() of childBox.y1: We don't want to
        // have a float value here...
        // TODO: figure out a way where the errors don't add up...
        childBox.x1 = Math.floor(childBox.x2 + hSpacing);

        /* If expand into vSpacing is used, we set the start of the next row
         * like this:
         * 1) If the items y2 value is inside the `_maxExpandIntoVSpacing` threshold,
         *    act as if it didn't expand and let the next row start after the
         *    same spacing as "normal" rows (ie. use `_defaultItemHeight` as the
         *    item height).
         * 2) If the item is outside the threshold, ensure a proper vertical
         *    spacing and apply `vSpacing` to y2 of the expanded item.
         */
        if (this._defaultItemHeight > 0 && this._maxExpandIntoVSpacing &&
            childBox.y2 - defaultChildY2 <= allowedExpansionHeight)
            nextRowY1 = Math.max(nextRowY1, defaultChildY2 + vSpacing);
        else
            nextRowY1 = Math.max(nextRowY1, childBox.y2 + vSpacing);
    });

    this.emit('children-layout');
  }
});

var BaseIcon = GObject.registerClass(
class BaseIcon extends St.BoxLayout {
    _init(label, params) {
        params = Params.parse(params, { createIcon: null,
                                        setSizeManually: false,
                                        showLabel: true });

        let styleClass = 'overview-icon';
        if (params.showLabel)
            styleClass += ' overview-icon-with-label';

        super._init({ style_class: styleClass,
                      x_expand: true, y_expand: true,
                      vertical: true });

        this.connect('destroy', this._onDestroy.bind(this));

        this.iconSize = ICON_SIZE;
        this._iconBin = new St.Bin();

        this.add_actor(this._iconBin);

        if (params.showLabel) {
            this.label = new St.Label({ text: label });
            this.label.clutter_text.set({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.label.clutter_text.line_wrap = true;
            this.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
            this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            this.add_actor(this.label);
        } else {
            this.label = null;
        }

        if (params.createIcon)
            this.createIcon = params.createIcon;
        this._setSizeManually = params.setSizeManually;

        this.icon = null;

        let cache = St.TextureCache.get_default();
        this._iconThemeChangedId = cache.connect('icon-theme-changed', this._onIconThemeChanged.bind(this));
    }

    vfunc_allocate(box, flags) {
        let contentBox = this.get_theme_node().get_content_box(box);
        let paddingBottom = box.y2 - contentBox.y2;

        super.vfunc_allocate(box,flags);

        if (this.label)
            box.y2 = this.label.allocation.y2 + paddingBottom;

        this.set_allocation(box, flags);
    }

    // This can be overridden by a subclass, or by the createIcon
    // parameter to _init()
    createIcon(_size) {
        throw new GObject.NotImplementedError(`createIcon in ${this.constructor.name}`);
    }

    setIconSize(size) {
        if (!this._setSizeManually)
            throw new Error('setSizeManually has to be set to use setIconSize');

        if (size == this.iconSize)
            return;

        this._createIconTexture(size);
    }

    _createIconTexture(size) {
        if (this.icon)
            this.icon.destroy();
        this.iconSize = size;
        this.icon = this.createIcon(this.iconSize);

        this._iconBin.child = this.icon;
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        let node = this.get_theme_node();

        let size;
        if (this._setSizeManually) {
            size = this.iconSize;
        } else {
            let [found, len] = node.lookup_length('icon-size', false);
            size = found ? len : ICON_SIZE;
        }

        if (this.iconSize == size && this._iconBin.child)
            return;

        this._createIconTexture(size);
    }

    _onDestroy() {
        if (this._iconThemeChangedId > 0) {
            let cache = St.TextureCache.get_default();
            cache.disconnect(this._iconThemeChangedId);
            this._iconThemeChangedId = 0;
        }
    }

    _onIconThemeChanged() {
        this._createIconTexture(this.iconSize);
    }

    animateZoomOut() {
        // Animate only the icon instead of the entire actor, so the
        // styles like hover and running are not applied while animating.
        zoomOutActor(this._iconBin);
    }

    animateZoomOutAtPos(x, y) {
        zoomOutActorAtPos(this.child, x, y);
    }

    update() {
        this._createIconTexture(this.iconSize);
    }
});

function clamp(value, min, max) {
    return Math.max(Math.min(value, max), min);
}

function zoomOutActor(actor) {
    let [x, y] = actor.get_transformed_position();
    zoomOutActorAtPos(actor, x, y);
}

function zoomOutActorAtPos(actor, x, y) {
    let actorClone = new Clutter.Clone({ source: actor,
                                         reactive: false });
    let [width, height] = actor.get_transformed_size();

    actorClone.set_size(width, height);
    actorClone.set_position(x, y);
    actorClone.opacity = 255;
    actorClone.set_pivot_point(0.5, 0.5);

    Main.uiGroup.add_actor(actorClone);

    // Avoid monitor edges to not zoom outside the current monitor
    let monitor = Main.layoutManager.findMonitorForActor(actor);
    let scaledWidth = width * APPICON_ANIMATION_OUT_SCALE;
    let scaledHeight = height * APPICON_ANIMATION_OUT_SCALE;
    let scaledX = x - (scaledWidth - width) / 2;
    let scaledY = y - (scaledHeight - height) / 2;
    let containedX = clamp(scaledX, monitor.x, monitor.x + monitor.width - scaledWidth);
    let containedY = clamp(scaledY, monitor.y, monitor.y + monitor.height - scaledHeight);

    actorClone.ease({
        scale_x: APPICON_ANIMATION_OUT_SCALE,
        scale_y: APPICON_ANIMATION_OUT_SCALE,
        translation_x: containedX - scaledX,
        translation_y: containedY - scaledY,
        opacity: 0,
        duration: APPICON_ANIMATION_OUT_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => actorClone.destroy(),
    });
}

var IconGrid = GObject.registerClass(
class IconGrid extends St.Widget {
    _init() {
        super._init({ style_class: 'icon-grid' });

        this._noAnimationIndexes = [];
        this._animationStartIndex = -1;

        this.layout_manager = new IconGridLayout();
        this.layout_manager.connect('children-layout', () => {
            this._animationStartIndex = -1;
            this._noAnimationIndexes = []
        });;
    }

    visibleItemsCount() {
        return this.get_children().filter(c => c.visible).length;
    }

    removeAll() {
        this.remove_all_children();
    }

    destroyAll() {
        this.destroy_all_children();
    }

    _getAnimationDelayForIndex(index) {
        if (this._animationStartIndex == -1)
            return 0;

        let distanceFromChangedItem = Math.abs(this._animationStartIndex - index);
        return distanceFromChangedItem * 20;
    }

    _getTotalAnimationDurationForIndex(index) {
        return this._getAnimationDelayForIndex(index) + 350;
    }

    _onItemPositionChanged(item) {
        let newAllocation = item.allocation;

        if (item._oldAllocation) {
            let diffX = newAllocation.x1 - item._oldAllocation.x1;
            let diffY = newAllocation.y1 - item._oldAllocation.y1;

            let childIndex = this.get_children().indexOf(item);

            if (!this._noAnimationIndexes.includes(childIndex)) {
                // Add to the old translation in case an animation is already ongoing
                item.translation_x += -diffX;
                item.translation_y += -diffY;

                item.ease({
                    translation_x: 0,
                    translation_y: 0,
                    duration: 350,
                    delay: this._getAnimationDelayForIndex(childIndex),
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    onStopped: () => {
                        item.translation_x = item.translation_y = 0;
                    },
                });
            }
        }

        item._oldAllocation = newAllocation;
    }

    _setAnimationStart(changedIndex) {
        if (this._animationStartIndex == -1)
            this._animationStartIndex = changedIndex;
        else
            this._animationStartIndex = Math.min(this._animationStartIndex, changedIndex);
    }

    addItem(item, index = this.get_n_children()) {
        this._noAnimationIndexes = this._noAnimationIndexes.map(i =>
            index <= i ? i + 1 : i);

        this._noAnimationIndexes.push(index);
        this._setAnimationStart(index);

        this.insert_child_at_index(item, index);

        item._oldAllocation = item.allocation;
        item._notifyPositionId = item.connect('notify::position',
            this._onItemPositionChanged.bind(this));

        item.set_pivot_point(0.5, 0.5);

        // If the new item is at the last index, use the normal delay, if
        // there are items after it, wait for the next item to finish its
        // animation until we start fading in.
        let delay = index == this.get_n_children()
            ? this._getAnimationDelayForIndex(index)
            : this._getTotalAnimationDurationForIndex(index + 1);

        item.opacity = 0;
        item.scale_x = 0.3;
        item.scale_y = 0.3;
        item.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 250,
            delay,
        });
    }

    moveItem(item, newIndex = 0) {
        let oldIndex = this.get_children().indexOf(item);
        if (oldIndex == -1)
            return;

        this._noAnimationIndexes = this._noAnimationIndexes.map(i =>
            newIndex <= i ? i + 1 : i);

        this._noAnimationIndexes.push(newIndex);
        this._setAnimationStart(Math.min(oldIndex, newIndex));

        this.set_child_at_index(item, newIndex);     

        // TODO: remove the fade-in animation here, this is just for testing
        let delay = newIndex == this.get_n_children()
            ? this._getAnimationDelayForIndex(newIndex)
            : this._getTotalAnimationDurationForIndex(newIndex + 1);

        item.opacity = 0;
        item.scale_x = 0.3;
        item.scale_y = 0.3;
        item.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 250,
            delay,
        });
    }

    removeItem(item) {
        let index = this.get_children().indexOf(item);
        if (index == -1)
            return;

        this._setAnimationStart(index);

        item.disconnect(item._notifyPositionId);
        delete item._notifyPositionId;
        delete item._oldAllocation;

        item.ease({
            opacity: 0,
            scale_x: 0.3,
            scale_y: 0.3,
            duration: 250,
            onStopped: () => this.remove_actor(item),
        });
    }

    nColumnsForWidth(width) {
        return this.layout_manager.nColumnsForWidth(this, width);
    }
});

