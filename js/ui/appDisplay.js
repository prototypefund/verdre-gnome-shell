// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported AppDisplay, AppSearchProvider */

const {
    Clutter, Gio, GLib, GObject, Graphene, Pango, Shell, St,
} = imports.gi;

const AppFavorites = imports.ui.appFavorites;
const { AppMenu } = imports.ui.appMenu;
const BoxPointer = imports.ui.boxpointer;
const DND = imports.ui.dnd;
const GrabHelper = imports.ui.grabHelper;
const IconGrid = imports.ui.iconGrid;
const Layout = imports.ui.layout;
const Main = imports.ui.main;
const PageIndicators = imports.ui.pageIndicators;
const ParentalControlsManager = imports.misc.parentalControlsManager;
const PopupMenu = imports.ui.popupMenu;
const Search = imports.ui.search;
const SwipeTracker = imports.ui.swipeTracker;
const Params = imports.misc.params;
const SystemActions = imports.misc.systemActions;

var MENU_POPUP_TIMEOUT = 600;
var POPDOWN_DIALOG_TIMEOUT = 500;

var FOLDER_SUBICON_FRACTION = .4;

var VIEWS_SWITCH_TIME = 400;
var VIEWS_SWITCH_ANIMATION_DELAY = 100;

var SCROLL_TIMEOUT_TIME = 150;

var APP_ICON_SCALE_IN_TIME = 500;
var APP_ICON_SCALE_IN_DELAY = 700;

var APP_ICON_TITLE_EXPAND_TIME = 200;
var APP_ICON_TITLE_COLLAPSE_TIME = 100;

const FOLDER_DIALOG_ANIMATION_TIME = 200;

const PAGE_PREVIEW_ANIMATION_TIME = 150;
const PAGE_INDICATOR_FADE_TIME = 200;
const PAGE_PREVIEW_RATIO = 0.20;

const OVERSHOOT_THRESHOLD = 40;
const OVERSHOOT_TIMEOUT = 1000;

const DELAYED_MOVE_TIMEOUT = 200;

const DIALOG_SHADE_NORMAL = Clutter.Color.from_pixel(0x000000cc);
const DIALOG_SHADE_HIGHLIGHT = Clutter.Color.from_pixel(0x00000055);

const DEFAULT_FOLDERS = {
    'Utilities': {
        name: 'X-GNOME-Utilities.directory',
        categories: ['X-GNOME-Utilities'],
        apps: [
            'gnome-abrt.desktop',
            'gnome-system-log.desktop',
            'nm-connection-editor.desktop',
            'org.gnome.baobab.desktop',
            'org.gnome.Connections.desktop',
            'org.gnome.DejaDup.desktop',
            'org.gnome.Dictionary.desktop',
            'org.gnome.DiskUtility.desktop',
            'org.gnome.eog.desktop',
            'org.gnome.Evince.desktop',
            'org.gnome.FileRoller.desktop',
            'org.gnome.fonts.desktop',
            'org.gnome.seahorse.Application.desktop',
            'org.gnome.tweaks.desktop',
            'org.gnome.Usage.desktop',
            'vinagre.desktop',
        ],
    },
    'YaST': {
        name: 'suse-yast.directory',
        categories: ['X-SuSE-YaST'],
    },
};

function _getCategories(info) {
    let categoriesStr = info.get_categories();
    if (!categoriesStr)
        return [];
    return categoriesStr.split(';');
}

function _listsIntersect(a, b) {
    for (let itemA of a) {
        if (b.includes(itemA))
            return true;
    }
    return false;
}

function _getFolderName(folder) {
    let name = folder.get_string('name');

    if (folder.get_boolean('translate')) {
        let translated = Shell.util_get_translated_folder_name(name);
        if (translated !== null)
            return translated;
    }

    return name;
}

function _getViewFromIcon(icon) {
    for (let parent = icon.get_parent(); parent; parent = parent.get_parent()) {
        if (parent instanceof BaseAppView)
            return parent;
    }
    return null;
}

function _findBestFolderName(appInfos) {
    let categoryCounter = {};
    let commonCategories = [];

    appInfos.reduce((categories, appInfo) => {
        for (let category of _getCategories(appInfo)) {
            if (!(category in categoryCounter))
                categoryCounter[category] = 0;

            categoryCounter[category] += 1;

            // If a category is present in all apps, its counter will
            // reach appInfos.length
            if (category.length > 0 &&
                categoryCounter[category] == appInfos.length)
                categories.push(category);
        }
        return categories;
    }, commonCategories);

    for (let category of commonCategories) {
        const directory = `${category}.directory`;
        const translated = Shell.util_get_translated_folder_name(directory);
        if (translated !== null)
            return translated;
    }

    return null;
}

const AppGrid = GObject.registerClass({
    Properties: {
        'indicators-padding': GObject.ParamSpec.boxed('indicators-padding',
            'Indicators padding', 'Indicators padding',
            GObject.ParamFlags.READWRITE,
            Clutter.Margin.$gtype),
    },
}, class AppGrid extends IconGrid.IconGrid {
    _init(layoutParams) {
        super._init(layoutParams);

        this._indicatorsPadding = new Clutter.Margin();
    }

    _updatePadding() {
        const node = this.get_theme_node();
        const {rowSpacing, columnSpacing} = this.layoutManager;

        const padding = this._indicatorsPadding.copy();
        padding.left += rowSpacing;
        padding.right += rowSpacing;
        padding.top += columnSpacing;
        padding.bottom += columnSpacing;
        ['top', 'right', 'bottom', 'left'].forEach(side => {
            padding[side] += node.get_length(`page-padding-${side}`);
        });

        this.layoutManager.pagePadding = padding;
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this._updatePadding();
    }

    get indicatorsPadding() {
        return this._indicatorsPadding;
    }

    set indicatorsPadding(v) {
        if (this._indicatorsPadding === v)
            return;

        this._indicatorsPadding = v ? v : new Clutter.Margin();
        this._updatePadding();
    }
});

