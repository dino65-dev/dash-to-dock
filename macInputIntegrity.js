// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Clutter, GLib, St} from './dependencies/gi.js';

const FALLBACK_LONG_PRESS_MS = 600;
const FALLBACK_DRAG_THRESHOLD = 10;
const LAYOUT_SHIFT_EPSILON = 0.01;

/**
 * Keeps the detached macOS presentation and Dash-to-Dock's native interaction
 * model in sync.
 *
 * v122 treats the tray displacement as part of an item's effective geometry
 * everywhere input decisions are made. Native actors remain authoritative for
 * normal app tiles. Trash/locations and Show Apps are routed from their final
 * compositor rectangles because the thumbnail tray can move them outside the
 * native parent allocation.
 */
export class MacInputIntegrity {
    constructor(interactions, thumbnailFisheye = null) {
        this._interactions = interactions;
        this._thumbnailFisheye = thumbnailFisheye;
        this._macEffects = interactions?._macEffects ?? null;
        this._dockManager = interactions?._dockManager ?? null;
        this._settings = interactions?._settings ?? null;
        this._rendererStates = new Map();
        this._pendingPress = null;

        if (!this._interactions || !this._macEffects)
            return;

        this._wrapPostPaintItems();
        this._wrapDndHighlights();

        this._docksReadyId = this._dockManager?.connect?.(
            'docks-ready', () => this._syncRenderers()) ?? 0;
        this._styleChangedId = this._settings?.connect?.(
            'changed::macos-style', () => this._syncRenderers()) ?? 0;

        this._syncRenderers();
    }

    destroy() {
        this._cancelPendingPress();

        if (this._docksReadyId)
            this._dockManager?.disconnect?.(this._docksReadyId);
        if (this._styleChangedId)
            this._settings?.disconnect?.(this._styleChangedId);

        for (const renderer of [...this._rendererStates.keys()])
            this._unpatchRenderer(renderer);

        if (this._originalPostPaintItems && this._interactions)
            this._interactions._postPaintItems = this._originalPostPaintItems;
        if (this._originalApplyDndHighlights && this._interactions) {
            this._interactions._applyDndHighlights =
                this._originalApplyDndHighlights;
        }

        this._rendererStates.clear();
        this._rendererStates = null;
        this._originalPostPaintItems = null;
        this._originalApplyDndHighlights = null;
        this._settings = null;
        this._dockManager = null;
        this._macEffects = null;
        this._thumbnailFisheye = null;
        this._interactions = null;
    }

    _syncRenderers() {
        if (!this._rendererStates || !this._macEffects)
            return;

        const renderers = [...this._macEffects._renderers.values()];
        for (const renderer of [...this._rendererStates.keys()]) {
            if (!renderers.includes(renderer))
                this._unpatchRenderer(renderer);
        }

        for (const renderer of renderers) {
            if (!this._rendererStates.has(renderer))
                this._patchRenderer(renderer);
        }
    }

    _patchRenderer(renderer) {
        const originalCapturedEvent = renderer?._onCapturedEvent;
        if (typeof originalCapturedEvent !== 'function')
            return;

        const state = {
            originalCapturedEvent,
            originalPointerInActivationZone: renderer._pointerInActivationZone,
            originalUpdateTargets: renderer._updateTargets,
            hoveredSpecialActor: null,
        };
        this._rendererStates.set(renderer, state);

        renderer._onCapturedEvent = event =>
            this._routeCapturedEvent(renderer, state, event);

        if (typeof state.originalPointerInActivationZone === 'function') {
            renderer._pointerInActivationZone = (x, y) =>
                this._withEffectiveBaseCenters(renderer, () =>
                    state.originalPointerInActivationZone.call(renderer, x, y));
        }

        if (typeof state.originalUpdateTargets === 'function') {
            renderer._updateTargets = (x, y, active) =>
                this._withEffectiveBaseCenters(renderer, () =>
                    state.originalUpdateTargets.call(renderer, x, y, active));
        }
    }

