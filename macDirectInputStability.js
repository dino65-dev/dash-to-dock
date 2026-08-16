// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Clutter, St} from './dependencies/gi.js';
import {Main} from './dependencies/shell/ui.js';

const TRAY_GAP = 5;
const TRAY_DIVIDER_GAP = 8;
const TRAY_PADDING = 8;
const INPUT_PADDING = 10;

/**
 * v124 separates animated compositor geometry from pointer ownership.
 *
 * The v121-v123 fixes still let animation move the same geometry that decided
 * whether the pointer was "inside" the Dock. In particular, thumbnail layout
 * was anchored to previous.baseRect + previous.offset, where previous.offset is
 * the live fish-eye spring offset of the app before the tray. Entering a
 * thumbnail directly could therefore activate the wave, move the tray's own hit
 * target, lose hover, collapse the wave, and repeat.
 *
 * This layer removes that feedback loop instead of damping it:
 *  - thumbnails are visual-only actors;
 *  - one stable transparent tray proxy owns thumbnail hover/click input;
 *  - the tray is anchored to untransformed Dash base geometry with enough
 *    reserved room for the preceding icon's maximum magnification;
 *  - Trash/locations and Show Apps get transparent reactive proxies over their
 *    final compositor rectangles, so native parent clipping is irrelevant;
 *  - the old stage-capture special-item router is bypassed, while normal app
 *    overflow capture, native app drag/reorder, and v122 geometry/DND fixes stay.
 */
export class MacDirectInputStability {
    constructor(interactions, thumbnailFisheye, inputIntegrity) {
        this._interactions = interactions;
        this._thumbnailFisheye = thumbnailFisheye;
        this._inputIntegrity = inputIntegrity;
        this._macEffects = interactions?._macEffects ?? null;
        this._dockManager = interactions?._dockManager ?? null;
        this._settings = interactions?._settings ?? null;
        this._rendererStates = new Map();
        this._previewBaseRects = new WeakMap();

        if (!this._interactions || !this._macEffects)
            return;

        this._replaceThumbnailLayout();
        this._wrapPostPaintItems();

        this._docksReadyId = this._dockManager?.connect?.(
            'docks-ready', () => this._syncRenderers()) ?? 0;
        this._styleChangedId = this._settings?.connect?.(
            'changed::macos-style', () => this._syncRenderers()) ?? 0;

        this._syncRenderers();
    }

    destroy() {
        if (this._docksReadyId)
            this._dockManager?.disconnect?.(this._docksReadyId);
        if (this._styleChangedId)
            this._settings?.disconnect?.(this._styleChangedId);

        for (const renderer of [...this._rendererStates.keys()])
            this._unpatchRenderer(renderer);

        if (this._originalPositionThumbnails && this._interactions) {
            this._interactions._positionThumbnails =
                this._originalPositionThumbnails;
        }
        if (this._originalPostPaintItems && this._interactions)
            this._interactions._postPaintItems = this._originalPostPaintItems;

        this._rendererStates.clear();
        this._rendererStates = null;
        this._previewBaseRects = new WeakMap();
        this._originalPositionThumbnails = null;
        this._originalPostPaintItems = null;
        this._settings = null;
        this._dockManager = null;
        this._macEffects = null;
        this._inputIntegrity = null;
        this._thumbnailFisheye = null;
        this._interactions = null;
    }

    _replaceThumbnailLayout() {
        const interactions = this._interactions;
        if (typeof interactions?._positionThumbnails !== 'function')
            return;

        this._originalPositionThumbnails = interactions._positionThumbnails;
        interactions._positionThumbnails =
            (renderer, state, previous, previews) =>
                this._positionThumbnails(renderer, state, previous, previews);
    }

    _wrapPostPaintItems() {
        const interactions = this._interactions;
        if (typeof interactions?._postPaintItems !== 'function')
            return;

        this._originalPostPaintItems = interactions._postPaintItems;
        interactions._postPaintItems = (renderer, state) => {
            this._originalPostPaintItems.call(interactions, renderer, state);
            this._syncInputProxies(renderer, state);
        };
    }

    _syncRenderers() {
        if (!this._rendererStates || !this._macEffects)
            return;

        const enabled = this._settings?.get_boolean('macos-style') ?? false;
        const renderers = enabled
            ? [...this._macEffects._renderers.values()]
            : [];

        for (const renderer of [...this._rendererStates.keys()]) {
            if (!renderers.includes(renderer))
                this._unpatchRenderer(renderer);
        }

        for (const renderer of renderers) {
            if (!this._rendererStates.has(renderer))
                this._patchRenderer(renderer);
            else
                this._installCaptureBypass(renderer, this._rendererStates.get(renderer));
        }
    }