const BaseAppViewGridLayout = GObject.registerClass(
class BaseAppViewGridLayout extends Clutter.BinLayout {
    _init(grid, scrollView, nextPageIndicator, nextPageArrow,
        previousPageIndicator, previousPageArrow) {
        if (!(grid instanceof AppGrid))
            throw new Error('Grid must be an AppGrid subclass');

        super._init();

        this._grid = grid;
        this._scrollView = scrollView;
        this._previousPageIndicator = previousPageIndicator;
        this._previousPageArrow = previousPageArrow;
        this._nextPageIndicator = nextPageIndicator;
        this._nextPageArrow = nextPageArrow;

        grid.connect('pages-changed', () => this._syncPageIndicatorsVisibility());

        this._pageIndicatorsAdjustment = new St.Adjustment({
            lower: 0,
            upper: 1,
        });
        this._pageIndicatorsAdjustment.connect(
            'notify::value', () => this._syncPageIndicators());

        this._showIndicators = false;
        this._currentPage = 0;
        this._pageWidth = 0;
    }

    _getIndicatorsWidth(box) {
        if (Main.layoutManager.isPhone)
            return 0;

        const [width, height] = box.get_size();
        const arrows = [
            this._nextPageArrow,
            this._previousPageArrow,
        ];

        const minArrowsWidth = arrows.reduce(
            (previousWidth, accessory) => {
                const [min] = accessory.get_preferred_width(height);
                return Math.max(previousWidth, min);
            }, 0);

        const idealIndicatorWidth = (width * PAGE_PREVIEW_RATIO) / 2;

        return Math.max(idealIndicatorWidth, minArrowsWidth);
    }

    _syncPageIndicatorsVisibility(animate = true) {
        const previousIndicatorsVisible = !Main.layoutManager.isPhone &&
            this._currentPage > 0 && this._showIndicators;

        if (previousIndicatorsVisible)
            this._previousPageIndicator.show();

        this._previousPageIndicator.ease({
            opacity: previousIndicatorsVisible ? 255 : 0,
            duration: animate ? PAGE_INDICATOR_FADE_TIME : 0,
            onComplete: () => {
                if (!previousIndicatorsVisible)
                    this._previousPageIndicator.hide();
            },
        });

        const previousArrowVisible = !Main.layoutManager.isPhone &&
            this._currentPage > 0 && !previousIndicatorsVisible;

        if (previousArrowVisible)
            this._previousPageArrow.show();

        this._previousPageArrow.ease({
            opacity: previousArrowVisible ? 255 : 0,
            duration: animate ? PAGE_INDICATOR_FADE_TIME : 0,
            onComplete: () => {
                if (!previousArrowVisible)
                    this._previousPageArrow.hide();
            },
        });

        // Always show the next page indicator to allow dropping
        // icons into new pages
        const {allowIncompletePages, nPages} = this._grid.layoutManager;
        const nextIndicatorsVisible = !Main.layoutManager.isPhone && this._showIndicators &&
            (allowIncompletePages ? true : this._currentPage < nPages - 1);

        if (nextIndicatorsVisible)
            this._nextPageIndicator.show();

        this._nextPageIndicator.ease({
            opacity: nextIndicatorsVisible ? 255 : 0,
            duration: animate ? PAGE_INDICATOR_FADE_TIME : 0,
            onComplete: () => {
                if (!nextIndicatorsVisible)
                    this._nextPageIndicator.hide();
            },
        });

        const nextArrowVisible = !Main.layoutManager.isPhone &&
            this._currentPage < nPages - 1 &&
            !nextIndicatorsVisible;

        if (nextArrowVisible)
            this._nextPageArrow.show();

        this._nextPageArrow.ease({
            opacity: nextArrowVisible ? 255 : 0,
            duration: animate ? PAGE_INDICATOR_FADE_TIME : 0,
            onComplete: () => {
                if (!nextArrowVisible)
                    this._nextPageArrow.hide();
            },
        });
    }

    _getEndIcon(icons) {
        const {columnsPerPage} = this._grid.layoutManager;
        const index = Math.min(icons.length, columnsPerPage);
        return icons[Math.max(index - 1, 0)];
    }

    _translatePreviousPageIcons(value, ltr) {
        if (this._currentPage === 0)
            return;

        const previousPage = this._currentPage - 1;
        const icons = this._grid.getItemsAtPage(previousPage).filter(i => i.visible);
        if (icons.length === 0)
            return;

        const {left, right} = this._grid.indicatorsPadding;
        const {columnSpacing} = this._grid.layoutManager;
        const endIcon = this._getEndIcon(icons);
        let iconOffset;

        if (ltr) {
            const currentPageOffset = this._pageWidth * this._currentPage;
            iconOffset = currentPageOffset - endIcon.allocation.x2 + left - columnSpacing;
        } else {
            const rtlPage = this._grid.nPages - previousPage - 1;
            const pageOffset = this._pageWidth * rtlPage;
            iconOffset = pageOffset - endIcon.allocation.x1 - right + columnSpacing;
        }

        for (const icon of icons)
            icon.translationX = iconOffset * value;
    }

    _translateNextPageIcons(value, ltr) {
        if (this._currentPage >= this._grid.nPages - 1)
            return;

        const nextPage = this._currentPage + 1;
        const icons = this._grid.getItemsAtPage(nextPage).filter(i => i.visible);
        if (icons.length === 0)
            return;

        const {left, right} = this._grid.indicatorsPadding;
        const {columnSpacing} = this._grid.layoutManager;
        let iconOffset;

        if (ltr) {
            const pageOffset = this._pageWidth * nextPage;
            iconOffset = pageOffset - icons[0].allocation.x1 - right + columnSpacing;
        } else {
            const rtlPage = this._grid.nPages - this._currentPage - 1;
            const currentPageOffset = this._pageWidth * rtlPage;
            iconOffset = currentPageOffset - icons[0].allocation.x2 + left - columnSpacing;
        }

        for (const icon of icons)
            icon.translationX = iconOffset * value;
    }

    _syncPageIndicators() {
        if (!this._container)
            return;

        const {value} = this._pageIndicatorsAdjustment;

        const ltr = this._container.get_text_direction() !== Clutter.TextDirection.RTL;
        const {left, right} = this._grid.indicatorsPadding;
        const leftIndicatorOffset = -left * (1 - value);
        const rightIndicatorOffset = right * (1 - value);

        this._previousPageIndicator.translationX =
            ltr ? leftIndicatorOffset : rightIndicatorOffset;
        this._nextPageIndicator.translationX =
            ltr ? rightIndicatorOffset : leftIndicatorOffset;

        const leftArrowOffset = -left * value;
        const rightArrowOffset = right * value;

        this._previousPageArrow.translationX =
            ltr ? leftArrowOffset : rightArrowOffset;
        this._nextPageArrow.translationX =
            ltr ? rightArrowOffset : leftArrowOffset;

        // Page icons
        this._translatePreviousPageIcons(value, ltr);
        this._translateNextPageIcons(value, ltr);

        if (this._grid.nPages > 0) {
            this._grid.getItemsAtPage(this._currentPage).forEach(icon => {
                icon.translationX = 0;
            });
        }
    }

    vfunc_set_container(container) {
        this._container = container;
        this._pageIndicatorsAdjustment.actor = container;
        this._syncPageIndicators();
    }

    vfunc_allocate(container, box) {
        const ltr = container.get_text_direction() !== Clutter.TextDirection.RTL;
        const indicatorsWidth = this._getIndicatorsWidth(box);

        this._grid.indicatorsPadding = new Clutter.Margin({
            left: indicatorsWidth,
            right: indicatorsWidth,
        });

        this._scrollView.allocate(box);

        const leftBox = box.copy();
        leftBox.x2 = leftBox.x1 + indicatorsWidth;

        const rightBox = box.copy();
        rightBox.x1 = rightBox.x2 - indicatorsWidth;

        this._previousPageIndicator.allocate(ltr ? leftBox : rightBox);
        this._previousPageArrow.allocate_align_fill(ltr ? leftBox : rightBox,
            0.5, 0.5, false, false);
        this._nextPageIndicator.allocate(ltr ? rightBox : leftBox);
        this._nextPageArrow.allocate_align_fill(ltr ? rightBox : leftBox,
            0.5, 0.5, false, false);

        this._pageWidth = box.get_width();
    }

    goToPage(page, animate = true) {
        if (this._currentPage === page)
            return;

        this._currentPage = page;
        this._syncPageIndicatorsVisibility(animate);
        this._syncPageIndicators();
    }

    showPageIndicators() {
        if (this._showIndicators)
            return;

        this._pageIndicatorsAdjustment.ease(1, {
            duration: PAGE_PREVIEW_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        this._grid.clipToView = false;
        this._showIndicators = true;
        this._syncPageIndicatorsVisibility();
    }

    hidePageIndicators() {
        if (!this._showIndicators)
            return;

        this._pageIndicatorsAdjustment.ease(0, {
            duration: PAGE_PREVIEW_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                this._grid.clipToView = true;
            },
        });

        this._showIndicators = false;
        this._syncPageIndicatorsVisibility();
    }
});

var BaseAppView = GObject.registerClass({
    GTypeFlags: GObject.TypeFlags.ABSTRACT,
    Properties: {
        'gesture-modes': GObject.ParamSpec.flags(
            'gesture-modes', 'gesture-modes', 'gesture-modes',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            Shell.ActionMode, Shell.ActionMode.OVERVIEW),
    },
    Signals: {
        'view-loaded': {},
    },
}, class BaseAppView extends St.Widget {
    _init(params = {}) {
        super._init(params);

        this._grid = this._createGrid();
        this._grid._delegate = this;
        // Standard hack for ClutterBinLayout
        this._grid.x_expand = true;
        this._grid.connect('pages-changed', () => {
            this.goToPage(this._grid.currentPage);
            this._pageIndicators.setNPages(this._grid.nPages);
            this._pageIndicators.setCurrentPosition(this._grid.currentPage);
        });

        // Scroll View
        this._scrollView = new St.ScrollView({
            style_class: 'apps-scroll-view',
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
            reactive: true,
            enable_mouse_scrolling: false,
        });
        this._scrollView.set_policy(St.PolicyType.EXTERNAL, St.PolicyType.NEVER);

        this._canScroll = true; // limiting scrolling speed
        this._scrollTimeoutId = 0;
        this._scrollView.connect('scroll-event', this._onScroll.bind(this));

        this._scrollView.add_actor(this._grid);

        const scroll = this._scrollView.hscroll;
        this._adjustment = scroll.adjustment;
        this._adjustment.connect('notify::value', adj => {
            const value = adj.value / adj.page_size;
            this._pageIndicators.setCurrentPosition(value);
        });

        // Page Indicators
        this._pageIndicators =
            new PageIndicators.PageIndicators(Clutter.Orientation.HORIZONTAL);

        this._pageIndicators.y_expand = false;
        this._pageIndicators.connect('page-activated',
            (indicators, pageIndex) => {
                this.goToPage(pageIndex);
            });
        this._pageIndicators.connect('scroll-event', (actor, event) => {
            this._scrollView.event(event, false);
        });

        // Navigation indicators
        this._nextPageIndicator = new St.Widget({
            style_class: 'page-navigation-hint next',
            opacity: 0,
            visible: false,
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        this._prevPageIndicator = new St.Widget({
            style_class: 'page-navigation-hint previous',
            opacity: 0,
            visible: false,
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        // Next/prev page arrows
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        this._nextPageArrow = new St.Button({
            style_class: 'page-navigation-arrow',
            icon_name: rtl
                ? 'carousel-arrow-previous-symbolic'
                : 'carousel-arrow-next-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._nextPageArrow.connect('clicked',
            () => this.goToPage(this._grid.currentPage + 1));

        this._prevPageArrow = new St.Button({
            style_class: 'page-navigation-arrow',
            icon_name: rtl
                ? 'carousel-arrow-next-symbolic'
                : 'carousel-arrow-previous-symbolic',
            opacity: 0,
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._prevPageArrow.connect('clicked',
            () => this.goToPage(this._grid.currentPage - 1));

        const scrollContainer = new St.Widget({
            clip_to_allocation: true,
            y_expand: true,
        });
        scrollContainer.add_child(this._scrollView);
        scrollContainer.add_child(this._prevPageIndicator);
        scrollContainer.add_child(this._nextPageIndicator);
        scrollContainer.add_child(this._nextPageArrow);
        scrollContainer.add_child(this._prevPageArrow);
        scrollContainer.layoutManager = new BaseAppViewGridLayout(
            this._grid,
            this._scrollView,
            this._nextPageIndicator,
            this._nextPageArrow,
            this._prevPageIndicator,
            this._prevPageArrow);
        this._appGridLayout = scrollContainer.layoutManager;
        scrollContainer._delegate = this;

        this._box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._box.add_child(scrollContainer);
        this._box.add_child(this._pageIndicators);

        this._parentalControlsManager = ParentalControlsManager.getDefault();
        this._appFavorites = AppFavorites.getAppFavorites();

        // Swipe
        this._swipeTracker = new SwipeTracker.SwipeTracker(
            Clutter.Orientation.HORIZONTAL, this.gestureModes);
        this._swipeTracker.orientation = Clutter.Orientation.HORIZONTAL;
        this._swipeTracker.connect('begin', this._swipeBegin.bind(this));
        this._swipeTracker.connect('update', this._swipeUpdate.bind(this));
        this._swipeTracker.connect('end', this._swipeEnd.bind(this));
        this._swipeTracker.set_name('AppDisplay swipe tracker');
        this._scrollView.add_action(this._swipeTracker);

        this._orientation = Clutter.Orientation.HORIZONTAL;

        this._items = new Map();
        this._orderedItems = [];

        // Drag n' Drop
        this._placeholders = new Map();

        this._overshootTimeoutId = 0;
        this._lastOvershoot = -1;
        this._lastOvershootTimeoutId = 0;
        this._delayedMoveData = null;

        this._connectDnD();

        this.connect('destroy', this._onDestroy.bind(this));

        this._previewedPages = new Map();
    }

    _onDestroy() {
        if (this._swipeTracker) {
            this._swipeTracker.destroy();
            delete this._swipeTracker;
        }

        this._removeDelayedMove();
        this._disconnectDnD();
    }

    _createGrid() {
        const appGrid = new AppGrid({allow_incomplete_pages: true});

const phoneGridModes = [
    {
        rows: 4,
        columns: 4,
    },
    {
        rows: 3,
        columns: 6,
    },
    {
        rows: 2,
        columns: 8,
    },
];

        if (Main.layoutManager.isPhone)
            appGrid.setGridModes(phoneGridModes);

        return appGrid;
    }

    _onScroll(actor, event) {
        if (this._swipeTracker.canHandleScrollEvent(event))
            return Clutter.EVENT_PROPAGATE;

        if (!this._canScroll)
            return Clutter.EVENT_STOP;

        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        const vertical = this._orientation === Clutter.Orientation.VERTICAL;

        let nextPage = this._grid.currentPage;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            nextPage -= 1;
            break;

        case Clutter.ScrollDirection.DOWN:
            nextPage += 1;
            break;

        case Clutter.ScrollDirection.LEFT:
            if (vertical)
                return Clutter.EVENT_STOP;
            nextPage += rtl ? 1 : -1;
            break;

        case Clutter.ScrollDirection.RIGHT:
            if (vertical)
                return Clutter.EVENT_STOP;
            nextPage += rtl ? -1 : 1;
            break;

        default:
            return Clutter.EVENT_STOP;
        }

        this.goToPage(nextPage);

        this._canScroll = false;
        this._scrollTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            SCROLL_TIMEOUT_TIME, () => {
                this._canScroll = true;
                this._scrollTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });

        return Clutter.EVENT_STOP;
    }

    _swipeBegin(tracker, monitor) {
        if (monitor !== Main.layoutManager.primaryIndex)
            return;

        const adjustment = this._adjustment;
        let wasEasingTo = null
        const transition = adjustment.get_transition('value');
        if (transition) {
            wasEasingTo = transition.get_interval().peek_final_value()
                / adjustment.page_size;
            adjustment.remove_transition('value');
        }

        const progress = adjustment.value / adjustment.page_size;
        const points = Array.from({ length: this._grid.nPages }, (v, i) => i);
        const size = tracker.orientation === Clutter.Orientation.VERTICAL
            ? this._grid.allocation.get_height() : this._grid.allocation.get_width();

        tracker.confirmSwipe(size, points, progress, Math.round(progress), wasEasingTo);
    }

    _swipeUpdate(tracker, progress) {
        const adjustment = this._adjustment;
        adjustment.value = progress * adjustment.page_size;
    }

    _swipeEnd(tracker, duration, endProgress, endCb) {
        const adjustment = this._adjustment;
        const value = endProgress * adjustment.page_size;

        adjustment.ease(value, {
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            duration,
            onStopped: endCb,
            onComplete: () => this.goToPage(endProgress, false),
        });
    }

    _connectDnD() {
        this._dragBeginId =
            Main.overview.connect('item-drag-begin', this._onDragBegin.bind(this));
        this._dragEndId =
            Main.overview.connect('item-drag-end', this._onDragEnd.bind(this));
        this._dragCancelledId =
            Main.overview.connect('item-drag-cancelled', this._onDragCancelled.bind(this));
    }

    _disconnectDnD() {
        if (this._dragBeginId > 0) {
            Main.overview.disconnect(this._dragBeginId);
            this._dragBeginId = 0;
        }

        if (this._dragEndId > 0) {
            Main.overview.disconnect(this._dragEndId);
            this._dragEndId = 0;
        }

        if (this._dragCancelledId > 0) {
            Main.overview.disconnect(this._dragCancelledId);
            this._dragCancelledId = 0;
        }

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
    }

    _createPlaceholder(source) {
        const appSys = Shell.AppSystem.get_default();
        const app = appSys.lookup_app(source.id);

        const isDraggable =
            global.settings.is_writable('favorite-apps') ||
            global.settings.is_writable('app-picker-layout');

        const placeholder = new AppIcon(app, { isDraggable });

        this._placeholders.set(source, placeholder);

        return placeholder;
    }

    _maybeMoveItem(dragEvent) {
        const [success, x, y] =
            this._grid.transform_stage_point(dragEvent.x, dragEvent.y);

        if (!success)
            return;

        const { source } = dragEvent;
        const [page, position, dragLocation] =
            this._getDropTarget(x, y, source);
        const item = position !== -1
            ? this._grid.getItemAt(page, position) : null;


        // Dragging over invalid parts of the grid cancels the timeout
        if (item === source ||
            this._adjustment.get_transition('value') !== null ||
            page !== this._grid.currentPage ||
            dragLocation === IconGrid.DragLocation.INVALID ||
            dragLocation === IconGrid.DragLocation.ON_ICON) {
            this._removeDelayedMove();
            return;
        }

        if (!this._delayedMoveData ||
            this._delayedMoveData.page !== page ||
            this._delayedMoveData.position !== position) {
            // Update the item with a small delay
            this._removeDelayedMove();
            this._delayedMoveData = {
                page,
                position,
                source,
                destroyId: source.connect('destroy', () => this._removeDelayedMove()),
                timeoutId: GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    DELAYED_MOVE_TIMEOUT, () => {
                        this._moveItem(source, page, position, true);
                        this._delayedMoveData.timeoutId = 0;
                        this._removeDelayedMove();
                        return GLib.SOURCE_REMOVE;
                    }),
            };
        }
    }

    _removeDelayedMove() {
        if (!this._delayedMoveData)
            return;

        const { source, destroyId, timeoutId  } = this._delayedMoveData;

        if (timeoutId > 0)
            GLib.source_remove(timeoutId);

        if (destroyId > 0)
            source.disconnect(destroyId);

        this._delayedMoveData = null;
    }

    _resetOvershoot() {
        if (this._lastOvershootTimeoutId)
            GLib.source_remove(this._lastOvershootTimeoutId);
        this._lastOvershootTimeoutId = 0;
        this._lastOvershoot = -1;
    }

    _handleDragOvershoot(dragEvent) {
        const [gridX, gridY] = this.get_transformed_position();
        const [gridWidth, gridHeight] = this.get_transformed_size();

        const vertical = this._orientation === Clutter.Orientation.VERTICAL;
        const gridStart = (vertical ? gridY : gridX) + OVERSHOOT_THRESHOLD;
        const gridEnd = (vertical ? gridY + gridHeight : gridX + gridWidth) - OVERSHOOT_THRESHOLD;

        // Already animating
        if (this._adjustment.get_transition('value') !== null)
            return;

        // Within the grid boundaries
        const dragPosition = vertical ? dragEvent.y : dragEvent.x;
        if (dragPosition > gridStart && dragPosition < gridEnd) {
            // Check whether we moved out the area of the last switch
            if (Math.abs(this._lastOvershoot - dragPosition) > OVERSHOOT_THRESHOLD)
                this._resetOvershoot();

            return;
        }

        // Still in the area of the previous page switch
        if (this._lastOvershoot >= 0)
            return;

        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        if (dragPosition <= gridStart)
            this.goToPage(this._grid.currentPage + (rtl ? 1 : -1));
        else if (dragPosition >= gridEnd)
            this.goToPage(this._grid.currentPage + (rtl ? -1 : 1));
        else
            return; // don't go beyond first/last page

        this._lastOvershoot = dragPosition;

        if (this._lastOvershootTimeoutId > 0)
            GLib.source_remove(this._lastOvershootTimeoutId);

        this._lastOvershootTimeoutId =
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, OVERSHOOT_TIMEOUT, () => {
                this._resetOvershoot();
                this._handleDragOvershoot(dragEvent);
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(this._lastOvershootTimeoutId,
            '[gnome-shell] this._lastOvershootTimeoutId');
    }

    _onDragBegin(overview, source) {
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };
        DND.addDragMonitor(this._dragMonitor);
        this._appGridLayout.showPageIndicators();

        if (!this._canAccept(source))
            return;

        const ownItem = this._items.get(source.id);
        if (ownItem && ownItem !== source) {
            log(`${this}: Item with id "${source.id}" already exists in grid.`);
            return;
        }

        if (this._orderedItems.includes(source)) {
            // its our icon, create a placeholder object but don't actually
            log(this + " BEGAN DRAG WITH OUR ICON, keeping the icon " + source + " v2" + this._orderedItems.indexOf(source));

            this._placeholders.set(source, source);
            source.reactive = false;
            source.opacity = 0;
        } else {
            // icon from somebody else, create real pl
         //   log(this + " BEGAN DRAG WITH FOREIGN ICON, creating placeholder");

            const pl = this._createPlaceholder(source);

            this._addItem(pl, this._grid.currentPage, -1);

            pl.reactive = false;
            pl.opacity = 0;
        }
    }

    _onDragMotion(dragEvent) {
        if (!(dragEvent.source instanceof AppViewItem))
            return DND.DragMotionResult.CONTINUE;

if (!this.mapped)
            return DND.DragMotionResult.CONTINUE;

        const placeholder = this._placeholders.get(dragEvent.source);
        if (!placeholder)
            return DND.DragMotionResult.CONTINUE;

        const clonedEvent = {
            ...dragEvent,
            source: placeholder,
        };

        const [success, x, y] =
            this._grid.transform_stage_point(dragEvent.x, dragEvent.y);

        if (!success)
            return DND.DragMotionResult.CONTINUE;

        // Handle the drag overshoot. When dragging to above the
        // icon grid, move to the page above; when dragging below,
        // move to the page below.
        if (placeholder instanceof AppViewItem)
            this._handleDragOvershoot(clonedEvent);

        this._maybeMoveItem(clonedEvent);

        return DND.DragMotionResult.CONTINUE;
    }

    _itemDraggedOut(item) {
   //     log("removed item belonged to us, saving the current layout");

        this._saveCurrentLayout();
        this.emit('view-loaded');
    }

    _clearPlaceholders(source) {
        /* DND sadly has no droppedSomewhereElse() thing */
        if (this._placeholders.has(source)) {
            const pl = this._placeholders.get(source);
            this._placeholders.delete(source);

            if (this._dragCancelled) {
                delete this._dragCancelled;

                if (pl === source) {
                    // At this point, the positions aren't stored yet, thus _redisplay()
                    // will move all items to their original positions
                    this._redisplayAfterDrag = true;
                    return;
                }
            }

            // we still have a placeholder, which means we didn't accept the drag ---> the item is gone
log(this + " removing placeholder");
            this._removeItem(pl);

            this._grid.layout_manager.resetOverflowRelocations();

            if (source === pl)
                this._itemDraggedOut(source);

            pl.destroy();
        }
    }

    _onDragEnd(overview, source) {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }

        this._resetOvershoot();
        this._appGridLayout.hidePageIndicators();

    //    log(this + " _onDragEnd, n placeholders " + this._placeholders.size);

        this._clearPlaceholders(source);

        if (this._redisplayAfterDrag) {
            this._updateFoldersIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._redisplay();

                delete this._updateFoldersIdle;
                return GLib.SOURCE_REMOVE;
            });

            delete this._redisplayAfterDrag;
        }
    }

    _onDragCancelled(overview, source) {
        this._dragCancelled = true;

        this._appGridLayout.hidePageIndicators();
    }

    _canAccept(source) {
        if (source instanceof imports.ui.dash.DashIcon &&
            !this._appFavorites.isFavorite(source.app.get_id()))
            return false;

        if (!(source instanceof AppViewItem))
            return false;

        return true;
    }

    handleDragOver(source) {
        if (!this._canAccept(source))
            return DND.DragMotionResult.NO_DROP;

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        const dropTarget = this._dropTarget;
        delete this._dropTarget;

        if (!this._canAccept(source))
            return false;

        const pl = this._placeholders.get(source);
        if (!pl) {
            throw new Error('No placeholder item found for drag source');
            return false;
        }

        if (AppFavorites.getAppFavorites().isFavorite(source.id))
            AppFavorites.getAppFavorites().removeFavorite(source.id);

        if (dropTarget === this._prevPageIndicator ||
            dropTarget === this._nextPageIndicator) {
            const increment = dropTarget === this._prevPageIndicator ? -1 : 1;
            const { currentPage, nPages, itemsPerPage } = this._grid;
            const page = Math.min(currentPage + increment, nPages);

            if (page < nPages &&
                this._grid.getItemsAtPage(page).filter(c => c.visible).length === itemsPerPage)
                return false;

            this._moveItem(pl, page, -1, true);
            this.goToPage(page);
        } else if (this._delayedMoveData) {
            // Dropped before the icon was moved
            const { page, position } = this._delayedMoveData;

            this._moveItem(pl, page, position);
            this._removeDelayedMove();
        }

        this._grid.layout_manager.storeRelocations();
log(this + " accepting drop, deleting placeholder: " + this._placeholders.get(source));
        pl.undoScaleAndFade();
        this._placeholders.delete(source); // this magically makes the placeholder a "normal" icon

     //   log("now saving the current layout");
        this._saveCurrentLayout();
        this.emit('view-loaded');


        return true;
    }

    _getLinearPosition(item) {
        const [page, position] = this._grid.getItemPosition(item);
        if (page === -1 || position === -1)
            throw new Error('Item not found in grid');

        let itemIndex = 0;

        if (this._grid.nPages > 0) {
            for (let i = 0; i < page; i++)
                itemIndex += this._grid.getItemsAtPage(i).filter(c => c.visible).length;

            itemIndex += position;
        }

        return itemIndex;
    }

    _saveCurrentLayout() {
    }

    _addItem(item, page, position) {
        this._items.set(item.id, item);
        this._grid.addItem(item, page, position);

        this._orderedItems.splice(this._getLinearPosition(item), 0, item);
    }

    _removeItem(item) {
        const iconIndex = this._orderedItems.indexOf(item);

        this._orderedItems.splice(iconIndex, 1);
        this._items.delete(item.id);
        this._grid.removeItem(item);
    }

    _getItemPosition(item) {
        const { itemsPerPage } = this._grid;

        let iconIndex = this._orderedItems.indexOf(item);
        if (iconIndex === -1)
            iconIndex = this._orderedItems.length - 1;

        const page = Math.floor(iconIndex / itemsPerPage);
        const position = iconIndex % itemsPerPage;

        return [page, position];
    }

    _redisplay() {
        let oldApps = this._orderedItems.slice();
        let oldAppIds = oldApps.map(icon => icon.id);

        let newApps = this._loadApps().sort(this._compareItems.bind(this));
        let newAppIds = newApps.map(icon => icon.id);

        let addedApps = newApps.filter(icon => !oldAppIds.includes(icon.id));
        let removedApps = oldApps.filter(icon => !newAppIds.includes(icon.id));

        // Remove old app icons
        removedApps.forEach(icon => {
            this._removeItem(icon);
            icon.destroy();
        });

        // Add new app icons, or move existing ones
        newApps.forEach(icon => {
            const [page, position] = this._getItemPosition(icon);
            if (addedApps.includes(icon)) {
                // If there's two pages, newly installed apps should not appear
                // on page 0
                if (page === -1 && position === -1 && this._grid.nPages > 1)
                    this._addItem(icon, 1, -1);
                else
                    this._addItem(icon, page, position);
            } else if (page !== -1 && position !== -1) {
                this._moveItem(icon, page, position);
            } else {
                // App is part of a folder
            }
        });

        const viewChanged = addedApps.length > 0 || removedApps.length > 0;

        this.emit('view-loaded');
    }

    getAllItems() {
        const items = this._orderedItems;

        if (this._placeholders.size > 0) {
            for (const [source, pl] of this._placeholders.entries()) {
                if (source === pl)
                    continue;
                items.splice(items.indexOf(pl), 1);
            }
        }

        return items;
    }

    _compareItems(a, b) {
        return a.name.localeCompare(b.name);
    }

    _selectAppInternal(id) {
        if (this._items.has(id))
            this._items.get(id).navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        else
            log(`No such application ${id}`);
    }

    selectApp(id) {
        if (this._items.has(id)) {
            let item = this._items.get(id);

            if (item.mapped) {
                this._selectAppInternal(id);
            } else {
                // Need to wait until the view is mapped
                let signalId = item.connect('notify::mapped', actor => {
                    if (actor.mapped) {
                        actor.disconnect(signalId);
                        this._selectAppInternal(id);
                    }
                });
            }
        } else {
            // Need to wait until the view is built
            let signalId = this.connect('view-loaded', () => {
                this.disconnect(signalId);
                this.selectApp(id);
            });
        }
    }

    _getDropTarget(x, y, source) {
        const [sourcePage, sourcePosition] = this._grid.getItemPosition(source);
        let [targetPage, targetPosition, dragLocation] = this._grid.getDropTarget(x, y);

        let reflowDirection = 'right';

        if (sourcePosition === targetPosition)
            reflowDirection = 'none';

        if (sourcePage === targetPage && sourcePosition < targetPosition)
            reflowDirection = 'left';
        if (!this._grid.layout_manager.allow_incomplete_pages && sourcePage < targetPage)
            reflowDirection = 'left';

        // In case we're hovering over the edge of an item but the
        // reflow will happen in the opposite direction (the drag
        // can't "naturally push the item away"), we instead set the
        // drop target to the adjacent item that can be pushed away
        // in the reflow-direction.
        //
        // We must avoid doing that if we're hovering over the first
        // or last column though, in that case there is no adjacent
        // icon we could push away.
        if (dragLocation === IconGrid.DragLocation.START_EDGE && reflowDirection === 'left') {
            const nColumns = this._grid.layout_manager.columns_per_page;
            const targetColumn = targetPosition % nColumns;

            if (targetColumn > 0) {
                targetPosition -= 1;
                dragLocation = IconGrid.DragLocation.END_EDGE;
            }
        } else if (dragLocation === IconGrid.DragLocation.END_EDGE && reflowDirection === 'right') {
            const nColumns = this._grid.layout_manager.columns_per_page;
            const targetColumn = targetPosition % nColumns;

            if (targetColumn < nColumns - 1) {
                targetPosition += 1;
                dragLocation = IconGrid.DragLocation.START_EDGE;
            }
        }

        return [targetPage, targetPosition, dragLocation];
    }

    _moveItem(item, newPage, newPosition, relo = false) {
        this._grid.moveItem(item, newPage, newPosition, relo);

        // Update the _orderedItems array
        this._orderedItems.splice(this._orderedItems.indexOf(item), 1);
        this._orderedItems.splice(this._getLinearPosition(item), 0, item);
    }

    vfunc_map() {
        this._swipeTracker.enabled = true;
        super.vfunc_map();
    }

    vfunc_unmap() {
        this._swipeTracker.enabled = false;
        super.vfunc_unmap();
    }

    animateSwitch(animationDirection) {
        this.remove_all_transitions();
        this._grid.remove_all_transitions();

        let params = {
            duration: VIEWS_SWITCH_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        };
        if (animationDirection == IconGrid.AnimationDirection.IN) {
            this.show();
            params.opacity = 255;
            params.delay = VIEWS_SWITCH_ANIMATION_DELAY;
        } else {
            params.opacity = 0;
            params.delay = 0;
            params.onComplete = () => this.hide();
        }

        this._grid.ease(params);
    }

    goToPage(pageNumber, animate = true) {
        pageNumber = Math.clamp(pageNumber, 0, this._grid.nPages - 1);

        if (this._grid.currentPage === pageNumber)
            return;

        this._appGridLayout.goToPage(pageNumber, animate);
        this._grid.goToPage(pageNumber, animate);
    }

    removeItemById(id) {
        const item = this._orderedItems.find(i => i.id === id);
        this._removeItem(item);
        this._saveCurrentLayout();
        this.emit('view-loaded');
    }
});

var PageManager = GObject.registerClass({
    Signals: { 'layout-changed': {} },
}, class PageManager extends GObject.Object {
    _init() {
        super._init();

        this._settingsKey = Main.layoutManager.isPhone
            ? 'app-picker-layout-mobile' : 'app-picker-layout';

        Main.layoutManager.connect('notify::is-phone', () => {
            this._settingsKey = Main.layoutManager.isPhone
                ? 'app-picker-layout-mobile' : 'app-picker-layout';
            this._loadPages();
        });

        this._updatingPages = false;
        this._loadPages();

        global.settings.connect(`changed::${this._settingsKey}`,
            this._loadPages.bind(this));
    }

    _loadPages() {
        const layout = global.settings.get_value(this._settingsKey);
        this._pages = layout.recursiveUnpack();
        if (!this._updatingPages)
            this.emit('layout-changed');
    }

    getAppPosition(appId) {
        let position = -1;
        let page = -1;

        for (let pageIndex = 0; pageIndex < this._pages.length; pageIndex++) {
            const pageData = this._pages[pageIndex];

            if (appId in pageData) {
                page = pageIndex;
                position = pageData[appId].position;
                break;
            }
        }

        return [page, position];
    }

    set pages(p) {
        const packedPages = [];

        // Pack the icon properties as a GVariant
        for (const page of p) {
            const pageData = {};
            for (const [appId, properties] of Object.entries(page))
                pageData[appId] = new GLib.Variant('a{sv}', properties);
            packedPages.push(pageData);
        }

        this._updatingPages = true;

        const variant = new GLib.Variant('aa{sv}', packedPages);
        global.settings.set_value(this._settingsKey, variant);

        this._updatingPages = false;
    }

    get pages() {
        return this._pages;
    }
});

var AppDisplay = GObject.registerClass(
class AppDisplay extends BaseAppView {
    _init() {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        this._pageManager = new PageManager();
        this._pageManager.connect('layout-changed', () => this._redisplay());

        this.add_child(this._box);

        this._folderIcons = [];

        this._currentDialog = null;
        this._displayingDialog = false;

        if (!Main.layoutManager.isPhone)
            Main.overview.connect('hidden', () => this.goToPage(0));

        this._redisplayWorkId = Main.initializeDeferredWork(this, this._redisplay.bind(this));

        Shell.AppSystem.get_default().connect('installed-changed', () => {
//            Main.queueDeferredWork(this._redisplayWorkId);

            if (this._dragMonitor) {
log("installed change, REDISP after drag");
                this._redisplayAfterDrag = true;
                return;
            }
log("installed change redisp");
            this._redisplay();
        });
        this._folderSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
        this._ensureDefaultFolders();
        this._folderSettings.connect('changed::folder-children', () => {
            if (this._updatingFolders)
                return;

            this._updateFoldersIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._redisplay();

                delete this._updateFoldersIdle;
                return GLib.SOURCE_REMOVE;
            });
        });

        // Filter the apps through the user’s parental controls.
        this._parentalControlsManager.connectObject('app-filter-changed',
            () => this._redisplay(), this);

        // Don't duplicate favorites
        this._appFavorites.connectObject('changed', () => {
log("DASH CHANGE");
            if (this._dragMonitor) {
                this._redisplayAfterDrag = true;
                return;
            }

            this._redisplay();
        }, this);

    }

    _onDestroy() {
        super._onDestroy();

        if (this._scrollTimeoutId !== 0) {
            GLib.source_remove(this._scrollTimeoutId);
            this._scrollTimeoutId = 0;
        }
    }

    vfunc_map() {
        this._keyPressEventId =
            global.stage.connect('key-press-event',
                this._onKeyPressEvent.bind(this));
        super.vfunc_map();
    }

    vfunc_unmap() {
        if (this._keyPressEventId) {
            global.stage.disconnect(this._keyPressEventId);
            this._keyPressEventId = 0;
        }
        super.vfunc_unmap();
    }

    _redisplay() {
        this._folderIcons.forEach(icon => {
            icon.view._redisplay();
        });

        super._redisplay();
    }

    _saveCurrentLayout() {
        const pages = [];

        for (let i = 0; i < this._grid.nPages; i++) {
            const pageItems =
                this._grid.getItemsAtPage(i).filter(c => c.visible);
            const pageData = {};

            pageItems.forEach((item, index) => {
                if (Array.from(this._placeholders.values()).includes(item))
                    throw new Error('Saving layout while placeholders are around');

                pageData[item.id] = {
                    position: GLib.Variant.new_int32(index),
                };
            });
            pages.push(pageData);
        }

        this._pageManager.pages = pages;
    }

    _ensureDefaultFolders() {
        if (this._folderSettings.get_strv('folder-children').length > 0)
            return;

        const folders = Object.keys(DEFAULT_FOLDERS);
        this._folderSettings.set_strv('folder-children', folders);

        const { path } = this._folderSettings;
        for (const folder of folders) {
            const { name, categories, apps } = DEFAULT_FOLDERS[folder];
            const child = new Gio.Settings({
                schema_id: 'org.gnome.desktop.app-folders.folder',
                path: `${path}folders/${folder}/`,
            });
            child.set_string('name', name);
            child.set_boolean('translate', true);
            child.set_strv('categories', categories);
            if (apps)
                child.set_strv('apps', apps);
        }
    }

    getAppInfos() {
        return this._appInfoList;
    }

    _getItemPosition(item) {
        return this._pageManager.getAppPosition(item.id);
    }

    _compareItems(a, b) {
        const [aPage, aPosition] = this._getItemPosition(a);
        const [bPage, bPosition] = this._getItemPosition(b);

        if (aPage === -1 && bPage === -1)
            return a.name.localeCompare(b.name);
        else if (aPage === -1)
            return 1;
        else if (bPage === -1)
            return -1;

        if (aPage !== bPage)
            return aPage - bPage;

        return aPosition - bPosition;
    }

    _loadApps() {
        let appIcons = [];
        this._appInfoList = Shell.AppSystem.get_default().get_installed().filter(appInfo => {
            try {
                appInfo.get_id(); // catch invalid file encodings
            } catch (e) {
                return false;
            }
            const isInDash = !Main.layoutManager.isPhone &&
                this._appFavorites.isFavorite(appInfo.get_id());
            const parentalControlsAllowed =
                this._parentalControlsManager.shouldShowApp(appInfo);

            return !isInDash && parentalControlsAllowed;
        });

        let apps = this._appInfoList.map(app => app.get_id());

        let appSys = Shell.AppSystem.get_default();

        const appsInsideFolders = new Set();
        this._folderIcons = [];

        let folders = this._folderSettings.get_strv('folder-children');
        folders.forEach(id => {
            let path = `${this._folderSettings.path}folders/${id}/`;
            let newlyCreated = false;

            let icon = this._items.get(id);
            if (!icon) {
                newlyCreated = true;

log("creating new folder for id " + id);
                icon = new FolderIcon(id, path, this);
            }

            // Remove any duplicate apps in the folders
            let folderAppItems = icon.view.getAllItems();
            folderAppItems.forEach(item => {
                if (appsInsideFolders.has(item.id)) {
                    log("FOUND DUPE " + item.id)
                    icon.view.removeItemById(item.id);
                }
            });

            folderAppItems = icon.view.getAllItems();
            if (folderAppItems.length <= 1) {
log("DESTROYING FOLDER with less than one (" + folderAppItems.length + "): " + id + " have " +this._items.has(id));

                this.deleteFolder(id);
                if (newlyCreated)
                    icon.destroy();
                return;
            }

            folderAppItems.forEach(item => {
                appsInsideFolders.add(item.id);
            });

            this._folderIcons.push(icon);
            appIcons.push(icon);
        });

        // Allow dragging of the icon only if the Dash would accept a drop to
        // change favorite-apps. There are no other possible drop targets from
        // the app picker, so there's no other need for a drag to start,
        // at least on single-monitor setups.
        // This also disables drag-to-launch on multi-monitor setups,
        // but we hope that is not used much.
        const isDraggable =
            global.settings.is_writable('favorite-apps') ||
            global.settings.is_writable('app-picker-layout');

        apps.forEach(appId => {
            if (appsInsideFolders.has(appId))
                return;

            let icon = this._items.get(appId);
            if (!icon) {
                let app = appSys.lookup_app(appId);

                icon = new AppIcon(app, { isDraggable });
            }

            appIcons.push(icon);
        });


        return appIcons;
    }

    animateSwitch(animationDirection) {
        super.animateSwitch(animationDirection);

        if (this._currentDialog && this._displayingDialog &&
            animationDirection == IconGrid.AnimationDirection.OUT) {
            this._currentDialog.ease({
                opacity: 0,
                duration: VIEWS_SWITCH_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => (this.opacity = 255),
            });
        }
    }

    goToPage(pageNumber, animate = true) {
        pageNumber = Math.clamp(pageNumber, 0, this._grid.nPages - 1);

        if (this._grid.currentPage === pageNumber &&
            this._displayingDialog &&
            this._currentDialog)
            return;
        if (this._displayingDialog && this._currentDialog)
            this._currentDialog.popdown();

        super.goToPage(pageNumber, animate);
    }

    _onScroll(actor, event) {
        if (this._displayingDialog || !this._scrollView.reactive)
            return Clutter.EVENT_STOP;

        return super._onScroll(actor, event);
    }

    _onKeyPressEvent(actor, event) {
        if (this._displayingDialog)
            return Clutter.EVENT_STOP;

        if (event.get_key_symbol() === Clutter.KEY_Page_Up) {
            this.goToPage(this._grid.currentPage - 1);
            return Clutter.EVENT_STOP;
        } else if (event.get_key_symbol() === Clutter.KEY_Page_Down) {
            this.goToPage(this._grid.currentPage + 1);
            return Clutter.EVENT_STOP;
        } else if (event.get_key_symbol() === Clutter.KEY_Home) {
            this.goToPage(0);
            return Clutter.EVENT_STOP;
        } else if (event.get_key_symbol() === Clutter.KEY_End) {
            this.goToPage(this._grid.nPages - 1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    addFolderDialog(dialog) {
        Main.layoutManager.overviewGroup.add_child(dialog);
        dialog.connect('open-state-changed', (o, isOpen) => {
            this._currentDialog?.disconnectObject(this);

            this._currentDialog = null;

            if (isOpen) {
                this._currentDialog = dialog;
                this._currentDialog.connectObject('destroy',
                    () => (this._currentDialog = null), this);
            }
            this._displayingDialog = isOpen;
        });
    }

    _onDragMotion(dragEvent) {
        if (this._currentDialog)
            return DND.DragMotionResult.CONTINUE;

        return super._onDragMotion(dragEvent);
    }

    createFolderFromAppItem(appItem, dragSource) {
        const [folderPage, folderPosition] =
            this._grid.getItemPosition(appItem);

        if (folderPage === -1 && folderPosition === -1)
            throw new Error('Unable to find app item for new folder');

        const newFolderId = GLib.uuid_string_random();
log("MAKING FOLDER " + newFolderId);

        let folders = this._folderSettings.get_strv('folder-children');
        folders.push(newFolderId);
        this._updatingFolders = true;
        this._folderSettings.set_strv('folder-children', folders);
        this._updatingFolders = false;

        // Create the new folder
        let newFolderPath = this._folderSettings.path.concat('folders/', newFolderId, '/');
        let newFolderSettings;
        try {
            newFolderSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.app-folders.folder',
                path: newFolderPath,
            });
        } catch (e) {
            log('Error creating new folder');
            return false;
        }

        let folderName = _findBestFolderName([appItem.app.get_app_info(), dragSource.app.get_app_info()]);
        if (!folderName)
            folderName = _("Unnamed Folder");

        newFolderSettings.delay();
        newFolderSettings.set_string('name', folderName);
        newFolderSettings.set_strv('apps', [appItem.id, dragSource.id]);
        newFolderSettings.apply();

        if (this._appFavorites.isFavorite(dragSource.id))
            this._appFavorites.removeFavorite(dragSource.id);

        const folderItem = new FolderIcon(newFolderId, newFolderPath, this);

        const folderAppItems = folderItem.view.getAllItems();
        if (folderAppItems.length !== 2) {
log("make deleting EMPTY FOLDER again, shouldnt happen");
            this.deleteFolder(newFolderId);
            folderItem.destroy();
            return false;
        }

        // FIXME: might be even cooler to just call acceptDrop on the new view here

        this._removeItem(appItem);
        appItem.destroy();
        // leave removal of dragSource to onDragEnd() handler

        this._folderIcons.push(folderItem);
        this._addItem(folderItem, folderPage, folderPosition);

        // onDragEnd will save current layout in a sec

        return true;
    }

    deleteFolder(folderId, lastApp = null) {
log("DELETING FOLDER id " + folderId + " app " + lastApp);

        const defaultFolderIds = Object.keys(DEFAULT_FOLDERS);

        // default folders get special treatment, if we were to destroy them,
        // we'd recreate them again when 0 folders exist
        if (!defaultFolderIds.includes(folderId)) {
            const folderPath = this._folderSettings.path.concat('folders/', folderId, '/');
            const folderSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.app-folders.folder',
                path: folderPath,
            });

            // Resetting all keys deletes the relocatable schema
            const keys = folderSettings.settings_schema.list_keys();
            for (const key of keys)
                folderSettings.reset(key);

            const folders = this._folderSettings.get_strv('folder-children');
            folders.splice(folders.indexOf(folderId), 1);
            this._updatingFolders = true;
            this._folderSettings.set_strv('folder-children', folders);
            this._updatingFolders = false;
        }


        if (!lastApp)
            return;

        const folderItem = this._items.get(folderId);

        const [folderPage, folderPosition] =
            this._grid.getItemPosition(folderItem);

        if (folderPage === -1 && folderPosition === -1)
            throw new Error(`Item of folder "${folderId}" is not in the grid`);

        this._folderIcons.splice(this._folderIcons.indexOf(folderItem), 1);
        this._removeItem(folderItem);

        folderItem.destroy();

        const isDraggable =
            global.settings.is_writable('favorite-apps') ||
            global.settings.is_writable('app-picker-layout');

        const appSys = Shell.AppSystem.get_default();
        const app = appSys.lookup_app(lastApp.get_id());

        const item = new AppIcon(app, { isDraggable });
log("additing item mat " + folderPage + " as " + folderPosition);

        this._addItem(item, folderPage, folderPosition);

        this._saveCurrentLayout();
    }
});

