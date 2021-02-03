// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported Workspace */

const { Clutter, GLib, GObject, Meta, St } = imports.gi;

const Background = imports.ui.background;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const Params = imports.misc.params;
const Util = imports.misc.util;
const { WindowPreview } = imports.ui.windowPreview;

var WINDOW_PREVIEW_MAXIMUM_SCALE = 0.95;
var MAXIMUM_PREVIEW_AREA = 0.98;

var WINDOW_REPOSITIONING_DELAY = 750;

var WINDOW_ANIMATION_MAX_NUMBER_BLENDING = 3;

// Window Thumbnail Layout Algorithm
// =================================
//
// General overview
// ----------------
//
// The window thumbnail layout algorithm calculates some optimal layout
// by computing layouts with some number of rows, calculating how good
// each layout is, and stopping iterating when it finds one that is worse
// than the previous layout. A layout consists of which windows are in
// which rows, row sizes and other general state tracking that would make
// calculating window positions from this information fairly easy.
//
// After a layout is computed that's considered the best layout, we
// compute the layout scale to fit it in the area, and then compute
// slots (sizes and positions) for each thumbnail.
//
// Layout generation
// -----------------
//
// Layout generation is naive and simple: we simply add windows to a row
// until we've added too many windows to a row, and then make a new row,
// until we have our required N rows. The potential issue with this strategy
// is that we may have too many windows at the bottom in some pathological
// cases, which tends to make the thumbnails have the shape of a pile of
// sand with a peak, with one window at the top.
//
// Scaling factors
// ---------------
//
// Thumbnail position is mostly straightforward -- the main issue is
// computing an optimal scale for each window that fits the constraints,
// and doesn't make the thumbnail too small to see. There are two factors
// involved in thumbnail scale to make sure that these two goals are met:
// the window scale (calculated by _computeWindowScale) and the layout
// scale (calculated by computeSizeAndScale).
//
// The calculation logic becomes slightly more complicated because row
// and column spacing are not scaled, they're constant, so we can't
// simply generate a bunch of window positions and then scale it. In
// practice, it's not too bad -- we can simply try to fit the layout
// in the input area minus whatever spacing we have, and then add
// it back afterwards.
//
// The window scale is constant for the window's size regardless of the
// input area or the layout scale or rows or anything else, and right
// now just enlarges the window if it's too small. The fact that this
// factor is stable makes it easy to calculate, so there's no sense
// in not applying it in most calculations.
//
// The layout scale depends on the input area, the rows, etc, but is the
// same for the entire layout, rather than being per-window. After
// generating the rows of windows, we basically do some basic math to
// fit the full, unscaled layout to the input area, as described above.
//
// With these two factors combined, the final scale of each thumbnail is
// simply windowScale * layoutScale... almost.
//
// There's one additional constraint: the thumbnail scale must never be
// larger than WINDOW_PREVIEW_MAXIMUM_SCALE, which means that the inequality:
//
//   windowScale * layoutScale <= WINDOW_PREVIEW_MAXIMUM_SCALE
//
// must always be true. This is for each individual window -- while we
// could adjust layoutScale to make the largest thumbnail smaller than
// WINDOW_PREVIEW_MAXIMUM_SCALE, it would shrink windows which are already
// under the inequality. To solve this, we simply cheat: we simply keep
// each window's "cell" area to be the same, but we shrink the thumbnail
// and center it horizontally, and align it to the bottom vertically.

var LayoutStrategy = class {
    constructor(params) {
        params = Params.parse(params, {
            monitor: null,
            rowSpacing: 0,
            columnSpacing: 0,
        });

        if (!params.monitor)
            throw new Error(`No monitor param passed to ${this.constructor.name}`);

        this._monitor = params.monitor;
        this._rowSpacing = params.rowSpacing;
        this._columnSpacing = params.columnSpacing;
    }

    // Compute a strategy-specific overall layout given a list of WindowPreviews
    // @windows and the strategy-specific @layoutParams.
    //
    // Returns a strategy-specific layout object that is opaque to the user.
    computeLayout(_windows, _layoutParams) {
        throw new GObject.NotImplementedError(`computeLayout in ${this.constructor.name}`);
    }

    // Returns an array with final position and size information for each
    // window of the layout, given a bounding area that it will be inside of.
    computeWindowSlots(_layout, _area) {
        throw new GObject.NotImplementedError(`computeWindowSlots in ${this.constructor.name}`);
    }

    computeOccupiedSpace(layout, area) {
        const slots = this.computeWindowSlots(layout, area);

        let space = 0;
        slots.forEach(s => { space = s[2] * s[3]; });

        return space;
    }
};

const OUTER_SIZES_REDUCTION_FACTOR = 0.20;
const MIN_OUTER_SIZE = 0.6;

// This function creates an array and will distribute the size that's passed
// across n rows or cols, creating an elliptical shape. For example passing
// a num of seven rows will distribute sizes in a shape like this:
//
//   **
//   **
//  ****
// ******
//  ****
//   **
//   **
function distributeSizes(num, fullSize) {
    if (num === 1)
        return [1];

    let curVal = 100;
    const reductionFactor = 100 * OUTER_SIZES_REDUCTION_FACTOR;
    const minVal = 100 * MIN_OUTER_SIZE;
    let ret;

    if (num % 2 === 0) {
        ret = [curVal, curVal];
        num -= 2;
    } else {
        ret = [curVal];
        num -= 1;
    }

    for (let i = 0; i < Math.floor(num / 2); i++) {
        if (curVal - reductionFactor >= minVal)
            curVal -= reductionFactor;

        ret.unshift(curVal);
        ret.push(curVal);
    }

    const totalSum = ret.reduce((accumulator, curVal) => accumulator + curVal, 0);
    ret = ret.map(v => (v / totalSum) * fullSize);

    return ret;
}

function newRowOrCol() {
    // * x, y are the position of row, relative to area
    // * width, height are the scaled versions of fullWidth, fullHeight
    // * width also has the spacing in between windows. It's not in
    //   fullWidth, as the spacing is constant, whereas fullWidth is
    //   meant to be scaled
    // * neither height/fullHeight have any sort of spacing or padding
    return {
        x: 0,
        y: 0,
        fullWidth: 0,
        fullHeight: 0,
        scaledWidth: 0,
        scaledHeight: 0,
        windows: [],
    };
};

function keepSameRowOrCol(curWidth, extraWidth, idealWidth) {
    // If the new window fits inside the idealWidth, perfect
    if (curWidth + extraWidth <= idealWidth)
        return true;

    const oldRatio = curWidth / idealWidth;
    const newRatio = (curWidth + extraWidth) / idealWidth;

    // Check if the row with the new window gets closer to the idealWidth
    // than without it. If it does, we add the window to the row.
    if (Math.abs(1 - newRatio) <= Math.abs(1 - oldRatio))
        return true;

    return false;
}