    _patchRenderer(renderer) {
        if (!renderer?._layer)
            return;

        const integrityState =
            this._inputIntegrity?._rendererStates?.get?.(renderer);
        const originalCapturedEvent =
            integrityState?.originalCapturedEvent ?? renderer._onCapturedEvent;
        const originalPointerInActivationZone = renderer._pointerInActivationZone;
        if (typeof originalCapturedEvent !== 'function' ||
            typeof originalPointerInActivationZone !== 'function')
            return;

        const state = {
            originalCapturedEvent,
            originalPointerInActivationZone,
            capturedEvent: null,
            pointerInActivationZone: null,
            trayProxy: null,
            trayInputRect: null,
            specialProxies: new Map(),
        };

        state.pointerInActivationZone = (x, y) => {
            if (state.trayInputRect &&
                pointInRect(state.trayInputRect, x, y))
                return true;
            return state.originalPointerInActivationZone.call(renderer, x, y);
        };
        renderer._pointerInActivationZone = state.pointerInActivationZone;

        this._rendererStates.set(renderer, state);
        this._ensureTrayProxy(renderer, state);
        this._installCaptureBypass(renderer, state);
        this._configureExistingPreviews(renderer);
    }

    _installCaptureBypass(renderer, state) {
        if (!state)
            return;

        state.capturedEvent = event => {
            if (this._isSpecialButtonPress(renderer, event))
                return Clutter.EVENT_PROPAGATE;
            return state.originalCapturedEvent.call(renderer, event);
        };
        renderer._onCapturedEvent = state.capturedEvent;
    }

    _unpatchRenderer(renderer) {
        const state = this._rendererStates?.get(renderer);
        if (!state)
            return;

        this._setProxyHover(renderer, state.trayProxy, false);
        state.trayProxy?.destroy();
        state.trayProxy = null;

        for (const proxy of state.specialProxies.values()) {
            this._setProxyHover(renderer, proxy.actor, false);
            proxy.actor.destroy();
        }
        state.specialProxies.clear();

        try {
            if (renderer._onCapturedEvent === state.capturedEvent)
                renderer._onCapturedEvent = state.originalCapturedEvent;
            if (renderer._pointerInActivationZone ===
                state.pointerInActivationZone) {
                renderer._pointerInActivationZone =
                    state.originalPointerInActivationZone;
            }
        } catch {
            // Renderer may already be destroyed during a dock rebuild.
        }

        this._rendererStates.delete(renderer);
    }

    _ensureTrayProxy(renderer, state) {
        if (state.trayProxy)
            return state.trayProxy;

        const proxy = new St.Widget({
            reactive: true,
            track_hover: true,
            can_focus: false,
            visible: false,
            style: 'background-color: transparent;',
        });
        proxy.opacity = 1;

        proxy.connect('notify::hover', () => {
            this._setProxyHover(renderer, proxy, proxy.hover);
            renderer._wake?.();
        });
        proxy.connect('button-press-event', (_actor, event) =>
            this._onTrayButtonPress(renderer, event));
        for (const signal of ['enter-event', 'motion-event', 'leave-event']) {
            proxy.connect(signal, () => {
                renderer._wake?.();
                return Clutter.EVENT_PROPAGATE;
            });
        }
        proxy.connect('destroy', () =>
            this._setProxyHover(renderer, proxy, false));

        renderer._layer.add_child(proxy);
        state.trayProxy = proxy;
        return proxy;
    }

    _positionThumbnails(renderer, interactionState, previous, previews) {
        const rendererState = this._rendererStates?.get(renderer);
        const horizontal = renderer?._dock?.isHorizontal;
        if (!previous?.baseRect || !previews?.length) {
            interactionState.trayBounds = null;
            if (rendererState)
                rendererState.trayInputRect = null;
            return;
        }

        const maxScale = 1 + Math.max(0,
            this._settings?.get_double('macos-magnification') ?? 0);
        const reserve = Math.max(0,
            previous.baseSize * (maxScale - 1) / 2);
        const previousEnd = horizontal
            ? previous.baseRect.x + previous.baseRect.width
            : previous.baseRect.y + previous.baseRect.height;
        let cursor = previousEnd + reserve + TRAY_DIVIDER_GAP + TRAY_PADDING;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let primaryExtent = 0;
        let maxPreviewExtent = 0;

        for (const preview of previews) {
            const actor = preview?.actor;
            if (!actor)
                continue;

            this._configurePreview(renderer, preview);
            const [width, height] = actor.get_size?.() ?? [0, 0];
            if (!(width > 0) || !(height > 0))
                continue;

            let x;
            let y;
            if (horizontal) {
                x = cursor;
                y = previous.baseCenterY - height / 2;
                cursor += width + TRAY_GAP;
                primaryExtent += width;
                maxPreviewExtent = Math.max(maxPreviewExtent, height);
            } else {
                x = previous.baseCenterX - width / 2;
                y = cursor;
                cursor += height + TRAY_GAP;
                primaryExtent += height;
                maxPreviewExtent = Math.max(maxPreviewExtent, width);
            }

            actor.set_position(Math.round(x), Math.round(y));
            actor.show();
            const rect = {x, y, width, height};
            this._previewBaseRects.set(actor, rect);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + width);
            maxY = Math.max(maxY, y + height);
        }