var AppSearchProvider = class AppSearchProvider {
    constructor() {
        this._appSys = Shell.AppSystem.get_default();
        this.id = 'applications';
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;

        this._systemActions = new SystemActions.getDefault();

        this._parentalControlsManager = ParentalControlsManager.getDefault();
    }

    getResultMetas(apps) {
        const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
        let metas = [];
        for (let id of apps) {
            if (id.endsWith('.desktop')) {
                let app = this._appSys.lookup_app(id);

                metas.push({
                    id: app.get_id(),
                    name: app.get_name(),
                    createIcon: size => app.create_icon_texture(size),
                });
            } else {
                let name = this._systemActions.getName(id);
                let iconName = this._systemActions.getIconName(id);

                const createIcon = size => new St.Icon({
                    icon_name: iconName,
                    width: size * scaleFactor,
                    height: size * scaleFactor,
                    style_class: 'system-action-icon',
                });

                metas.push({ id, name, createIcon });
            }
        }

        return new Promise(resolve => resolve(metas));
    }

    filterResults(results, maxNumber) {
        return results.slice(0, maxNumber);
    }

    getInitialResultSet(terms, cancellable) {
        // Defer until the parental controls manager is initialised, so the
        // results can be filtered correctly.
        if (!this._parentalControlsManager.initialized) {
            return new Promise(resolve => {
                let initializedId = this._parentalControlsManager.connect('app-filter-changed', async () => {
                    if (this._parentalControlsManager.initialized) {
                        this._parentalControlsManager.disconnect(initializedId);
                        resolve(await this.getInitialResultSet(terms, cancellable));
                    }
                });
            });
        }

        let query = terms.join(' ');
        let groups = Shell.AppSystem.search(query);
        let usage = Shell.AppUsage.get_default();
        let results = [];

        groups.forEach(group => {
            group = group.filter(appID => {
                const app = this._appSys.lookup_app(appID);
                return app && this._parentalControlsManager.shouldShowApp(app.app_info);
            });
            results = results.concat(group.sort(
                (a, b) => usage.compare(a, b)));
        });

        results = results.concat(this._systemActions.getMatchingActions(terms));
        return new Promise(resolve => resolve(results));
    }

    getSubsearchResultSet(previousResults, terms, cancellable) {
        return this.getInitialResultSet(terms, cancellable);
    }

    createResultObject(resultMeta) {
        if (resultMeta.id.endsWith('.desktop')) {
            return new AppIcon(this._appSys.lookup_app(resultMeta['id']), {
                expandTitleOnHover: false,
            });
        } else {
            return new SystemActionIcon(this, resultMeta);
        }
    }
};