var UnalignedHorizontalLayoutStrategy = class extends LayoutStrategy {
    // Computes and returns an individual scaling factor for @window,
    // to be applied in addition to the overall layout scale.
    _computeWindowScale(window) {
        // Since we align windows next to each other, the height of the
        // thumbnails is much more important to preserve than the width of
        // them, so two windows with equal height, but maybe differering
        // widths line up.
        let ratio = window.boundingBox.height / this._monitor.height;

        // The purpose of this manipulation here is to prevent windows
        // from getting too small. For something like a calculator window,
        // we need to bump up the size just a bit to make sure it looks
        // good. We'll use a multiplier of 1.5 for this.

        // Map from [0, 1] to [1.5, 1]
        return Util.lerp(1.5, 1, ratio);
    }

    _sortRow(row) {
        // Sort windows horizontally to minimize travel distance.
        // This affects in what order the windows end up in a row.
        row.windows.sort((a, b) => a.windowCenter.x - b.windowCenter.x);
    }

    _addWindowToRow(window, row, width, height) {
        row.windows.push(window);
        row.fullWidth += width;
        row.fullHeight = Math.max(row.fullHeight, height);
    }

    _chooseRowForWindow(curRow, nextRow, curWindow, windows, idealRowWidth) {
        const s = this._computeWindowScale(curWindow);
        const width = curWindow.boundingBox.width * s;
        const height = curWindow.boundingBox.height * s;

        if (!nextRow || keepSameRowOrCol(curRow.fullWidth, width, idealRowWidth)) {
            this._addWindowToRow(curWindow, curRow, width, height);
            return false;
        }

        // Try squeezing a few more windows into the current row
        windows.forEach(w => {
            const wScale = this._computeWindowScale(w);
            const wWidth = w.boundingBox.width * wScale
            const wHeight = w.boundingBox.height * wScale;

            if (keepSameRowOrCol(curRow.fullWidth, wWidth, idealRowWidth)) {
                this._addWindowToRow(w, curRow, wWidth, wHeight);
                windows.splice(windows.indexOf(w), 1);
            }
        });

        this._addWindowToRow(curWindow, nextRow, width, height);
        return true;
    }

    computeLayout(windows, layoutParams) {
        layoutParams = Params.parse(layoutParams, {
            numRows: 0,
        });

        if (layoutParams.numRows === 0)
            throw new Error(`${this.constructor.name}: No numRows given in layout params`);

        const numRows = layoutParams.numRows;

        windows = windows.slice();

        let totalWidth = 0;
        let maximizedWindows = [];
        let widthWithoutMaximized = 0;
        windows = windows.filter(w => {
            const width = w.boundingBox.width * this._computeWindowScale(w);
            totalWidth += width;

            if (w.metaWindow.maximized_horizontally &&
                w.metaWindow.maximized_vertically) {
                maximizedWindows.push(w);
                return false;
            }

            widthWithoutMaximized += width;
            return true;
        });

        const idealRowWidths = distributeSizes(numRows, totalWidth);

        // We will split all the windows into two parts judging by their
        // vertical position.
        let topPart = [];
        let topPartWidth = 0;
        let bottomPart = [];

        windows.sort((a, b) => a.windowCenter.y - b.windowCenter.y);
        windows.forEach(w => {
            const width = w.boundingBox.width * this._computeWindowScale(w);

            if (!keepSameRowOrCol(topPartWidth, width, widthWithoutMaximized / 2)) {
                bottomPart.push(w);
                return;
            }

            topPart.push(w);
            topPartWidth += width;
        });

        // Spread maximized windows equally across the topPart and bottomPart.
        // We do this because (in case a lot of non-maximized windows are in
        // one half of the monitor) it might happen that one part has no
        // maximized windows at all, while the other part has all of them.
        // So the idea here is to ensure the center colums will get filled
        // with the maximized windows in the end.
        const startWithTopPart = topPartWidth < widthWithoutMaximized / 2;

        maximizedWindows.forEach((w, i) => {
            const width = w.boundingBox.width * this._computeWindowScale(w);

            if (i % 2 === (startWithTopPart ? 0 : 1)) {
                topPart.push(w);
                topPartWidth += width;
            } else {
                bottomPart.push(w);
            }
        });

        // We've now prepared the topPart and the bottomPart, now sort both
        // by descending window size.
        topPart.sort((a, b) =>
            b.boundingBox.width * b.boundingBox.height -
            a.boundingBox.width * a.boundingBox.height);
        bottomPart.sort((a, b) =>
            b.boundingBox.width * b.boundingBox.height -
            a.boundingBox.width * a.boundingBox.height);

        // Prepare the rows array, figure out the center row and then finally
        // loop through the topPart and bottomPart in an alternating manner,
        // adding windows starting from the center row.
        let rows = [];
        for (let i = 0; i < numRows; i++)
            rows.push(newRowOrCol());

        const hasSingleCenterRow = numRows % 2 === 1;
        const centerRowIndex = Math.floor(numRows / 2);

        let rowsUpIndex = centerRowIndex;
        let rowsDownIndex = centerRowIndex;
        if (!hasSingleCenterRow && centerRowIndex !== 0)
            rowsUpIndex -= 1;

        // One more thing: If there's a single center row we fill that row
        // by alternating between windows from the topPart and the bottomPart.
        // Now in case the bottomPart is larger than the topPart, we want to try
        // putting more windows of the bottomPart into the center row, so in
        // that case start the process by taking a window from the bottomPart.
        const startWithBottomWindow =
            hasSingleCenterRow && topPartWidth < totalWidth / 2;

        let curTopWindow = topPart.shift();
        let curBottomWindow = bottomPart.shift();
        while (curTopWindow || curBottomWindow) {
            if (!startWithBottomWindow) {
                if (curTopWindow) {
                    const curRow = rows[rowsUpIndex];
                    const nextRow = rowsUpIndex === 0 ? null : rows[rowsUpIndex - 1];

                    if (this._chooseRowForWindow(curRow, nextRow, curTopWindow,
                                                 topPart, idealRowWidths[rowsUpIndex]))
                        rowsUpIndex -= 1;

                    curTopWindow = topPart.shift();
                }
            }

            if (curBottomWindow) {
                const curRow = rows[rowsDownIndex];
                const nextRow = rowsDownIndex === 0 ? null : rows[rowsDownIndex + 1];

                if (this._chooseRowForWindow(curRow, nextRow, curBottomWindow,
                                             bottomPart, idealRowWidths[rowsDownIndex]))
                    rowsDownIndex += 1;

                curBottomWindow = bottomPart.shift();
            }

            if (startWithBottomWindow) {
                if (curTopWindow) {
                    const curRow = rows[rowsUpIndex];
                    const nextRow = rowsUpIndex === 0 ? null : rows[rowsUpIndex - 1];

                    if (this._chooseRowForWindow(curRow, nextRow, curTopWindow,
                                                 topPart, idealRowWidths[rowsUpIndex]))
                        rowsUpIndex -= 1;

                    curTopWindow = topPart.shift();
                }
            }
        }

        let gridHeight = 0;
        let maxRow;
        for (const row of rows) {
            this._sortRow(row);

            if (!maxRow || row.fullWidth > maxRow.fullWidth)
                maxRow = row;
            gridHeight += row.fullHeight;
        }

        return {
            numRows,
            rows,
            maxColumns: maxRow.windows.length,
            gridWidth: maxRow.fullWidth,
            gridHeight,
        };
    }

    computeWindowSlots(layout, area) {
        if (layout.gridWidth === 0 || layout.gridHeight === 0)
            return [];

        let { rows } = layout;

        const hspacing = (layout.maxColumns - 1) * this._columnSpacing;
        const vspacing = (layout.numRows - 1) * this._rowSpacing;

        const spacedWidth = area.width - hspacing;
        const spacedHeight = area.height - vspacing;

        const horizontalScale = spacedWidth / layout.gridWidth;
        const verticalScale = spacedHeight / layout.gridHeight;

        const scale = Math.min(horizontalScale, verticalScale);

        for (const row of rows) {
            row.scaledWidth = row.fullWidth * scale;
            row.scaledHeight = row.fullHeight * scale;
        }

        let slots = [];

        const verticalSpacing = (rows.length - 1) * this._rowSpacing;
        const additionalVerticalScale =
            Math.min(1, (area.height - verticalSpacing) / (layout.gridHeight * scale));

        // keep track how much smaller the grid becomes due to scaling
        // so it can be centered again
        let compensation = 0;
        let y = 0;

        for (const row of rows) {
            // If this window layout row doesn't fit in the actual
            // geometry, then apply an additional scale to it.
            const horizontalSpacing = (row.windows.length - 1) * this._columnSpacing;
            const additionalHorizontalScale =
                Math.min(1, (area.width - horizontalSpacing) / row.scaledWidth);

            if (additionalHorizontalScale < additionalVerticalScale) {
                row.additionalScale = additionalHorizontalScale;

                // Only consider the scaling in addition to the vertical scaling for centering.
                compensation += (additionalVerticalScale - additionalHorizontalScale) * row.scaledHeight;
            } else {
                row.additionalScale = additionalVerticalScale;

                // No compensation when scaling vertically since centering based on a too large
                // height would undo what vertical scaling is trying to achieve.
            }

            row.x = area.x + (Math.max(area.width - (row.scaledWidth * row.additionalScale + horizontalSpacing), 0) / 2);
            row.y = area.y + (Math.max(area.height - (layout.gridHeight * scale + verticalSpacing), 0) / 2) + y;
            y += row.scaledHeight * row.additionalScale + this._rowSpacing;
        }

        compensation /= 2;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowY = row.y + compensation;
            const rowHeight = row.scaledHeight * row.additionalScale;
            let x = row.x;

            for (const window of row.windows) {
                let s = scale * this._computeWindowScale(window) * row.additionalScale;
                const cellWidth = window.boundingBox.width * s;
                const cellHeight = window.boundingBox.height * s;

                s = Math.min(s, WINDOW_PREVIEW_MAXIMUM_SCALE);
                const cloneWidth = window.boundingBox.width * s;
                const cloneHeight = window.boundingBox.height * s;

                let cloneX = x + (cellWidth - cloneWidth) / 2;
                let cloneY;

                // If there's only one row, align window vertically centered inside the row
                if (rows.length === 1)
                    cloneY = rowY + (rowHeight - cloneHeight) / 2;
                // If this is the top row, align window to the bottom edge of the row
                else if (i === 0)
                    cloneY = rowY + rowHeight - cellHeight
                // If this is the bottom row, align window to the top edge of the row
                else if (i === rows.length - 1)
                    cloneY = rowY;
                // For any in-between row, also align the window vertically centered inside the row
                else
                    cloneY = rowY + (rowHeight - cloneHeight) / 2;

                // Align with the pixel grid to prevent blurry windows at scale = 1
                cloneX = Math.floor(cloneX);
                cloneY = Math.floor(cloneY);

                slots.push([cloneX, cloneY, cloneWidth, cloneHeight, window]);
                x += cellWidth + this._columnSpacing;
            }
        }

        return slots;
    }
};

