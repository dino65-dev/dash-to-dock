// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Clutter} from './dependencies/gi.js';

const PREVIEW_ACTIVATION_PAD = 10;

/**
 * v123 closes two feedback loops that remain after v122:
 *
 *  1. A minimized preview used its transformed actor hover as an activation
 *     condition. Entering a preview directly could therefore magnify/move the
 *     actor out from under a stationary pointer, clear hover, shrink it back,
 *     and repeat. We snapshot the preview's pre-fisheye rectangle and extend
 *     the renderer activation zone from that stable geometry instead.
 *
 *  2. Trash/locations and Show Apps can be painted beyond the native Dash pick
 *     allocation after the thumbnail tray shifts them. Waiting for a release
 *     routed through the native proxy is not reliable in that state. Their
 *     primary/middle activation is therefore completed at stage capture on the
 *     press that hit the final detached visual. Normal app icons still keep the
 *     complete native press/release/drag path.
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

        this._wrapThumbnailLayout();

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

        this._rendererStates.clear();
        this._rendererStates = null;
        this._previewBaseRects = new WeakMap();
        this._originalPositionThumbnails = null;
        this._settings = null;
        this._dockManager = null;
        this._macEffects = null;
        this._inputIntegrity = null;
        this._thumbnailFisheye = null;
        this._interactions = null;
    }

    _wrapThumbnailLayout() {
        const interactions = this._interactions;
        const original = interactions?._positionThumbnails;
        if (typeof original !== 'function')
            return;

        this._originalPositionThumbnails = original;
        interactions._positionThumbnails =
            (renderer, state, previous, previews) => {
                const result = original.call(
                    interactions, renderer, state, previous, previews);
                this._capturePreviewBaseRects(previews);
                return result;
            };
    }

    _capturePreviewBaseRects(previews) {
        for (const preview of previews ?? []) {
            const actor = preview?.actor;
            if (!actor)
                continue;

            const [width, height] = actor.get_size?.() ?? [0, 0];
            if (!(width > 0) || !(height > 0))
                continue;

            // x/y are allocation coordinates in the full-stage detached layer.
            // They are captured immediately after _positionThumbnails and before
            // the thumbnail fish-eye applies its compositor translation/scale.
            this._previewBaseRects.set(actor, {
                x: actor.x,
                y: actor.y,
                width,
                height,
            });
        }
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
        }
    }

    _patchRenderer(renderer) {
        if (!renderer)
            return;

        const originalCapturedEvent = renderer._onCapturedEvent;
        const originalPointerInActivationZone =
            renderer._pointerInActivationZone;
        if (typeof originalCapturedEvent !== 'function' ||
            typeof originalPointerInActivationZone !== 'function')
            return;

        const state = {
            originalCapturedEvent,
            originalPointerInActivationZone,
        };

        state.capturedEvent = event =>
            this._routeCapturedEvent(renderer, state, event);
        state.pointerInActivationZone = (x, y) => {
            if (this._pointerInStablePreviewZone(renderer, x, y))
                return true;
            return state.originalPointerInActivationZone.call(renderer, x, y);
        };

        renderer._onCapturedEvent = state.capturedEvent;
        renderer._pointerInActivationZone = state.pointerInActivationZone;
        this._rendererStates.set(renderer, state);
    }

    _unpatchRenderer(renderer) {
        const state = this._rendererStates?.get(renderer);
        if (!state)
            return;

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

    _pointerInStablePreviewZone(renderer, x, y) {
        if (renderer?._isDockFullyHidden?.())
            return false;

        const interactionState =
            this._interactions?._rendererStates?.get?.(renderer);
        if (!interactionState?.trayActive || !interactionState.thumbnails?.size)
            return false;

        const previews = interactionState.minimizedWindows
            .map(window => interactionState.thumbnails.get(window))
            .filter(Boolean);

        for (const preview of previews) {
            const {actor} = preview;
            if (!actor?.visible)
                continue;

            const rect = this._previewBaseRects.get(actor) ??
                this._fallbackActorRect(actor);
            if (rect && pointInExpandedRect(rect, x, y, PREVIEW_ACTIVATION_PAD))
                return true;
        }

        return false;
    }

    _fallbackActorRect(actor) {
        const [width, height] = actor?.get_size?.() ?? [0, 0];
        if (!(width > 0) || !(height > 0))
            return null;
        return {x: actor.x, y: actor.y, width, height};
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

        if (type !== Clutter.EventType.BUTTON_PRESS ||
            renderer._isDockFullyHidden?.())
            return state.originalCapturedEvent.call(renderer, event);

        const button = event.get_button?.() ?? 0;
        if (button !== Clutter.BUTTON_PRIMARY &&
            button !== Clutter.BUTTON_MIDDLE &&
            button !== Clutter.BUTTON_SECONDARY)
            return state.originalCapturedEvent.call(renderer, event);

        const [x, y] = event.get_coords();
        const item = this._findSpecialHit(renderer, x, y);
        if (!item)
            return state.originalCapturedEvent.call(renderer, event);

        this._pinSpecialHover(renderer, item);

        if (button === Clutter.BUTTON_SECONDARY) {
            if (this._openSpecialMenu(item))
                return Clutter.EVENT_STOP;
            return state.originalCapturedEvent.call(renderer, event);
        }

        if (item.kind === 'show-apps') {
            if (button !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_STOP;

            try {
                item.source.checked = !item.source.checked;
                return Clutter.EVENT_STOP;
            } catch (error) {
                console.error(`[macOS Dock] Failed direct Show Apps activation: ${error}`);
                return state.originalCapturedEvent.call(renderer, event);
            }
        }

        if (item.kind === 'app' &&
            (button === Clutter.BUTTON_PRIMARY ||
             button === Clutter.BUTTON_MIDDLE)) {
            try {
                item.source.activate(button);
                return Clutter.EVENT_STOP;
            } catch (error) {
                console.error(`[macOS Dock] Failed direct special-item activation: ${error}`);
                return state.originalCapturedEvent.call(renderer, event);
            }
        }

        return state.originalCapturedEvent.call(renderer, event);
    }

    _pinSpecialHover(renderer, item) {
        const integrityState =
            this._inputIntegrity?._rendererStates?.get?.(renderer);
        this._inputIntegrity?._setSpecialHover?.(
            renderer, integrityState, item.actor ?? null);
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
            console.error(`[macOS Dock] Failed direct special-item menu: ${error}`);
            return false;
        }
    }

    _findSpecialHit(renderer, x, y) {
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const item of renderer?._items ?? []) {
            if (!this._isSpecialItem(item))
                continue;

            const rects = [];
            if (item.visualRect)
                rects.push(item.visualRect);

            const transformed = transformedRect(item.actor);
            if (transformed)
                rects.push(transformed);

            for (const rect of rects) {
                if (!pointInRect(rect, x, y))
                    continue;

                const dx = x - (rect.x + rect.width / 2);
                const dy = y - (rect.y + rect.height / 2);
                const distance = dx * dx + dy * dy;
                if (distance < bestDistance) {
                    best = item;
                    bestDistance = distance;
                }
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
        // The cached renderer rectangle remains available to the caller.
    }
    return null;
}

function pointInRect(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width &&
        y >= rect.y && y <= rect.y + rect.height;
}

function pointInExpandedRect(rect, x, y, padding) {
    return x >= rect.x - padding &&
        x <= rect.x + rect.width + padding &&
        y >= rect.y - padding &&
        y <= rect.y + rect.height + padding;
}