var AppViewItem = GObject.registerClass(
class AppViewItem extends St.Button {
    _init(params = {}, isDraggable = true, expandTitleOnHover = true) {
        super._init({
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            reactive: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            can_focus: true,
            ...params,
        });

        this._delegate = this;

        if (isDraggable) {
            this._draggable = DND.makeDraggable(this, { timeoutThreshold: 200 });

            this._draggable.connect('drag-begin', this._onDragBegin.bind(this));
            this._draggable.connect('drag-cancelled', this._onDragCancelled.bind(this));
            this._draggable.connect('drag-end', this._onDragEnd.bind(this));
        }

        this._otherIconIsHovering = false;
        this._expandTitleOnHover = expandTitleOnHover;

        if (expandTitleOnHover)
            this.connect('notify::hover', this._onHover.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }

        if (this._draggable) {
            if (this._dragging)
                Main.overview.endItemDrag(this);
            this._draggable = null;
        }
    }

    _updateMultiline() {
        if (!this._expandTitleOnHover || !this.icon.label)
            return;

        const { label } = this.icon;
        const { clutterText } = label;
        const layout = clutterText.get_layout();
        if (!layout.is_wrapped() && !layout.is_ellipsized())
            return;

        label.remove_transition('allocation');

        const id = label.connect('notify::allocation', () => {
            label.restore_easing_state();
            label.disconnect(id);
        });

        const expand = this._forcedHighlight || this.hover || this.has_key_focus();
        label.save_easing_state();
        label.set_easing_duration(expand
            ? APP_ICON_TITLE_EXPAND_TIME
            : APP_ICON_TITLE_COLLAPSE_TIME);
        clutterText.set({
            line_wrap: expand,
            line_wrap_mode: expand ? Pango.WrapMode.WORD_CHAR : Pango.WrapMode.NONE,
            ellipsize: expand ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END,
        });
    }

    _onHover() {
        this._updateMultiline();
    }

    _onDragBegin() {
        this._dragging = true;
        this.scaleAndFade();
        Main.overview.beginItemDrag(this);
global.stage.set_key_focus(null); // hack to fix annoying moves when something has key focus
    }

    _onDragCancelled() {
        this._dragging = false;
        Main.overview.cancelledItemDrag(this);
    }

    _onDragEnd() {
        this._dragging = false;
        this.undoScaleAndFade();
        Main.overview.endItemDrag(this);
    }

    scaleIn() {
        this.scale_x = 0;
        this.scale_y = 0;

        this.ease({
            scale_x: 1,
            scale_y: 1,
            duration: APP_ICON_SCALE_IN_TIME,
            delay: APP_ICON_SCALE_IN_DELAY,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });
    }

    scaleAndFade() {
        this.reactive = false;
        this.ease({
            scale_x: 0.5,
            scale_y: 0.5,
            opacity: 0,
        });
    }

    undoScaleAndFade() {
        this.reactive = true;
        this.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            opacity: 255,
        });
    }

    _canAccept(source) {
        return source !== this;
    }

    _setHoveringByDnd(hovering) {
        if (this._otherIconIsHovering === hovering)
            return;

        this._otherIconIsHovering = hovering;

        if (hovering) {
            this._dragMonitor = {
                dragMotion: this._onDragMotion.bind(this),
            };
            DND.addDragMonitor(this._dragMonitor);
        } else {
            DND.removeDragMonitor(this._dragMonitor);
        }
    }

    _onDragMotion(dragEvent) {
        if (!this.contains(dragEvent.targetActor))
            this._setHoveringByDnd(false);

        return DND.DragMotionResult.CONTINUE;
    }

    _withinLeeways(x) {
        return x < IconGrid.LEFT_DIVIDER_LEEWAY ||
            x > this.width - IconGrid.RIGHT_DIVIDER_LEEWAY;
    }

    vfunc_key_focus_in() {
        this._updateMultiline();
        super.vfunc_key_focus_in();
    }

    vfunc_key_focus_out() {
        this._updateMultiline();
        super.vfunc_key_focus_out();
    }

    handleDragOver(source, _actor, x) {
        if (source === this)
            return DND.DragMotionResult.NO_DROP;

        if (!this._canAccept(source))
            return DND.DragMotionResult.CONTINUE;

        if (this._withinLeeways(x)) {
            this._setHoveringByDnd(false);
            return DND.DragMotionResult.CONTINUE;
        }

        this._setHoveringByDnd(true);

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, _actor, x) {
        this._setHoveringByDnd(false);

        if (!this._canAccept(source))
            return false;

        if (this._withinLeeways(x))
            return false;

        return true;
    }

    get id() {
        return this._id;
    }

    get name() {
        return this._name;
    }

    setForcedHighlight(highlighted) {
        this._forcedHighlight = highlighted;
        this.set({
            track_hover: !highlighted,
            hover: highlighted,
        });
    }
});