var UnalignedVerticalLayoutStrategy = class extends LayoutStrategy {
    _computeWindowScale(window) {
        let ratio = window.boundingBox.width / this._monitor.width;
        return Util.lerp(1.5, 1, ratio);
    }

    _addWindowToCol(window, col, width, height) {
        col.windows.push(window);
        col.fullWidth = Math.max(col.fullWidth, width);
        col.fullHeight += height;
    }

    _chooseColForWindow(curCol, nextCol, curWindow, windows, idealColHeight) {
        const s = this._computeWindowScale(curWindow);
        const width = curWindow.boundingBox.width * s;
        const height = curWindow.boundingBox.height * s;

        if (!nextCol || keepSameRowOrCol(curCol.fullHeight, height, idealColHeight)) {
            this._addWindowToCol(curWindow, curCol, width, height);
            return false;
        }

        // Try squeezing a few more windows into the current column
        windows.forEach(w => {
            const wScale = this._computeWindowScale(w);
            const wWidth = w.boundingBox.width * wScale
            const wHeight = w.boundingBox.height * wScale;

            if (keepSameRowOrCol(curCol.fullHeight, wHeight, idealColHeight)) {
                this._addWindowToCol(w, curCol, wWidth, wHeight);
                windows.splice(windows.indexOf(w), 1);
            }
        });

        this._addWindowToCol(curWindow, nextCol, width, height);
        return true;
    }

    computeLayout(windows, layoutParams) {
        layoutParams = Params.parse(layoutParams, {
            numCols: 0,
        });

        if (layoutParams.numCols === 0)
            throw new Error(`${this.constructor.name}: No numCols given in layout params`);

        const numCols = layoutParams.numCols;

        windows = windows.slice();

        let totalHeight = 0;
        let maximizedWindows = [];
        let heightWithoutMaximized = 0;
        windows = windows.filter(w => {
            const height = w.boundingBox.height * this._computeWindowScale(w);
            totalHeight += height;

            if (w.metaWindow.maximized_horizontally &&
                w.metaWindow.maximized_vertically) {
                maximizedWindows.push(w);
                return false;
            }

            heightWithoutMaximized += height;
            return true;
        });

        const idealColHeights = distributeSizes(numCols, totalHeight);

        // We will split all the windows into two parts judging by their
        // horizontal position.
        let leftPart = [];
        let leftPartHeight = 0;
        let rightPart = [];

        windows.sort((a, b) => a.windowCenter.x - b.windowCenter.x);
        windows.forEach(w => {
            const height = w.boundingBox.height * this._computeWindowScale(w);

            if (!keepSameRowOrCol(leftPartHeight, height, heightWithoutMaximized / 2)) {
                rightPart.push(w);
                return;
            }

            leftPart.push(w);
            leftPartHeight += height;
        });

        // Spread maximized windows equally across the leftPart and rightPart.
        // We do this because (in case a lot of non-maximized windows are in
        // one half of the monitor) it might happen that one part has no
        // maximized windows at all, while the other part has all of them.
        // So the idea here is to ensure the center colums will get filled
        // with the maximized windows in the end.
        const startWithLeftPart = leftPartHeight < heightWithoutMaximized / 2;

        maximizedWindows.forEach((w, i) => {
            const height = w.boundingBox.height * this._computeWindowScale(w);

            if (i % 2 === (startWithLeftPart ? 0 : 1)) {
                leftPart.push(w);
                leftPartHeight += height;
            } else {
                rightPart.push(w);
            }
        });

        // We've now prepared the leftPart and the rightPart, now sort both
        // by descending window size.
        leftPart.sort((a, b) =>
            b.boundingBox.width * b.boundingBox.height -
            a.boundingBox.width * a.boundingBox.height);
        rightPart.sort((a, b) =>
            b.boundingBox.width * b.boundingBox.height -
            a.boundingBox.width * a.boundingBox.height);

        // Create the cols array, figure out the center column index and then
        // finally loop through the leftPart and rightPart in an alternating
        // manner, adding windows starting from the center col.
        let cols = [];
        for (let i = 0; i < numCols; i++)
            cols.push(newRowOrCol());

        const hasSingleCenterCol = numCols % 2 === 1;
        const centerColIndex = Math.floor(numCols / 2);

        let colsLeftIndex = centerColIndex;
        let colsRightIndex = centerColIndex;
        if (!hasSingleCenterCol && centerColIndex !== 0)
            colsLeftIndex -= 1;

        // One more thing: If there's a single center column we fill that col
        // by alternating between windows from the leftPart and the rightPart.
        // Now in case the rightPart is larger than the leftPart, we want to try
        // putting more windows of the rightPart into the center column, so in
        // that case start the process by taking a window from the rightPart.
        const startWithRightWindow =
            hasSingleCenterCol && leftPartHeight < totalHeight / 2;

        let curLeftWindow = leftPart.shift();
        let curRightWindow = rightPart.shift();
        while (curLeftWindow || curRightWindow) {
            if (!startWithRightWindow) {
                if (curLeftWindow) {
                    const curCol = cols[colsLeftIndex];
                    const nextCol = colsLeftIndex === 0 ? null : cols[colsLeftIndex - 1];

                    if (this._chooseColForWindow(curCol, nextCol, curLeftWindow,
                                                 leftPart, idealColHeights[colsLeftIndex]))
                        colsLeftIndex -= 1;

                    curLeftWindow = leftPart.shift();
                }
            }

            if (curRightWindow) {
                const curCol = cols[colsRightIndex];
                const nextCol = colsRightIndex === 0 ? null : cols[colsRightIndex + 1];

                if (this._chooseColForWindow(curCol, nextCol, curRightWindow,
                                             rightPart, idealColHeights[colsRightIndex]))
                    colsRightIndex += 1;

                curRightWindow = rightPart.shift();
            }

            if (startWithRightWindow) {
                if (curLeftWindow) {
                    const curCol = cols[colsLeftIndex];
                    const nextCol = colsLeftIndex === 0 ? null : cols[colsLeftIndex - 1];

                    if (this._chooseColForWindow(curCol, nextCol, curLeftWindow,
                                                 leftPart, idealColHeights[colsLeftIndex]))
                        colsLeftIndex -= 1;

                    curLeftWindow = leftPart.shift();
                }
            }
        }

        let gridWidth = 0;
        let maxCol;
        for (const col of cols) {
            col.windows.sort((a, b) => a.windowCenter.y - b.windowCenter.y);

            if (!maxCol || col.fullHeight > maxCol.fullHeight)
                maxCol = col;
            gridWidth += col.fullWidth;
        }

        return {
            numCols,
            cols,
            maxRows: maxCol.windows.length,
            gridWidth,
            gridHeight: maxCol.fullHeight,
        };
    }

    computeWindowSlots(layout, area) {
        if (layout.gridWidth === 0 || layout.gridHeight === 0)
            return [];

        let { cols } = layout;

        const hspacing = (layout.numCols - 1) * this._columnSpacing;
        const vspacing = (layout.maxRows - 1) * this._rowSpacing;

        const spacedWidth = area.width - hspacing;
        const spacedHeight = area.height - vspacing;

        const horizontalScale = spacedWidth / layout.gridWidth;
        const verticalScale = spacedHeight / layout.gridHeight;

        const scale = Math.min(horizontalScale, verticalScale);

        for (const col of cols) {
            col.scaledWidth = col.fullWidth * scale;
            col.scaledHeight = col.fullHeight * scale;
        }

        let slots = [];

        const horizontalSpacing = (cols.length - 1) * this._columnSpacing;
        const additionalHorizontalScale =
            Math.min(1, (area.width - horizontalSpacing) / (layout.gridWidth * scale));

        // keep track how much smaller the grid becomes due to scaling
        // so it can be centered again
        let compensation = 0;
        let x = 0;
        for (const col of cols) {
            // If this window layout row doesn't fit in the actual
            // geometry, then apply an additional scale to it.
            const verticalSpacing = (col.windows.length - 1) * this._rowSpacing;
            const additionalVerticalScale =
                Math.min(1, (area.height - verticalSpacing) / col.scaledHeight);

            if (additionalVerticalScale < additionalHorizontalScale) {
                col.additionalScale = additionalVerticalScale;

                // Only consider the scaling in addition to the vertical scaling for centering.
                compensation += (additionalHorizontalScale - additionalVerticalScale) * col.scaledWidth;
            } else {
                col.additionalScale = additionalHorizontalScale;

                // No compensation when scaling vertically since centering based on a too large
                // height would undo what vertical scaling is trying to achieve.
            }

            col.x = area.x + Math.max(area.width - (layout.gridWidth * scale + horizontalSpacing), 0) / 2 + x;
            col.y = area.y + Math.max(area.height - (col.scaledHeight * col.additionalScale + verticalSpacing), 0) / 2;
            x += col.scaledWidth * col.additionalScale + this._columnSpacing;
        }

        compensation /= 2;

        for (let i = 0; i < cols.length; i++) {
            const col = cols[i];
            const colX = col.x + compensation;
            const colWidth = col.scaledWidth * col.additionalScale;
            let y = col.y;

            for (const window of col.windows) {
                let s = scale * this._computeWindowScale(window) * col.additionalScale;
                const cellWidth = window.boundingBox.width * s;
                const cellHeight = window.boundingBox.height * s;

                s = Math.min(s, WINDOW_PREVIEW_MAXIMUM_SCALE);
                const cloneWidth = window.boundingBox.width * s;
                const cloneHeight = window.boundingBox.height * s;

                let cloneX;
                let cloneY = y + (cellHeight - cloneHeight) / 2;

                // If there's only one col, align window horizontally centered inside the col
                if (cols.length === 1)
                    cloneX = colX + (colWidth - cloneWidth) / 2;
                // If this is the leftmost col, align window to the right edge of the col
                else if (i === 0)
                    cloneX = colX + colWidth - cellWidth;
                // If this is the rightmost col, align window to the left edge of the col
                else if (i === cols.length - 1)
                    cloneX = colX;
                // For any in-between cols, also align the window horizontally centered inside the col
                else
                    cloneX = colX + (colWidth - cloneWidth) / 2;

                // Align with the pixel grid to prevent blurry windows at scale = 1
                cloneX = Math.floor(cloneX);
                cloneY = Math.floor(cloneY);

                slots.push([cloneX, cloneY, cloneWidth, cloneHeight, window]);
                y += cellHeight + this._rowSpacing;
            }
        }

        return slots;
    }
};