    _unpatchRenderer(renderer) {
        const state = this._rendererStates?.get(renderer);
        if (!state)
            return;

        if (this._pendingPress?.renderer === renderer)
            this._cancelPendingPress();

        this._setSpecialHover(renderer, state, null);

        try {
            renderer._onCapturedEvent = state.originalCapturedEvent;
            if (typeof state.originalPointerInActivationZone === 'function') {
                renderer._pointerInActivationZone =
                    state.originalPointerInActivationZone;
            }
            if (typeof state.originalUpdateTargets === 'function')
                renderer._updateTargets = state.originalUpdateTargets;
        } catch {
            // Renderer may already be destroyed during a dock rebuild.
        }
        this._rendererStates.delete(renderer);
    }

    _routeCapturedEvent(renderer, state, event) {
        if (!event || renderer?._destroyed || renderer?._dragging)
            return state.originalCapturedEvent.call(renderer, event);

        let type;
        try {
            type = event.type();
        } catch {
            return state.originalCapturedEvent.call(renderer, event);
        }

        if (type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            this._syncSpecialHover(renderer, state, x, y);
            return this._routeMotion(renderer, state, event);
        }

        if (type === Clutter.EventType.BUTTON_RELEASE)
            return this._routeButtonRelease(renderer, event);

        if (type !== Clutter.EventType.BUTTON_PRESS)
            return state.originalCapturedEvent.call(renderer, event);

        if (renderer._isDockFullyHidden?.()) {
            this._setSpecialHover(renderer, state, null);
            return Clutter.EVENT_PROPAGATE;
        }

        const [x, y] = event.get_coords();
        const hit = this._visualHitTest(renderer, x, y);
        if (!hit)
            return Clutter.EVENT_PROPAGATE;

        const special = this._isSpecialItem(hit);
        if (special)
            this._setSpecialHover(renderer, state, hit.actor ?? null);

        const source = event.get_source?.() ?? null;
        if (!special && this._nativeItemOwnsSource(hit, source)) {
            // Native Dash-to-Dock receives the complete press/release/drag
            // sequence whenever Clutter really picked the matching app tile.
            return Clutter.EVENT_PROPAGATE;
        }

        if (!special && hit.baseRect && pointInRect(hit.baseRect, x, y)) {
            // Do not steal a normal app press from another native actor merely
            // because detached artwork overlaps its unshifted tile.
            return Clutter.EVENT_PROPAGATE;
        }

        const button = event.get_button?.() ?? 0;
        if (button !== Clutter.BUTTON_PRIMARY &&
            button !== Clutter.BUTTON_MIDDLE &&
            button !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_STOP;

        this._cancelPendingPress();
        this._pendingPress = {
            renderer,
            item: hit,
            button,
            startX: x,
            startY: y,
            moved: false,
            longPressed: false,
            menuOpened: false,
            timeoutId: 0,
        };

        if (button === Clutter.BUTTON_SECONDARY)
            this._pendingPress.menuOpened = this._openMenu(hit);
        else if (button === Clutter.BUTTON_PRIMARY)
            this._startLongPressFallback();

        return Clutter.EVENT_STOP;
    }

    _routeMotion(renderer, state, event) {
        const pending = this._pendingPress;
        if (!pending || pending.renderer !== renderer)
            return state.originalCapturedEvent.call(renderer, event);

        const [x, y] = event.get_coords();
        if (this._pointerMovedPastThreshold(pending, x, y)) {
            pending.moved = true;
            this._cancelLongPressTimer(pending);
        }
        return Clutter.EVENT_STOP;
    }

    _routeButtonRelease(renderer, event) {
        const pending = this._pendingPress;
        if (!pending || pending.renderer !== renderer)
            return Clutter.EVENT_PROPAGATE;

        const button = event.get_button?.() ?? 0;
        if (button !== pending.button)
            return Clutter.EVENT_STOP;

        this._cancelLongPressTimer(pending);
        const [x, y] = event.get_coords();
        if (this._pointerMovedPastThreshold(pending, x, y))
            pending.moved = true;

        // Do not re-hit-test against a spring-driven rectangle here. The item can
        // legitimately move several pixels between press and release while the
        // physical pointer never moved. Pointer slop is the stable click contract.
        const shouldActivate = !pending.moved && !pending.longPressed &&
            !pending.menuOpened;
        const {item, button: pressedButton} = pending;
        this._pendingPress = null;

        if (shouldActivate)
            this._activateVisualItem(item, pressedButton);

        return Clutter.EVENT_STOP;
    }

    _pointerMovedPastThreshold(pending, x, y) {
        const threshold = this._dragThreshold();
        const dx = x - pending.startX;
        const dy = y - pending.startY;
        return dx * dx + dy * dy > threshold * threshold;
    }

    _startLongPressFallback() {
        const pending = this._pendingPress;
        if (!pending)
            return;

        pending.timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, this._longPressDuration(), () => {
                pending.timeoutId = 0;
                if (this._pendingPress !== pending || pending.moved)
                    return GLib.SOURCE_REMOVE;

                pending.longPressed = this._openMenu(pending.item);
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(pending.timeoutId,
            '[dash-to-dock] macOS visual long press');
    }

    _cancelPendingPress() {
        if (!this._pendingPress)
            return;
        this._cancelLongPressTimer(this._pendingPress);
        this._pendingPress = null;
    }

    _cancelLongPressTimer(pending) {
        if (!pending?.timeoutId)
            return;
        GLib.source_remove(pending.timeoutId);
        pending.timeoutId = 0;
    }

    _activateVisualItem(item, button) {
        try {
            if (item.kind === 'show-apps') {
                if (button === Clutter.BUTTON_PRIMARY && item.source)
                    item.source.checked = !item.source.checked;
                return;
            }

            if (item.kind === 'app' && typeof item.source?.activate === 'function')
                item.source.activate(button);
        } catch (error) {
            console.error(`[macOS Dock] Failed to activate visual item: ${error}`);
        }
    }

    _openMenu(item) {
        let target = null;
        if (typeof item.source?.popupMenu === 'function')
            target = item.source;
        else if (typeof item.item?.popupMenu === 'function')
            target = item.item;

        if (!target)
            return false;

        try {
            target.popupMenu();
            return true;
        } catch (error) {
            console.error(`[macOS Dock] Failed to open visual item menu: ${error}`);
            return false;
        }
    }

    _syncSpecialHover(renderer, state, x, y) {
        if (renderer._isDockFullyHidden?.()) {
            this._setSpecialHover(renderer, state, null);
            return;
        }

        const item = this._visualHitTest(renderer, x, y, true);
        this._setSpecialHover(renderer, state, item?.actor ?? null);
    }

    _setSpecialHover(renderer, state, actor) {
        if (!state || state.hoveredSpecialActor === actor)
            return;

        const previous = state.hoveredSpecialActor;
        state.hoveredSpecialActor = actor;

        // Use the same visibility owner as minimized thumbnails. Add the new
        // actor before removing the previous one so crossing Trash -> Show Apps
        // cannot momentarily drop the hover pin and start an autohide transition.
        if (actor)
            this._thumbnailFisheye?._setThumbnailHover?.(renderer, actor, true);
        if (previous)
            this._thumbnailFisheye?._setThumbnailHover?.(renderer, previous, false);
    }

    _visualHitTest(renderer, x, y, specialOnly = false) {
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const item of renderer?._items ?? []) {
            if (specialOnly && !this._isSpecialItem(item))
                continue;

            const rect = this._finalVisualRect(item);
            if (!rect || !pointInRect(rect, x, y))
                continue;

            const dx = x - (rect.x + rect.width / 2);
            const dy = y - (rect.y + rect.height / 2);
            const distance = dx * dx + dy * dy;
            if (distance < bestDistance) {
                best = item;
                bestDistance = distance;
            }
        }
        return best;
    }

    _finalVisualRect(item) {
        const actor = item?.actor;
        if (!actor?.visible)
            return null;

        try {
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            if ([x, y, width, height].every(Number.isFinite) &&
                width > 0 && height > 0)
                return {x, y, width, height};
        } catch {
            // Fall back to the renderer's last cached rectangle below.
        }
        return item.visualRect ?? null;
    }

    _isSpecialItem(item) {
        return item?.kind === 'show-apps' ||
            (item?.kind === 'app' &&
             (item.app?.location || item.app?.isTrash));
    }

    _nativeItemOwnsSource(item, source) {
        if (!source)
            return false;

        let actor = source;
        while (actor) {
            if (actor === item.source || actor === item.item)
                return true;
            try {
                actor = actor.get_parent?.() ?? null;
            } catch {
                actor = null;
            }
        }
        return false;
    }

    _withEffectiveBaseCenters(renderer, callback) {
        const interactionState =
            this._interactions?._rendererStates?.get?.(renderer);
        if (!interactionState?.trayActive)
            return callback();

        const horizontal = renderer?._dock?.isHorizontal;
        const saved = [];

        for (const item of renderer?._items ?? []) {
            const shift = this._trayLayoutShift(renderer, item);
            if (!Number.isFinite(shift) ||
                Math.abs(shift) <= LAYOUT_SHIFT_EPSILON)
                continue;

            saved.push([item, item.baseCenterX, item.baseCenterY]);
            if (horizontal)
                item.baseCenterX += shift;
            else
                item.baseCenterY += shift;
        }

        try {
            return callback();
        } finally {
            for (const [item, x, y] of saved) {
                item.baseCenterX = x;
                item.baseCenterY = y;
            }
        }
    }

    _trayLayoutShift(renderer, item) {
        const actor = item?.item;
        if (!actor)
            return 0;

        const horizontal = renderer?._dock?.isHorizontal;
        const translation = horizontal
            ? actor.translationX
            : actor.translationY;
        const fishEyeOffset = item.offset ?? 0;
        const shift = (translation ?? 0) - fishEyeOffset;
        return Number.isFinite(shift) ? shift : 0;
    }

    _wrapPostPaintItems() {
        const interactions = this._interactions;
        this._originalPostPaintItems = interactions._postPaintItems;
        interactions._postPaintItems = (renderer, state) => {
            this._originalPostPaintItems.call(interactions, renderer, state);
            this._ensureTrailingSystemBoundary(renderer, state);
        };
    }

    _ensureTrailingSystemBoundary(renderer, state) {
        if (!state?.trayActive || state.specialIndex >= 0 ||
            !(state.shiftAmount > 0))
            return;

        const items = renderer._orderedItems?.() ?? renderer._items ?? [];
        const showAppsIndex = items.findIndex(item => item.kind === 'show-apps');
        if (showAppsIndex < 0)
            return;

        state.specialIndex = showAppsIndex;
        for (let i = showAppsIndex; i < items.length; i++)
            this._interactions._shiftPaintedItem(renderer, items[i], state.shiftAmount);
    }

    _wrapDndHighlights() {
        const interactions = this._interactions;
        this._originalApplyDndHighlights = interactions._applyDndHighlights;
        interactions._applyDndHighlights = (...args) => {
            const saved = [];
            for (const renderer of interactions._rendererStates.keys()) {
                for (const item of renderer._items ?? []) {
                    saved.push([item, item.visualRect]);
                    item.visualRect = this._finalVisualRect(item);
                }
            }

            try {
                return this._originalApplyDndHighlights.apply(interactions, args);
            } finally {
                for (const [item, rect] of saved)
                    item.visualRect = rect;
            }
        };
    }

    _longPressDuration() {
        try {
            const duration = Clutter.Settings.get_default()?.long_press_duration;
            if (Number.isFinite(duration) && duration > 0)
                return duration;
        } catch {
            // Use the GNOME-like fallback below.
        }
        return FALLBACK_LONG_PRESS_MS;
    }

    _dragThreshold() {
        try {
            const threshold = St.Settings.get()?.drag_threshold;
            if (Number.isFinite(threshold) && threshold > 0)
                return threshold;
        } catch {
            // Use the conservative fallback below.
        }
        return FALLBACK_DRAG_THRESHOLD;
    }
}

function pointInRect(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width &&
        y >= rect.y && y <= rect.y + rect.height;
}