var FolderGrid = GObject.registerClass(
class FolderGrid extends AppGrid {
    _init() {
        super._init({
            allow_incomplete_pages: false,
            columns_per_page: 3,
            rows_per_page: 3,
            page_halign: Clutter.ActorAlign.FILL,
            page_valign: Clutter.ActorAlign.FILL,
        });

        this.setGridModes([
            {
                rows: 3,
                columns: 3,
            },
        ]);
    }
});

var FolderView = GObject.registerClass(
class FolderView extends BaseAppView {
    _init(folder, id, parentView) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            gesture_modes: Shell.ActionMode.POPUP,
        });

        // If it not expand, the parent doesn't take into account its preferred_width when allocating
        // the second time it allocates, so we apply the "Standard hack for ClutterBinLayout"
        this._grid.x_expand = true;
        this._id = id;
        this._folder = folder;
        this._parentView = parentView;
        this._grid._delegate = this;

        this.add_child(this._box);

        this._apps = [];

        this._folder.connectObject('changed', () => {
            if (!this._savingLayout)
                this._redisplay();
        }, this);

        this._redisplay();
    }

    _createGrid() {
        return new FolderGrid();
    }

    _getItemPosition(item) {
        const appIndex = this._apps.indexOf(item.app);

        if (appIndex === -1)
            return [-1, -1];

        const { itemsPerPage } = this._grid;
        return [Math.floor(appIndex / itemsPerPage), appIndex % itemsPerPage];
    }

    _compareItems(a, b) {
        const aPosition = this._apps.indexOf(a.app);
        const bPosition = this._apps.indexOf(b.app);

        if (aPosition === -1 && bPosition === -1)
            return a.name.localeCompare(b.name);
        else if (aPosition === -1)
            return 1;
        else if (bPosition === -1)
            return -1;

        return aPosition - bPosition;
    }

    createFolderIcon(size) {
        const layout = new Clutter.GridLayout({
            row_homogeneous: true,
            column_homogeneous: true,
        });
        let icon = new St.Widget({
            layout_manager: layout,
            x_align: Clutter.ActorAlign.CENTER,
            style: `width: ${size}px; height: ${size}px;`,
        });

        let subSize = Math.floor(FOLDER_SUBICON_FRACTION * size);

        let numItems = this._orderedItems.length;
        let rtl = icon.get_text_direction() == Clutter.TextDirection.RTL;
        for (let i = 0; i < 4; i++) {
            const style = `width: ${subSize}px; height: ${subSize}px;`;
            let bin = new St.Bin({ style });
            if (i < numItems)
                bin.child = this._orderedItems[i].app.create_icon_texture(subSize);
            layout.attach(bin, rtl ? (i + 1) % 2 : i % 2, Math.floor(i / 2), 1, 1);
        }

        return icon;
    }

    _loadApps() {
        this._apps = [];
        const excludedApps = this._folder.get_strv('excluded-apps');
        const appSys = Shell.AppSystem.get_default();
        const addAppId = appId => {
            if (excludedApps.includes(appId))
                return;

            if (this._appFavorites.isFavorite(appId))
                return;

            const app = appSys.lookup_app(appId);
            if (!app)
                return;

            if (!this._parentalControlsManager.shouldShowApp(app.get_app_info()))
                return;

            if (this._apps.indexOf(app) !== -1)
                return;

            this._apps.push(app);
        };

        const folderApps = this._folder.get_strv('apps');
        folderApps.forEach(addAppId);

        const folderCategories = this._folder.get_strv('categories');
        const appInfos = this._parentView.getAppInfos();
        appInfos.forEach(appInfo => {
            let appCategories = _getCategories(appInfo);
            if (!_listsIntersect(folderCategories, appCategories))
                return;

            addAppId(appInfo.get_id());
        });

        let items = [];
        this._apps.forEach(app => {
            let icon = this._items.get(app.get_id());
            if (!icon)
                icon = new AppIcon(app);

            items.push(icon);
        });

        return items;
    }

    _canAccept(source) {
        if (!super._canAccept(source))
            return false;

        if (source instanceof FolderIcon)
            return false;

        return true;
    }

    _itemDraggedOut(item) {
        super._itemDraggedOut(item);

        if (this._orderedItems.length === 1)
            this._parentView.deleteFolder(this._id, this._orderedItems[0].app);
        else if (this._orderedItems.length === 0)
            throw new Error('There should never be a single item in a FolderView');
    }

    _saveCurrentLayout() {
        this._savingLayout = true;

        const newFolderApps = this._orderedItems.map(item => item.id);

        // If this is a categories-based folder, also update the list of excluded apps
        const categories = this._folder.get_strv('categories');
        if (categories.length > 0) {
            const oldFolderApps = this._folder.get_strv('apps');
            const removedApps =
                oldFolderApps.filter(appId => !newFolderApps.includes(appId));
            const addedApps =
                newFolderApps.filter(appId => !oldFolderApps.includes(appId));

            let excludedApps = this._folder.get_strv('excluded-apps');
            excludedApps = excludedApps.filter(app => !addedApps.includes(app));
            excludedApps.push(...removedApps);
            this._folder.set_strv('excluded-apps', excludedApps);
        }

        this._folder.set_strv('apps', newFolderApps);

        delete this._savingLayout;
    }
});