function animateAllocation(actor, box) {
    if (actor.allocation.equal(box) ||
        actor.allocation.get_width() === 0 ||
        actor.allocation.get_height() === 0) {
        actor.allocate(box);
        return null;
    }

    actor.save_easing_state();
    actor.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
    actor.set_easing_duration(200);

    actor.allocate(box);

    actor.restore_easing_state();

    return actor.get_transition('allocation');
}

var WorkspaceLayout = GObject.registerClass({
    Properties: {
        'spacing': GObject.ParamSpec.double(
            'spacing', 'Spacing', 'Spacing',
            GObject.ParamFlags.READWRITE,
            0, Infinity, 20),
        'layout-frozen': GObject.ParamSpec.boolean(
            'layout-frozen', 'Layout frozen', 'Layout frozen',
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class WorkspaceLayout extends Clutter.LayoutManager {
    _init(metaWorkspace, monitorIndex) {
        super._init();

        this._spacing = 20;
        this._layoutFrozen = false;

        this._monitorIndex = monitorIndex;
        this._workarea = metaWorkspace
            ? metaWorkspace.get_work_area_for_monitor(this._monitorIndex)
            : Main.layoutManager.getWorkAreaForMonitor(this._monitorIndex);

        this._container = null;
        this._windows = new Map();
        this._sortedWindows = [];
        this._background = null;
        this._lastBox = null;
        this._windowSlots = [];
        this._layout = null;

        this._stateAdjustment = new St.Adjustment({
            value: 0,
            lower: 0,
            upper: 1,
        });

        this._stateAdjustment.connect('notify::value', () => {
            [...this._windows.keys()].forEach(
                preview => this._syncOverlay(preview));
            this.layout_changed();
        });
    }

    _adjustSpacingAndPadding(rowSpacing, colSpacing, containerBox) {
        if (this._sortedWindows.length === 0)
            return [colSpacing, rowSpacing, containerBox];

        // All of the overlays have the same chrome sizes,
        // so just pick the first one.
        const window = this._sortedWindows[0];

        const [topOversize, bottomOversize] = window.chromeHeights();
        const [leftOversize, rightOversize] = window.chromeWidths();

        const oversize =
            Math.max(topOversize, bottomOversize, leftOversize, rightOversize);

        if (rowSpacing)
            rowSpacing += oversize;
        if (colSpacing)
            colSpacing += oversize;

        if (containerBox) {
            // add some padding around preview area
            const [width, height] = containerBox.get_size();
            containerBox.set_size(
                width * MAXIMUM_PREVIEW_AREA,
                height * MAXIMUM_PREVIEW_AREA);
            containerBox.x1 += width * (1 - MAXIMUM_PREVIEW_AREA) / 2;
            containerBox.y1 += height * (1 - MAXIMUM_PREVIEW_AREA) / 2;

            const [topOverlap, bottomOverlap] = window.overlapHeights();
            containerBox.x1 += oversize + topOverlap;
            containerBox.x2 -= oversize;
            containerBox.y1 += oversize;
            containerBox.y2 -= oversize + bottomOverlap;
        }

        return [rowSpacing, colSpacing, containerBox];
    }

    _createBestLayout(area) {
        const [rowSpacing, columnSpacing] =
            this._adjustSpacingAndPadding(this._spacing, this._spacing, null);

        const horizontalLayoutStrategy = new UnalignedHorizontalLayoutStrategy({
            monitor: Main.layoutManager.monitors[this._monitorIndex],
            rowSpacing,
            columnSpacing,
        });

        let lastHorizontalLayout = null;
        let lastHorizontalNumColumns = -1;
        let lastHorizontalSpace = 0;

        for (let numRows = 1; ; numRows++) {
            const numColumns = Math.ceil(this._sortedWindows.length / numRows);

            // If adding a new row does not change column count just stop
            // (for instance: 9 windows, with 3 rows -> 3 columns, 4 rows ->
            // 3 columns as well => just use 3 rows then)
            if (numColumns === lastHorizontalNumColumns)
                break;

            const layout = horizontalLayoutStrategy.computeLayout(this._sortedWindows, {
                numRows,
            });
            const space = horizontalLayoutStrategy.computeOccupiedSpace(layout, area);

            if (space < lastHorizontalSpace) {
                if (!lastHorizontalLayout)
                    lastHorizontalLayout = layout;
                break;
            }

            lastHorizontalLayout = layout;
            lastHorizontalNumColumns = numColumns;
            lastHorizontalSpace = space;
        }

        // Force horizontal layout if we have more than 4 windows, the vertical
        // layout looks weird with more windows.
        if (this._sortedWindows.length > 4) {
            this._layoutStrategy = horizontalLayoutStrategy;
            return lastHorizontalLayout;
        }

        const verticalLayoutStrategy = new UnalignedVerticalLayoutStrategy({
            monitor: Main.layoutManager.monitors[this._monitorIndex],
            rowSpacing,
            columnSpacing,
        });

        let lastVerticalLayout = null;
        let lastVerticalNumRows = -1;
        let lastVerticalSpace = 0;

        for (let numCols = 1; ; numCols++) {
            const numRows = Math.ceil(this._sortedWindows.length / numCols);

            if (numRows === lastVerticalNumRows)
                break;

            const layout = verticalLayoutStrategy.computeLayout(this._sortedWindows, {
                numCols,
            });
            const space = verticalLayoutStrategy.computeOccupiedSpace(layout, area);

            if (space < lastVerticalSpace) {
                if (!lastVerticalLayout)
                    lastVerticalLayout = layout;
                break;
            }

            lastVerticalLayout = layout;
            lastVerticalNumRows = numRows;
            lastVerticalSpace = space;
        }

        if (lastVerticalSpace > lastHorizontalSpace) {
            this._layoutStrategy = verticalLayoutStrategy;
            return lastVerticalLayout;
        }

        this._layoutStrategy = horizontalLayoutStrategy;
        return lastHorizontalLayout;
    }

    _getWindowSlots(containerBox) {
        [, , containerBox] =
            this._adjustSpacingAndPadding(null, null, containerBox);

        const availArea = {
            x: parseInt(containerBox.x1),
            y: parseInt(containerBox.y1),
            width: parseInt(containerBox.get_width()),
            height: parseInt(containerBox.get_height()),
        };

        return this._layoutStrategy.computeWindowSlots(this._layout, availArea);
    }

    _getAdjustedWorkarea(container) {
        const workarea = this._workarea.copy();

        if (container instanceof St.Widget) {
            const themeNode = container.get_theme_node();
            workarea.width -= themeNode.get_horizontal_padding();
            workarea.height -= themeNode.get_vertical_padding();
        }

        return workarea;
    }

    vfunc_set_container(container) {
        this._container = container;
        this._stateAdjustment.actor = container;
    }

    vfunc_get_preferred_width(container, forHeight) {
        const workarea = this._getAdjustedWorkarea(container);
        if (forHeight === -1)
            return [0, workarea.width];

        const workAreaAspectRatio = workarea.width / workarea.height;
        const widthPreservingAspectRatio = forHeight * workAreaAspectRatio;

        return [0, widthPreservingAspectRatio];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const workarea = this._getAdjustedWorkarea(container);
        if (forWidth === -1)
            return [0, workarea.height];

        const workAreaAspectRatio = workarea.width / workarea.height;
        const heightPreservingAspectRatio = forWidth / workAreaAspectRatio;

        return [0, heightPreservingAspectRatio];
    }

    vfunc_allocate(container, box) {
        const containerBox = container.allocation;
        const containerAllocationChanged =
            this._lastBox === null || !this._lastBox.equal(containerBox);
        this._lastBox = containerBox.copy();

        // If the containers size changed, we can no longer keep around
        // the old windowSlots, so we must unfreeze the layout.
        //
        // However, if the overview animation is in progress, don't unfreeze
        // the layout. This is needed to prevent windows "snapping" to their
        // new positions during the overview closing animation when the
        // allocation subtly expands every frame.
        if (this._layoutFrozen && containerAllocationChanged && !Main.overview.animationInProgress) {
            this._layoutFrozen = false;
            this.notify('layout-frozen');
        }

        let layoutChanged = false;
        if (!this._layoutFrozen) {
            if (this._layout === null) {
                this._layout = this._createBestLayout(this._workarea);
                layoutChanged = true;
            }

            if (layoutChanged || containerAllocationChanged)
                this._windowSlots = this._getWindowSlots(box.copy());
        }

        if (this._background)
            this._background.allocate(box);

        const allocationScale = containerBox.get_width() / this._workarea.width;

        const workspaceBox = new Clutter.ActorBox();
        const layoutBox = new Clutter.ActorBox();
        let childBox = new Clutter.ActorBox();

        for (const child of container) {
            if (!child.visible || child === this._background)
                continue;

            // The fifth element in the slot array is the WindowPreview
            const index = this._windowSlots.findIndex(s => s[4] === child);
            if (index === -1) {
                log('Couldn\'t find child %s in window slots'.format(child));
                child.allocate(childBox);
                continue;
            }

            const [x, y, width, height] = this._windowSlots[index];
            const windowInfo = this._windows.get(child);

            if (windowInfo.metaWindow.showing_on_its_workspace()) {
                workspaceBox.x1 = child.boundingBox.x - this._workarea.x;
                workspaceBox.x2 = workspaceBox.x1 + child.boundingBox.width;
                workspaceBox.y1 = child.boundingBox.y - this._workarea.y;
                workspaceBox.y2 = workspaceBox.y1 + child.boundingBox.height;
            } else {
                workspaceBox.set_origin(this._workarea.x, this._workarea.y);
                workspaceBox.set_size(0, 0);

                child.opacity = this._stateAdjustment.value * 255;
            }

            workspaceBox.scale(allocationScale);
            // don't allow the scaled floating size to drop below
            // the target layout size
            workspaceBox.set_size(
                Math.max(workspaceBox.get_width(), width),
                Math.max(workspaceBox.get_height(), height));

            layoutBox.x1 = x;
            layoutBox.x2 = layoutBox.x1 + width;
            layoutBox.y1 = y;
            layoutBox.y2 = layoutBox.y1 + height;

            childBox = workspaceBox.interpolate(layoutBox,
                this._stateAdjustment.value);

            if (windowInfo.currentTransition) {
                windowInfo.currentTransition.get_interval().set_final(childBox);

                // The timeline of the transition might not have been updated
                // before this allocation cycle, so make sure the child
                // still updates needs_allocation to FALSE.
                // Unfortunately, this relies on the fast paths in
                // clutter_actor_allocate(), otherwise we'd start a new
                // transition on the child, replacing the current one.
                child.allocate(child.allocation);
                continue;
            }

            // We want layout changes (ie. larger changes to the layout like
            // reshuffling the window order) to be animated, but small changes
            // like changes to the container size to happen immediately (for
            // example if the container height is being animated, we want to
            // avoid animating the children allocations to make sure they
            // don't "lag behind" the other animation).
            if (layoutChanged && !Main.overview.animationInProgress) {
                const transition = animateAllocation(child, childBox);
                if (transition) {
                    windowInfo.currentTransition = transition;
                    windowInfo.currentTransition.connect('stopped', () => {
                        windowInfo.currentTransition = null;
                    });
                }
            } else {
                child.allocate(childBox);
            }
        }
    }

    _syncOverlay(preview) {
        preview.overlay_enabled = this._stateAdjustment.value === 1;
    }

    /**
     * addWindow:
     * @param {WindowPreview} window: the window to add
     * @param {Meta.Window} metaWindow: the MetaWindow of the window
     *
     * Adds @window to the workspace, it will be shown immediately if
     * the layout isn't frozen using the layout-frozen property.
     *
     * If @window is already part of the workspace, nothing will happen.
     */
    addWindow(window, metaWindow) {
        if (this._windows.has(window))
            return;

        this._windows.set(window, {
            metaWindow,
            sizeChangedId: metaWindow.connect('size-changed', () => {
                this._layout = null;
                this.layout_changed();
            }),
            destroyId: window.connect('destroy', () =>
                this.removeWindow(window)),
            currentTransition: null,
        });

        this._sortedWindows.push(window);
        this._sortedWindows.sort((a, b) => {
            const winA = this._windows.get(a).metaWindow;
            const winB = this._windows.get(b).metaWindow;

            return winA.get_stable_sequence() - winB.get_stable_sequence();
        });

        this._syncOverlay(window);
        this._container.add_child(window);

        this._layout = null;
        this.layout_changed();
    }

    /**
     * removeWindow:
     * @param {WindowPreview} window: the window to remove
     *
     * Removes @window from the workspace if @window is a part of the
     * workspace. If the layout-frozen property is set to true, the
     * window will still be visible until the property is set to false.
     */
    removeWindow(window) {
        const windowInfo = this._windows.get(window);
        if (!windowInfo)
            return;

        windowInfo.metaWindow.disconnect(windowInfo.sizeChangedId);
        window.disconnect(windowInfo.destroyId);
        if (windowInfo.currentTransition)
            window.remove_transition('allocation');

        this._windows.delete(window);
        this._sortedWindows.splice(this._sortedWindows.indexOf(window), 1);

        // The layout might be frozen and we might not update the windowSlots
        // on the next allocation, so remove the slot now already
        this._windowSlots.splice(
            this._windowSlots.findIndex(s => s[4] === window), 1);

        // The window might have been reparented by DND
        if (window.get_parent() === this._container)
            this._container.remove_child(window);

        this._layout = null;
        this.layout_changed();
    }

    setBackground(background) {
        if (this._background)
            this._container.remove_child(this._background);

        this._background = background;

        if (this._background)
            this._container.add_child(this._background);
    }

    syncStacking(stackIndices) {
        const windows = [...this._windows.keys()];
        windows.sort((a, b) => {
            const seqA = this._windows.get(a).metaWindow.get_stable_sequence();
            const seqB = this._windows.get(b).metaWindow.get_stable_sequence();

            return stackIndices[seqA] - stackIndices[seqB];
        });

        let lastWindow = this._background;
        for (const window of windows) {
            window.setStackAbove(lastWindow);
            lastWindow = window;
        }

        this._layout = null;
        this.layout_changed();
    }

    /**
     * getFocusChain:
     *
     * Gets the focus chain of the workspace. This function will return
     * an empty array if the floating window layout is used.
     *
     * @returns {Array} an array of {Clutter.Actor}s
     */
    getFocusChain() {
        if (this._stateAdjustment.value === 0)
            return [];

        // The fifth element in the slot array is the WindowPreview
        return this._windowSlots.map(s => s[4]);
    }

    /**
     * An StAdjustment for controlling and transitioning between
     * the alignment of windows using the layout strategy and the
     * floating window layout.
     *
     * A value of 0 of the adjustment completely uses the floating
     * window layout while a value of 1 completely aligns windows using
     * the layout strategy.
     *
     * @type {St.Adjustment}
     */
    get stateAdjustment() {
        return this._stateAdjustment;
    }

    get spacing() {
        return this._spacing;
    }

    set spacing(s) {
        if (this._spacing === s)
            return;

        this._spacing = s;

        this._layout = null;
        this.notify('spacing');
        this.layout_changed();
    }

    // eslint-disable-next-line camelcase
    get layout_frozen() {
        return this._layoutFrozen;
    }

    // eslint-disable-next-line camelcase
    set layout_frozen(f) {
        if (this._layoutFrozen === f)
            return;

        this._layoutFrozen = f;

        this.notify('layout-frozen');
        if (!this._layoutFrozen)
            this.layout_changed();
    }
});

var WorkspaceBackground = GObject.registerClass(
class WorkspaceBackground extends St.Widget {
    _init(monitorIndex) {
        super._init({
            style_class: 'workspace-background',
            layout_manager: new Clutter.BinLayout(),
        });

        this._monitorIndex = monitorIndex;
        this._workarea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

        this._bin = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
        });

        this._backgroundGroup = new Meta.BackgroundGroup({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._bin.add_child(this._backgroundGroup);
        this.add_child(this._bin);

        this._bgManager = new Background.BackgroundManager({
            container: this._backgroundGroup,
            monitorIndex: this._monitorIndex,
            controlPosition: false,
            useContentSize: false,
        });

        this.connect('destroy', this._onDestroy.bind(this));
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const themeNode = this.get_theme_node();
        const contentBox = themeNode.get_content_box(box);

        this._bin.allocate(contentBox);

        const [contentWidth, contentHeight] = contentBox.get_size();
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        const xOff = (contentWidth / this._workarea.width) *
            (this._workarea.x - monitor.x);
        const yOff = (contentHeight / this._workarea.height) *
            (this._workarea.y - monitor.y);

        contentBox.x1 -= xOff;
        contentBox.y1 -= yOff;
        contentBox.set_size(xOff + contentWidth, yOff + contentHeight);
        this._backgroundGroup.allocate(contentBox);
    }

    _onDestroy() {
        if (this._bgManager) {
            this._bgManager.destroy();
            this._bgManager = null;
        }
    }
});

/**
 * @metaWorkspace: a #Meta.Workspace, or null
 */
var Workspace = GObject.registerClass(
class Workspace extends St.Widget {
    _init(metaWorkspace, monitorIndex) {
        super._init({
            style_class: 'window-picker',
            layout_manager: new WorkspaceLayout(metaWorkspace, monitorIndex),
            reactive: true,
        });

        this.metaWorkspace = metaWorkspace;

        this.monitorIndex = monitorIndex;
        this._monitor = Main.layoutManager.monitors[this.monitorIndex];

        if (monitorIndex != Main.layoutManager.primaryIndex)
            this.add_style_class_name('external-monitor');

        // Background
        this._background = new WorkspaceBackground(monitorIndex);
        this.layout_manager.setBackground(this._background);

        const clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', action => {
            // Only switch to the workspace when there's no application
            // windows open. The problem is that it's too easy to miss
            // an app window and get the wrong one focused.
            if ((action.get_button() === 1 || action.get_button() === 0) &&
                this.isEmpty())
                Main.overview.hide();
        });
        this.bind_property('mapped', clickAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);
        this.add_action(clickAction);

        this.connect('style-changed', this._onStyleChanged.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));

        const windows = global.get_window_actors().map(a => a.meta_window)
            .filter(this._isMyWindow, this);

        // Create clones for windows that should be
        // visible in the Overview
        this._windows = [];
        for (let i = 0; i < windows.length; i++) {
            if (this._isOverviewWindow(windows[i]))
                this._addWindowClone(windows[i]);
        }

        // Track window changes
        if (this.metaWorkspace) {
            this._windowAddedId = this.metaWorkspace.connect('window-added',
                                                             this._windowAdded.bind(this));
            this._windowRemovedId = this.metaWorkspace.connect('window-removed',
                                                               this._windowRemoved.bind(this));
        }
        this._windowEnteredMonitorId = global.display.connect('window-entered-monitor',
                                                              this._windowEnteredMonitor.bind(this));
        this._windowLeftMonitorId = global.display.connect('window-left-monitor',
                                                           this._windowLeftMonitor.bind(this));
        this._layoutFrozenId = 0;

        // DND requires this to be set
        this._delegate = this;
    }

    vfunc_get_focus_chain() {
        return this.layout_manager.getFocusChain();
    }

    _lookupIndex(metaWindow) {
        return this._windows.findIndex(w => w.metaWindow == metaWindow);
    }

    containsMetaWindow(metaWindow) {
        return this._lookupIndex(metaWindow) >= 0;
    }

    isEmpty() {
        return this._windows.length == 0;
    }

    syncStacking(stackIndices) {
        this.layout_manager.syncStacking(stackIndices);
    }

    _doRemoveWindow(metaWin) {
        let clone = this._removeWindowClone(metaWin);

        if (!clone)
            return;

        clone.destroy();

        // We need to reposition the windows; to avoid shuffling windows
        // around while the user is interacting with the workspace, we delay
        // the positioning until the pointer remains still for at least 750 ms
        // or is moved outside the workspace
        this.layout_manager.layout_frozen = true;

        if (this._layoutFrozenId > 0) {
            GLib.source_remove(this._layoutFrozenId);
            this._layoutFrozenId = 0;
        }

        let [oldX, oldY] = global.get_pointer();

        this._layoutFrozenId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            WINDOW_REPOSITIONING_DELAY,
            () => {
                const [newX, newY] = global.get_pointer();
                const pointerHasMoved = oldX !== newX || oldY !== newY;
                const actorUnderPointer = global.stage.get_actor_at_pos(
                    Clutter.PickMode.REACTIVE, newX, newY);

                if ((pointerHasMoved && this.contains(actorUnderPointer)) ||
                    this._windows.some(w => w.contains(actorUnderPointer))) {
                    oldX = newX;
                    oldY = newY;
                    return GLib.SOURCE_CONTINUE;
                }

                this.layout_manager.layout_frozen = false;
                this._layoutFrozenId = 0;
                return GLib.SOURCE_REMOVE;
            });

        GLib.Source.set_name_by_id(this._layoutFrozenId,
            '[gnome-shell] this._layoutFrozenId');
    }

    _doAddWindow(metaWin) {
        let win = metaWin.get_compositor_private();

        if (!win) {
            // Newly-created windows are added to a workspace before
            // the compositor finds out about them...
            let id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (metaWin.get_compositor_private() &&
                    metaWin.get_workspace() == this.metaWorkspace)
                    this._doAddWindow(metaWin);
                return GLib.SOURCE_REMOVE;
            });
            GLib.Source.set_name_by_id(id, '[gnome-shell] this._doAddWindow');
            return;
        }

        // We might have the window in our list already if it was on all workspaces and
        // now was moved to this workspace
        if (this._lookupIndex(metaWin) != -1)
            return;

        if (!this._isMyWindow(metaWin))
            return;

        if (!this._isOverviewWindow(metaWin)) {
            if (metaWin.get_transient_for() == null)
                return;

            // Let the top-most ancestor handle all transients
            let parent = metaWin.find_root_ancestor();
            let clone = this._windows.find(c => c.metaWindow == parent);

            // If no clone was found, the parent hasn't been created yet
            // and will take care of the dialog when added
            if (clone)
                clone.addDialog(metaWin);

            return;
        }

        const clone = this._addWindowClone(metaWin);

        clone.set_pivot_point(0.5, 0.5);
        clone.scale_x = 0;
        clone.scale_y = 0;
        clone.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 250,
            onStopped: () => clone.set_pivot_point(0, 0),
        });

        if (this._layoutFrozenId > 0) {
            // If a window was closed before, unfreeze the layout to ensure
            // the new window is immediately shown
            this.layout_manager.layout_frozen = false;

            GLib.source_remove(this._layoutFrozenId);
            this._layoutFrozenId = 0;
        }
    }

    _windowAdded(metaWorkspace, metaWin) {
        this._doAddWindow(metaWin);
    }

    _windowRemoved(metaWorkspace, metaWin) {
        this._doRemoveWindow(metaWin);
    }

    _windowEnteredMonitor(metaDisplay, monitorIndex, metaWin) {
        if (monitorIndex == this.monitorIndex)
            this._doAddWindow(metaWin);
    }

    _windowLeftMonitor(metaDisplay, monitorIndex, metaWin) {
        if (monitorIndex == this.monitorIndex)
            this._doRemoveWindow(metaWin);
    }

    // check for maximized windows on the workspace
    hasMaximizedWindows() {
        for (let i = 0; i < this._windows.length; i++) {
            let metaWindow = this._windows[i].metaWindow;
            if (metaWindow.showing_on_its_workspace() &&
                metaWindow.maximized_horizontally &&
                metaWindow.maximized_vertically)
                return true;
        }
        return false;
    }

    fadeToOverview() {
        // We don't want to reposition windows while animating in this way.
        this.layout_manager.layout_frozen = true;
        this._overviewShownId = Main.overview.connect('shown', this._doneShowingOverview.bind(this));
        if (this._windows.length == 0)
            return;

        if (this.metaWorkspace !== null && !this.metaWorkspace.active)
            return;

        this.layout_manager.stateAdjustment.value = 0;

        // Special case maximized windows, since it doesn't make sense
        // to animate windows below in the stack
        let topMaximizedWindow;
        // It is ok to treat the case where there is no maximized
        // window as if the bottom-most window was maximized given that
        // it won't affect the result of the animation
        for (topMaximizedWindow = this._windows.length - 1; topMaximizedWindow > 0; topMaximizedWindow--) {
            let metaWindow = this._windows[topMaximizedWindow].metaWindow;
            if (metaWindow.maximized_horizontally && metaWindow.maximized_vertically)
                break;
        }

        let nTimeSlots = Math.min(WINDOW_ANIMATION_MAX_NUMBER_BLENDING + 1, this._windows.length - topMaximizedWindow);
        let windowBaseTime = Overview.ANIMATION_TIME / nTimeSlots;

        let topIndex = this._windows.length - 1;
        for (let i = 0; i < this._windows.length; i++) {
            if (i < topMaximizedWindow) {
                // below top-most maximized window, don't animate
                this._windows[i].hideOverlay(false);
                this._windows[i].opacity = 0;
            } else {
                let fromTop = topIndex - i;
                let time;
                if (fromTop < nTimeSlots) // animate top-most windows gradually
                    time = windowBaseTime * (nTimeSlots - fromTop);
                else
                    time = windowBaseTime;

                this._windows[i].opacity = 255;
                this._fadeWindow(i, time, 0);
            }
        }
    }

    fadeFromOverview() {
        this.layout_manager.layout_frozen = true;
        this._overviewHiddenId = Main.overview.connect('hidden', this._doneLeavingOverview.bind(this));
        if (this._windows.length == 0)
            return;

        for (let i = 0; i < this._windows.length; i++)
            this._windows[i].remove_all_transitions();

        if (this._layoutFrozenId > 0) {
            GLib.source_remove(this._layoutFrozenId);
            this._layoutFrozenId = 0;
        }

        if (this.metaWorkspace !== null && !this.metaWorkspace.active)
            return;

        this.layout_manager.stateAdjustment.value = 0;

        // Special case maximized windows, since it doesn't make sense
        // to animate windows below in the stack
        let topMaximizedWindow;
        // It is ok to treat the case where there is no maximized
        // window as if the bottom-most window was maximized given that
        // it won't affect the result of the animation
        for (topMaximizedWindow = this._windows.length - 1; topMaximizedWindow > 0; topMaximizedWindow--) {
            let metaWindow = this._windows[topMaximizedWindow].metaWindow;
            if (metaWindow.maximized_horizontally && metaWindow.maximized_vertically)
                break;
        }

        let nTimeSlots = Math.min(WINDOW_ANIMATION_MAX_NUMBER_BLENDING + 1, this._windows.length - topMaximizedWindow);
        let windowBaseTime = Overview.ANIMATION_TIME / nTimeSlots;

        let topIndex = this._windows.length - 1;
        for (let i = 0; i < this._windows.length; i++) {
            if (i < topMaximizedWindow) {
                // below top-most maximized window, don't animate
                this._windows[i].hideOverlay(false);
                this._windows[i].opacity = 0;
            } else {
                let fromTop = topIndex - i;
                let time;
                if (fromTop < nTimeSlots) // animate top-most windows gradually
                    time = windowBaseTime * (fromTop + 1);
                else
                    time = windowBaseTime * nTimeSlots;

                this._windows[i].opacity = 0;
                this._fadeWindow(i, time, 255);
            }
        }
    }

    _fadeWindow(index, duration, opacity) {
        let clone = this._windows[index];
        clone.hideOverlay(false);

        if (clone.metaWindow.showing_on_its_workspace()) {
            clone.ease({
                opacity,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            // The window is hidden
            clone.opacity = 0;
        }
    }

    zoomToOverview() {
        const animate =
            this.metaWorkspace === null || this.metaWorkspace.active;

        const adj = this.layout_manager.stateAdjustment;
        adj.ease(1, {
            duration: animate ? Overview.ANIMATION_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    zoomFromOverview() {
        for (let i = 0; i < this._windows.length; i++)
            this._windows[i].remove_all_transitions();

        if (this._layoutFrozenId > 0) {
            GLib.source_remove(this._layoutFrozenId);
            this._layoutFrozenId = 0;
        }

        this.layout_manager.layout_frozen = true;
        this._overviewHiddenId = Main.overview.connect('hidden', this._doneLeavingOverview.bind(this));

        if (this.metaWorkspace !== null && !this.metaWorkspace.active)
            return;

        this.layout_manager.stateAdjustment.ease(0, {
            duration: Overview.ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onDestroy() {
        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = 0;
        }

        if (this._overviewShownId) {
            Main.overview.disconnect(this._overviewShownId);
            this._overviewShownId = 0;
        }

        if (this.metaWorkspace) {
            this.metaWorkspace.disconnect(this._windowAddedId);
            this.metaWorkspace.disconnect(this._windowRemovedId);
        }
        global.display.disconnect(this._windowEnteredMonitorId);
        global.display.disconnect(this._windowLeftMonitorId);

        if (this._layoutFrozenId > 0) {
            GLib.source_remove(this._layoutFrozenId);
            this._layoutFrozenId = 0;
        }

        this._windows = [];
    }

    _doneLeavingOverview() {
        this.layout_manager.layout_frozen = false;
        this.layout_manager.stateAdjustment.value = 0;
        this._windows.forEach(w => (w.opacity = 255));
    }

    _doneShowingOverview() {
        this.layout_manager.layout_frozen = false;
        this.layout_manager.stateAdjustment.value = 1;
        this._windows.forEach(w => (w.opacity = 255));
    }

    _isMyWindow(window) {
        const isOnWorkspace = this.metaWorkspace === null ||
            window.located_on_workspace(this.metaWorkspace);
        const isOnMonitor = window.get_monitor() === this.monitorIndex;

        return isOnWorkspace && isOnMonitor;
    }

    _isOverviewWindow(window) {
        return !window.skip_taskbar;
    }

    // Create a clone of a (non-desktop) window and add it to the window list
    _addWindowClone(metaWindow) {
        let clone = new WindowPreview(metaWindow, this);

        clone.connect('selected',
                      this._onCloneSelected.bind(this));
        clone.connect('drag-begin', () => {
            Main.overview.beginWindowDrag(metaWindow);
        });
        clone.connect('drag-cancelled', () => {
            Main.overview.cancelledWindowDrag(metaWindow);
        });
        clone.connect('drag-end', () => {
            Main.overview.endWindowDrag(metaWindow);
        });
        clone.connect('show-chrome', () => {
            let focus = global.stage.key_focus;
            if (focus == null || this.contains(focus))
                clone.grab_key_focus();

            this._windows.forEach(c => {
                if (c !== clone)
                    c.hideOverlay(true);
            });
        });
        clone.connect('destroy', () => {
            this._doRemoveWindow(metaWindow);
        });

        this.layout_manager.addWindow(clone, metaWindow);

        if (this._windows.length == 0)
            clone.setStackAbove(this._background);
        else
            clone.setStackAbove(this._windows[this._windows.length - 1]);

        this._windows.push(clone);

        return clone;
    }

    _removeWindowClone(metaWin) {
        // find the position of the window in our list
        let index = this._lookupIndex(metaWin);

        if (index == -1)
            return null;

        this.layout_manager.removeWindow(this._windows[index]);

        return this._windows.splice(index, 1).pop();
    }

    _onStyleChanged() {
        const themeNode = this.get_theme_node();
        this.layout_manager.spacing = themeNode.get_length('spacing');
    }

    _onCloneSelected(clone, time) {
        const wsIndex = this.metaWorkspace?.index();
        Main.activateWindow(clone.metaWindow, time, wsIndex);
    }

    // Draggable target interface
    handleDragOver(source, _actor, _x, _y, _time) {
        if (source.metaWindow && !this._isMyWindow(source.metaWindow))
            return DND.DragMotionResult.MOVE_DROP;
        if (source.app && source.app.can_open_new_window())
            return DND.DragMotionResult.COPY_DROP;
        if (!source.app && source.shellWorkspaceLaunch)
            return DND.DragMotionResult.COPY_DROP;

        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, actor, x, y, time) {
        let workspaceManager = global.workspace_manager;
        let workspaceIndex = this.metaWorkspace
            ? this.metaWorkspace.index()
            : workspaceManager.get_active_workspace_index();

        if (source.metaWindow) {
            const window = source.metaWindow;
            if (this._isMyWindow(window))
                return false;

            // We need to move the window before changing the workspace, because
            // the move itself could cause a workspace change if the window enters
            // the primary monitor
            if (window.get_monitor() != this.monitorIndex)
                window.move_to_monitor(this.monitorIndex);

            window.change_workspace_by_index(workspaceIndex, false);
            return true;
        } else if (source.app && source.app.can_open_new_window()) {
            if (source.animateLaunchAtPos)
                source.animateLaunchAtPos(actor.x, actor.y);

            source.app.open_new_window(workspaceIndex);
            return true;
        } else if (!source.app && source.shellWorkspaceLaunch) {
            // While unused in our own drag sources, shellWorkspaceLaunch allows
            // extensions to define custom actions for their drag sources.
            source.shellWorkspaceLaunch({ workspace: workspaceIndex,
                                          timestamp: time });
            return true;
        }

        return false;
    }
});