        if (!Number.isFinite(minX)) {
            interactionState.trayBounds = null;
            if (rendererState)
                rendererState.trayInputRect = null;
            return;
        }

        interactionState.trayBounds = {minX, minY, maxX, maxY};
        if (!rendererState)
            return;

        const gaps = Math.max(0, previews.length - 1) * TRAY_GAP;
        primaryExtent += gaps;
        const growthReserve = Math.max(INPUT_PADDING,
            primaryExtent * Math.max(0, maxScale - 1) + INPUT_PADDING);
        const crossReserve = Math.max(INPUT_PADDING,
            maxPreviewExtent * Math.max(0, maxScale - 1) / 2 + INPUT_PADDING);

        if (horizontal) {
            rendererState.trayInputRect = {
                x: minX - INPUT_PADDING,
                y: minY - crossReserve,
                width: maxX - minX + growthReserve + INPUT_PADDING,
                height: maxY - minY + crossReserve * 2,
            };
        } else {
            rendererState.trayInputRect = {
                x: minX - crossReserve,
                y: minY - INPUT_PADDING,
                width: maxX - minX + crossReserve * 2,
                height: maxY - minY + growthReserve + INPUT_PADDING,
            };
        }
    }

    _configureExistingPreviews(renderer) {
        const interactionState =
            this._interactions?._rendererStates?.get?.(renderer);
        for (const preview of interactionState?.thumbnails?.values?.() ?? [])
            this._configurePreview(renderer, preview);
    }

    _configurePreview(renderer, preview) {
        const actor = preview?.actor;
        if (!actor)
            return;

        if (actor.hover)
            this._thumbnailFisheye?._setThumbnailHover?.(renderer, actor, false);
        actor.reactive = false;
        actor.track_hover = false;
        actor.can_focus = false;
    }

    _syncInputProxies(renderer, interactionState) {
        const state = this._rendererStates?.get(renderer);
        if (!state)
            return;

        this._installCaptureBypass(renderer, state);
        this._syncTrayProxy(renderer, interactionState, state);
        this._syncSpecialProxies(renderer, state);
    }

    _syncTrayProxy(renderer, interactionState, state) {
        const proxy = this._ensureTrayProxy(renderer, state);
        const rect = state.trayInputRect;
        const visible = !!interactionState?.trayActive && !!rect &&
            !renderer._isDockFullyHidden?.();

        if (!visible) {
            this._setProxyHover(renderer, proxy, false);
            proxy.hide();
            return;
        }

        proxy.set_position(Math.floor(rect.x), Math.floor(rect.y));
        proxy.set_size(
            Math.max(1, Math.ceil(rect.width)),
            Math.max(1, Math.ceil(rect.height)));
        proxy.show();
        proxy.raise_top?.();
    }

    _syncSpecialProxies(renderer, state) {
        const current = new Set();
        const hidden = renderer._isDockFullyHidden?.();

        for (const item of renderer?._items ?? []) {
            if (!this._isSpecialItem(item))
                continue;

            current.add(item);
            let proxy = state.specialProxies.get(item);
            if (!proxy) {
                proxy = this._createSpecialProxy(renderer, item);
                state.specialProxies.set(item, proxy);
            }
            proxy.item = item;

            const rect = transformedRect(item.actor) ?? item.visualRect;
            if (hidden || !rect) {
                this._setProxyHover(renderer, proxy.actor, false);
                proxy.actor.hide();
                continue;
            }

            proxy.actor.set_position(Math.floor(rect.x), Math.floor(rect.y));
            proxy.actor.set_size(
                Math.max(1, Math.ceil(rect.width)),
                Math.max(1, Math.ceil(rect.height)));
            proxy.actor.show();
            proxy.actor.raise_top?.();
        }

        for (const [item, proxy] of [...state.specialProxies]) {
            if (current.has(item))
                continue;
            this._setProxyHover(renderer, proxy.actor, false);
            proxy.actor.destroy();
            state.specialProxies.delete(item);
        }
    }

    _createSpecialProxy(renderer, item) {
        const actor = new St.Widget({
            reactive: true,
            track_hover: true,
            can_focus: false,
            style: 'background-color: transparent;',
        });
        actor.opacity = 1;
        const proxy = {actor, item};

        actor.connect('notify::hover', () => {
            this._setProxyHover(renderer, actor, actor.hover);
            renderer._wake?.();
        });
        actor.connect('button-press-event', (_actor, event) =>
            this._onSpecialButtonPress(renderer, proxy, event));
        actor.connect('destroy', () =>
            this._setProxyHover(renderer, actor, false));

        renderer._layer.add_child(actor);
        return proxy;
    }

    _setProxyHover(renderer, actor, hovering) {
        if (!actor)
            return;
        this._thumbnailFisheye?._setThumbnailHover?.(
            renderer, actor, !!hovering);
    }

    _onTrayButtonPress(renderer, event) {
        const button = event.get_button?.() ?? 0;
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const preview = this._findPreviewHit(renderer, x, y);
        if (!preview?.window)
            return Clutter.EVENT_PROPAGATE;

        try {
            const timestamp = event.get_time?.() || global.get_current_time();
            if (preview.window.minimized)
                preview.window.unminimize();
            Main.activateWindow(preview.window, timestamp);
            return Clutter.EVENT_STOP;
        } catch (error) {
            console.error(`[macOS Dock] Failed proxy thumbnail activation: ${error}`);
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _findPreviewHit(renderer, x, y) {
        const interactionState =
            this._interactions?._rendererStates?.get?.(renderer);
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const preview of interactionState?.thumbnails?.values?.() ?? []) {
            const rects = [];
            const transformed = transformedRect(preview.actor);
            if (transformed)
                rects.push(transformed);
            const base = this._previewBaseRects.get(preview.actor);
            if (base)
                rects.push(base);

            for (const rect of rects) {
                if (!pointInRect(rect, x, y))
                    continue;
                const dx = x - (rect.x + rect.width / 2);
                const dy = y - (rect.y + rect.height / 2);
                const distance = dx * dx + dy * dy;
                if (distance < bestDistance) {
                    best = preview;
                    bestDistance = distance;
                }
            }
        }

        return best;
    }

    _onSpecialButtonPress(renderer, proxy, event) {
        const item = proxy?.item;
        const button = event.get_button?.() ?? 0;
        if (!item)
            return Clutter.EVENT_PROPAGATE;

        if (button === Clutter.BUTTON_SECONDARY) {
            if (this._openSpecialMenu(item))
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        }

        if (item.kind === 'show-apps') {
            if (button !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_STOP;

            try {
                item.source.checked = !item.source.checked;
                renderer._wake?.();
                return Clutter.EVENT_STOP;
            } catch (error) {
                console.error(`[macOS Dock] Failed proxy Show Apps activation: ${error}`);
                return Clutter.EVENT_PROPAGATE;
            }
        }

        if (item.kind === 'app' &&
            (button === Clutter.BUTTON_PRIMARY ||
             button === Clutter.BUTTON_MIDDLE)) {
            try {
                if (typeof item.app?.activate === 'function')
                    item.app.activate();
                else
                    item.source?.activate?.(button);
                renderer._wake?.();
                return Clutter.EVENT_STOP;
            } catch (error) {
                console.error(`[macOS Dock] Failed proxy special activation: ${error}`);
                return Clutter.EVENT_PROPAGATE;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _openSpecialMenu(item) {
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
            console.error(`[macOS Dock] Failed proxy special menu: ${error}`);
            return false;
        }
    }

    _isSpecialButtonPress(renderer, event) {
        if (!event)
            return false;

        let type;
        try {
            type = event.type();
        } catch {
            return false;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS)
            return false;

        const [x, y] = event.get_coords();
        return !!this._findSpecialHit(renderer, x, y);
    }

    _findSpecialHit(renderer, x, y) {
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const item of renderer?._items ?? []) {
            if (!this._isSpecialItem(item))
                continue;

            const rect = transformedRect(item.actor) ?? item.visualRect;
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

    _isSpecialItem(item) {
        return item?.kind === 'show-apps' ||
            (item?.kind === 'app' &&
             (item.app?.location || item.app?.isTrash));
    }
}

function transformedRect(actor) {
    if (!actor?.visible)
        return null;

    try {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        if ([x, y, width, height].every(Number.isFinite) &&
            width > 0 && height > 0)
            return {x, y, width, height};
    } catch {
        // Caller may still have cached visual geometry.
    }
    return null;
}

function pointInRect(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width &&
        y >= rect.y && y <= rect.y + rect.height;
}