var FolderIcon = GObject.registerClass(
class FolderIcon extends AppViewItem {
    _init(id, path, parentView) {
        super._init({
            style_class: 'app-well-app app-folder',
            button_mask: St.ButtonMask.ONE,
            toggle_mode: true,
            can_focus: true,
        }, global.settings.is_writable('app-picker-layout'));
        this._id = id;
        this._name = '';
        this._parentView = parentView;

        this._folder = new Gio.Settings({
            schema_id: 'org.gnome.desktop.app-folders.folder',
            path,
        });

        this._iconContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        this.icon = new IconGrid.BaseIcon('', {
            createIcon: this._createIcon.bind(this),
            setSizeManually: true,
        });
        this._iconContainer.add_child(this.icon);

        this.set_child(this._iconContainer);

        this.view = new FolderView(this._folder, id, parentView);
        this.view.connectObject(
            'view-loaded', this._sync.bind(this), this);
        this._sync();
    }

    _onDestroy() {
        super._onDestroy();

        if (this._dialog)
            this._dialog.destroy();
        else
            this.view?.destroy();
    }

    vfunc_clicked() {
        this.open();
    }

    vfunc_unmap() {
        if (this._dialog)
            this._dialog.popdown();

        super.vfunc_unmap();
    }

    open() {
        this._ensureFolderDialog();
        this.view._scrollView.vscroll.adjustment.value = 0;
        this._dialog.popup();
    }

    _setHoveringByDnd(hovering) {
        if (this._otherIconIsHovering == hovering)
            return;

        super._setHoveringByDnd(hovering);

        if (hovering)
            this.add_style_pseudo_class('drop');
        else
            this.remove_style_pseudo_class('drop');
    }

    _onDragMotion(dragEvent) {
        if (!this._canAccept(dragEvent.source))
            this._setHoveringByDnd(false);

        return super._onDragMotion(dragEvent);
    }

    getDragActor() {
        const iconParams = {
            createIcon: this._createIcon.bind(this),
            showLabel: this.icon.label !== null,
            setSizeManually: false,
        };

        const icon = new IconGrid.BaseIcon(this.name, iconParams);
        icon.style_class = this.style_class;

        return icon;
    }

    getDragActorSource() {
        return this;
    }

    _canAccept(source) {
        if (!super._canAccept(source))
            return false;

        return this.view._canAccept(source);
    }

    acceptDrop(source) {
        if (!super.acceptDrop(source))
            return false;

        return this.view.acceptDrop(source);
    }

    _updateName() {
        let name = _getFolderName(this._folder);
        if (this.name == name)
            return;

        this._name = name;
        this.icon.label.text = this.name;
    }

    _sync() {
        this._updateName();
        this.icon.update();
    }

    _createIcon(iconSize) {
        return this.view.createFolderIcon(iconSize, this);
    }

    _ensureFolderDialog() {
        if (this._dialog)
            return;
        if (!this._dialog) {
            this._dialog = new AppFolderDialog(this, this._folder,
                this._parentView);
            this._parentView.addFolderDialog(this._dialog);
            this._dialog.connect('open-state-changed', (popup, isOpen) => {
                const duration = FOLDER_DIALOG_ANIMATION_TIME / 2;
                const mode = isOpen
                    ? Clutter.AnimationMode.EASE_OUT_QUAD
                    : Clutter.AnimationMode.EASE_IN_QUAD;

                this.ease({
                    opacity: isOpen ? 0 : 255,
                    duration,
                    mode,
                    delay: isOpen ? 0 : FOLDER_DIALOG_ANIMATION_TIME - duration,
                });

                if (!isOpen)
                    this.checked = false;
            });
        }
    }
});

var AppFolderDialog = GObject.registerClass({
    Signals: {
        'open-state-changed': { param_types: [GObject.TYPE_BOOLEAN] },
    },
}, class AppFolderDialog extends St.Bin {
    _init(source, folder, appDisplay) {
        super._init({
            visible: false,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });

        this.add_constraint(new Layout.MonitorConstraint({ primary: true }));



        this._source = source;
        this._folder = folder;
        this._view = source.view;
        this._appDisplay = appDisplay;
        this._delegate = this;

        this._isOpen = false;

        this._viewBox = new St.BoxLayout({
            style_class: 'app-folder-dialog',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            vertical: true,
        });

        this.child = new St.Bin({
            style_class: 'app-folder-dialog-container',
            child: this._viewBox,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (Main.layoutManager.isPhone)
            this.child.add_style_class_name('mobile');

        this._addFolderNameEntry();
        this._viewBox.add_child(this._view);

        global.focus_manager.add_group(this);

        const clickGesture = new Clutter.ClickGesture();
        clickGesture.connect('clicked', () => {
            const coords = clickGesture.get_coords();
            const actor =
                global.stage.get_actor_at_pos(Clutter.PickMode.ALL, coords.x, coords.y);

            if (!this._viewBox.contains(actor))
                this.popdown();

            return Clutter.EVENT_PROPAGATE;
        });
        this.add_action(clickGesture);

        this._grabHelper = new GrabHelper.GrabHelper(this, {
            actionMode: Shell.ActionMode.POPUP,
        });
        this.connect('destroy', this._onDestroy.bind(this));

        this._dragMonitor = null;
        this._sourceMappedId = 0;
        this._popdownTimeoutId = 0;
        this._needsZoomAndFade = false;

        this._popdownCallbacks = [];
    }

    _addFolderNameEntry() {
        this._entryBox = new St.BoxLayout({
            style_class: 'folder-name-container',
        });
        this._viewBox.add_child(this._entryBox);

        // Empty actor to center the title
        let ghostButton = new Clutter.Actor();
        this._entryBox.add_child(ghostButton);

        let stack = new Shell.Stack({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._entryBox.add_child(stack);

        // Folder name label
        this._folderNameLabel = new St.Label({
            style_class: 'folder-name-label',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        stack.add_child(this._folderNameLabel);

        // Folder name entry
        this._entry = new St.Entry({
            style_class: 'folder-name-entry',
            opacity: 0,
            reactive: false,
        });
        this._entry.clutter_text.set({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._entry.clutter_text.connect('activate', () => {
            this._showFolderLabel();
        });

        stack.add_child(this._entry);

        // Edit button
        this._editButton = new St.Button({
            style_class: 'edit-folder-button',
            button_mask: St.ButtonMask.ONE,
            toggle_mode: true,
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            icon_name: 'document-edit-symbolic',
        });

        this._editButton.connect('notify::checked', () => {
            if (this._editButton.checked)
                this._showFolderEntry();
            else
                this._showFolderLabel();
        });

        this._entryBox.add_child(this._editButton);

        ghostButton.add_constraint(new Clutter.BindConstraint({
            source: this._editButton,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));

        this._folder.connectObject('changed::name', () => this._syncFolderName(), this);
        this._syncFolderName();
    }

    _syncFolderName() {
        let newName = _getFolderName(this._folder);

        this._folderNameLabel.text = newName;
        this._entry.text = newName;
    }

    _switchActor(from, to) {
        to.reactive = true;
        to.ease({
            opacity: 255,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        from.ease({
            opacity: 0,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                from.reactive = false;
            },
        });
    }

    _showFolderLabel() {
        if (this._editButton.checked)
            this._editButton.checked = false;

        this._maybeUpdateFolderName();
        this._switchActor(this._entry, this._folderNameLabel);
    }

    _showFolderEntry() {
        this._switchActor(this._folderNameLabel, this._entry);

        this._entry.clutter_text.set_selection(0, -1);
        this._entry.clutter_text.grab_key_focus();
    }

    _maybeUpdateFolderName() {
        let folderName = _getFolderName(this._folder);
        let newFolderName = this._entry.text.trim();

        if (newFolderName.length === 0 || newFolderName === folderName)
            return;

        this._folder.set_string('name', newFolderName);
        this._folder.set_boolean('translate', false);
    }

    _zoomAndFadeIn() {
        let [sourceX, sourceY] =
            this._source.get_transformed_position();
        let [dialogX, dialogY] =
            this.child.get_transformed_position();

        this.child.set({
            translation_x: sourceX - dialogX,
            translation_y: sourceY - dialogY,
            scale_x: this._source.width / this.child.width,
            scale_y: this._source.height / this.child.height,
            opacity: 0,
        });

        this.ease({
            background_color: DIALOG_SHADE_NORMAL,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.child.ease({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._needsZoomAndFade = false;

        if (this._sourceMappedId === 0) {
            this._sourceMappedId = this._source.connect(
                'notify::mapped', this._zoomAndFadeOut.bind(this));
        }
    }

    _zoomAndFadeOut() {
        if (!this._isOpen)
            return;

        if (!this._source.mapped) {
            this.hide();
            return;
        }

        let [sourceX, sourceY] =
            this._source.get_transformed_position();
        let [dialogX, dialogY] =
            this.child.get_transformed_position();

        this.ease({
            background_color: Clutter.Color.from_pixel(0x00000000),
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this.child.ease({
            translation_x: sourceX - dialogX,
            translation_y: sourceY - dialogY,
            scale_x: this._source.width / this.child.width,
            scale_y: this._source.height / this.child.height,
            opacity: 0,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.child.set({
                    translation_x: 0,
                    translation_y: 0,
                    scale_x: 1,
                    scale_y: 1,
                    opacity: 255,
                });
                this.hide();

                this._popdownCallbacks.forEach(func => func());
                this._popdownCallbacks = [];
            },
        });

        this._needsZoomAndFade = false;
    }

    _removeDragMonitor() {
        if (!this._dragMonitor)
            return;

        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
    }

    _removePopdownTimeout() {
        if (this._popdownTimeoutId === 0)
            return;

        GLib.source_remove(this._popdownTimeoutId);
        this._popdownTimeoutId = 0;
    }

    _onDestroy() {
        if (this._isOpen) {
            this._isOpen = false;
            this._grabHelper.ungrab({ actor: this });
            this._grabHelper = null;
        }

        if (this._sourceMappedId) {
            this._source.disconnect(this._sourceMappedId);
            this._sourceMappedId = 0;
        }

        this._removePopdownTimeout();
        this._removeDragMonitor();
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);

        // We can only start zooming after receiving an allocation
        if (this._needsZoomAndFade)
            this._zoomAndFadeIn();
    }

    vfunc_key_press_event(keyEvent) {
        if (global.stage.get_key_focus() != this)
            return Clutter.EVENT_PROPAGATE;

        // Since we need to only grab focus on one item child when the user
        // actually press a key we don't use navigate_focus when opening
        // the popup.
        // Instead of that, grab the focus on the AppFolderPopup actor
        // and actually moves the focus to a child only when the user
        // actually press a key.
        // It should work with just grab_key_focus on the AppFolderPopup
        // actor, but since the arrow keys are not wrapping_around the focus
        // is not grabbed by a child when the widget that has the current focus
        // is the same that is requesting focus, so to make it works with arrow
        // keys we need to connect to the key-press-event and navigate_focus
        // when that happens using TAB_FORWARD or TAB_BACKWARD instead of arrow
        // keys

        // Use TAB_FORWARD for down key and right key
        // and TAB_BACKWARD for up key and left key on ltr
        // languages
        let direction;
        let isLtr = Clutter.get_default_text_direction() == Clutter.TextDirection.LTR;
        switch (keyEvent.keyval) {
        case Clutter.KEY_Down:
            direction = St.DirectionType.TAB_FORWARD;
            break;
        case Clutter.KEY_Right:
            direction = isLtr
                ? St.DirectionType.TAB_FORWARD
                : St.DirectionType.TAB_BACKWARD;
            break;
        case Clutter.KEY_Up:
            direction = St.DirectionType.TAB_BACKWARD;
            break;
        case Clutter.KEY_Left:
            direction = isLtr
                ? St.DirectionType.TAB_BACKWARD
                : St.DirectionType.TAB_FORWARD;
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        return this.navigate_focus(null, direction, false);
    }

    _setLighterBackground(lighter) {
        const backgroundColor = lighter
            ? DIALOG_SHADE_HIGHLIGHT
            : DIALOG_SHADE_NORMAL;

        this.ease({
            backgroundColor,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _withinDialog(x, y) {
        const childExtents = this.child.get_transformed_extents();
        return childExtents.contains_point(new Graphene.Point({ x, y }));
    }

    _setupDragMonitor() {
        if (this._dragMonitor)
            return;

        this._dragMonitor = {
            dragMotion: dragEvent => {
                const withinDialog =
                    this._withinDialog(dragEvent.x, dragEvent.y);

                this._setLighterBackground(!withinDialog);

                if (withinDialog) {
                    this._removePopdownTimeout();
                    this._removeDragMonitor();
                }
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _setupPopdownTimeout() {
        if (this._popdownTimeoutId > 0)
            return;

        this._popdownTimeoutId =
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPDOWN_DIALOG_TIMEOUT, () => {
                this._popdownTimeoutId = 0;
                this.popdown();
                return GLib.SOURCE_REMOVE;
            });
    }

    handleDragOver(source, actor, x, y) {
        if (this._withinDialog(x, y)) {
            this._setLighterBackground(false);
            this._removePopdownTimeout();
            this._removeDragMonitor();
        } else {
            this._setupPopdownTimeout();
            this._setupDragMonitor();
        }

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        const appId = source.id;

        this._appDisplay.acceptDrop(source);

        this.popdown(() => {
            this._appDisplay.selectApp(appId);
        });

        return true;
    }

    toggle() {
        if (this._isOpen)
            this.popdown();
        else
            this.popup();
    }

    popup() {
        if (this._isOpen)
            return;

        this._isOpen = this._grabHelper.grab({
            actor: this,
            onUngrab: () => this.popdown(),
        });

        if (!this._isOpen)
            return;

        this.get_parent().set_child_above_sibling(this, null);

        this._needsZoomAndFade = true;
        this.show();

        this.emit('open-state-changed', true);
    }

    popdown(callback) {
        // Either call the callback right away, or wait for the zoom out
        // animation to finish
        if (callback) {
            if (this.visible)
                this._popdownCallbacks.push(callback);
            else
                callback();
        }

        if (!this._isOpen)
            return;

        this._zoomAndFadeOut();
        this._showFolderLabel();

        this._isOpen = false;
        this._grabHelper.ungrab({ actor: this });
        this.emit('open-state-changed', false);
    }
});

var AppIcon = GObject.registerClass({
    Signals: {
        'menu-state-changed': { param_types: [GObject.TYPE_BOOLEAN] },
        'sync-tooltip': {},
    },
}, class AppIcon extends AppViewItem {
    _init(app, iconParams = {}) {
        // Get the isDraggable property without passing it on to the BaseIcon:
        const appIconParams = Params.parse(iconParams, { isDraggable: true }, true);
        const isDraggable = appIconParams['isDraggable'];
        delete iconParams['isDraggable'];
        const expandTitleOnHover = appIconParams['expandTitleOnHover'];
        delete iconParams['expandTitleOnHover'];

        super._init({ style_class: 'app-well-app' }, isDraggable, expandTitleOnHover);

        this.app = app;
        this._id = app.get_id();
        this._name = app.get_name();

        this._iconContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        this.set_child(this._iconContainer);

        this._folderPreviewId = 0;

        iconParams['createIcon'] = this._createIcon.bind(this);
        iconParams['setSizeManually'] = true;
        this.icon = new IconGrid.BaseIcon(app.get_name(), iconParams);
        this._iconContainer.add_child(this.icon);

       /* this._dot = new St.Widget({
            style_class: 'app-well-app-running-dot',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._iconContainer.add_child(this._dot);
*/
        this.label_actor = this.icon.label;

        this.connect('popup-menu', this._onKeyboardPopupMenu.bind(this));

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        this.app.connectObject('notify::state',
            () => this._updateRunningStyle(), this);
        this._updateRunningStyle();

        const longPressGesture = new Clutter.LongPressGesture({
            long_press_duration: MENU_POPUP_TIMEOUT,
        });
        longPressGesture.connect('long-press-begin', () => this.popupMenu());
        longPressGesture.connect('long-press-cancel', () => this._menu?.close(true));
        if (this._draggable)
            longPressGesture.can_not_cancel(this._draggable);
        this.add_action(longPressGesture);
    }

    _onDestroy() {
        super._onDestroy();

        if (this._folderPreviewId > 0) {
            GLib.source_remove(this._folderPreviewId);
            this._folderPreviewId = 0;
        }

    }

    _createIcon(iconSize) {
        return this.app.create_icon_texture(iconSize);
    }

    _updateRunningStyle() {
     /*   if (this.app.state != Shell.AppState.STOPPED)
            this._dot.show();
        else
            this._dot.hide();*/
    }

    vfunc_button_press_event(buttonEvent) {
        if (buttonEvent.button === Clutter.BUTTON_SECONDARY) {
            this.popupMenu();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_clicked(button) {
        this.activate(button);
    }

    _onKeyboardPopupMenu() {
        this.popupMenu();
        this._menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    getId() {
        return this.app.get_id();
    }

    popupMenu(side = St.Side.LEFT) {
        this.setForcedHighlight(true);

        if (!this._menu) {
            this._menu = new AppMenu(this, side, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            this._menu.setApp(this.app);
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            });
            Main.overview.connectObject('hiding',
                () => this._menu.close(), this);

            Main.uiGroup.add_actor(this._menu.actor);
            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this._menu.open(BoxPointer.PopupAnimation.FULL);
        this._menuManager.ignoreRelease();
        this.emit('sync-tooltip');

        return false;
    }

    _onMenuPoppedDown() {
        this.setForcedHighlight(false);
        this.emit('menu-state-changed', false);
    }

    activate(button) {
        let event = Clutter.get_current_event();
        let modifiers = event ? event.get_state() : 0;
        let isMiddleButton = button && button == Clutter.BUTTON_MIDDLE;
        let isCtrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) != 0;
        let openNewWindow = this.app.can_open_new_window() &&
                            this.app.state == Shell.AppState.RUNNING &&
                            (isCtrlPressed || isMiddleButton);

        let workspaceIndex = -1;
        if (this.app.state == Shell.AppState.STOPPED || openNewWindow) {
            const workspace = Main.wm.workspaceTracker.maybeCreateWorkspaceForWindow(event.get_time(), this.app, this.icon.icon);
            if (workspace) {
                workspace.activate(event.get_time());
                workspaceIndex = workspace.workspace_index;
            } else {
                this.animateLaunch();
            }
        }

        if (openNewWindow)
            this.app.open_new_window(workspaceIndex);
        else
            this.app.activate_full(workspaceIndex, 0);

        Main.overview.hide();
    }

    animateLaunch() {
        this.icon.animateZoomOut();
    }

    animateLaunchAtPos(x, y) {
        this.icon.animateZoomOutAtPos(x, y);
    }

    shellWorkspaceLaunch(params) {
        let { stack } = new Error();
        log(`shellWorkspaceLaunch is deprecated, use app.open_new_window() instead\n${stack}`);

        params = Params.parse(params, {
            workspace: -1,
            timestamp: 0,
        });

        this.app.open_new_window(params.workspace);
    }

    getDragActor() {
        return this.app.create_icon_texture(Main.overview.dash.iconSize);
    }

    // Returns the original actor that should align with the actor
    // we show as the item is being dragged.
    getDragActorSource() {
        return this.icon.icon;
    }

    shouldShowTooltip() {
        return this.hover && (!this._menu || !this._menu.isOpen);
    }

    _showFolderPreview() {
        const iconSize = this.icon.icon.icon_size;
        const subSize = Math.floor(FOLDER_SUBICON_FRACTION * iconSize);
        const subScale = subSize / iconSize;

        // Previews are 3x3 grids, so 1 - subScale * 3 gives us the leftover space.
        // Divide leftover space by 2 (two paddings per icon) * 3 (three icons) = 6
        // to get the new icon position including the spacing.
        const pivotPoint = (1 - (subScale * 3)) / 6;
        this.icon.icon.set_pivot_point(pivotPoint, pivotPoint);

        this.icon.label.ease({
            duration: 250,
            opacity: 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.icon.icon.ease({
            duration: 250,
            scale_x: subScale,
            scale_y: subScale,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideFolderPreview() {
        this.icon.label.ease({
            duration: 250,
            opacity: 255,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.icon.icon.ease({
            duration: 250,
            scale_x: 1.0,
            scale_y: 1.0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _canAccept(source) {
        if (!super._canAccept(source))
            return false;

        // Don't accept drops in case we're a placeholder item ourself
        if (!this.reactive)
            return false;

        // Don't accept running apps from the dash
        if (source instanceof imports.ui.dash.DashIcon &&
            !AppFavorites.getAppFavorites().isFavorite(source.app.get_id()))
            return false;

        // Disallow creating a folder from an existing folder
        if (source instanceof FolderIcon)
            return false;

        // And finally disallow creating nested folders
        if (_getViewFromIcon(this) instanceof FolderView)
            return false;

        return true;
    }

    _setHoveringByDnd(hovering) {
        if (this._otherIconIsHovering == hovering)
            return;

        super._setHoveringByDnd(hovering);

        if (hovering) {
            if (this._folderPreviewId > 0)
                return;

            this._folderPreviewId =
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    this.add_style_pseudo_class('drop');
                    this._showFolderPreview();
                    this._folderPreviewId = 0;
                    return GLib.SOURCE_REMOVE;
                });
        } else {
            if (this._folderPreviewId > 0) {
                GLib.source_remove(this._folderPreviewId);
                this._folderPreviewId = 0;
            }
            this._hideFolderPreview();
            this.remove_style_pseudo_class('drop');
        }
    }

    acceptDrop(source, actor, x) {
        const accepted = super.acceptDrop(source, actor, x);
        if (!accepted)
            return false;

        let view = _getViewFromIcon(this);

        return view?.createFolderFromAppItem(this, source);
    }
});

var SystemActionIcon = GObject.registerClass(
class SystemActionIcon extends Search.GridSearchResult {
    activate() {
        SystemActions.getDefault().activateAction(this.metaInfo['id']);
        Main.overview.hide();
    }
});
