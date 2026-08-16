// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Clutter} from './dependencies/gi.js';

/**
 * Routes pointer input against the final macOS compositor geometry.
 *
 * Native Dash-to-Dock actors remain the DND/backend proxies, but tray and
 * fish-eye transforms can legitimately paint special items outside their
 * parent's original allocation. A translated child can therefore remain
 * visible while no longer being a reliable native pick target.
 *
 * The final transformed visual rectangle is authoritative for special-item
 * pointer activation. Normal application icons keep native handling inside
 * their ordinary allocation so app drag/reorder behavior remains unchanged.
 */
export class MacDockInputRouter {
    constructor(macEffects, thumbnailFisheye, dockManager) {
        this._macEffects = macEffects;
        this._thumbnailFisheye = thumbnailFisheye;
        this._dockManager = dockManager;
        this._settings = macEffects?._settings ?? null;
        this._states = new Map();

        this._docksReadyId = dockManager?.connect?.(
            'docks-ready', () => this._sync()) ?? 0;
        this._styleChangedId = this._settings?.connect?.(
            'changed::macos-style', () => this._sync()) ?? 0;

        this._sync();
    }

    destroy() {
        if (this._docksReadyId)
            this._dockManager?.disconnect?.(this._docksReadyId);
        if (this._styleChangedId)
            this._settings?.disconnect?.(this._styleChangedId);

        for (const renderer of [...this._states.keys()])
            this._detach(renderer);

        this._states.clear();
        this._settings = null;
        this._dockManager = null;
        this._thumbnailFisheye = null;
        this._macEffects = null;
    }

    _sync() {
        if (!this._macEffects)
            return;

        const enabled = this._settings?.get_boolean('macos-style') ?? false;
        const renderers = enabled
            ? [...this._macEffects._renderers.values()]
            : [];

        for (const renderer of [...this._states.keys()]) {
            if (!renderers.includes(renderer))
                this._detach(renderer);
        }

        for (const renderer of renderers) {
            if (!this._states.has(renderer))
                this._attach(renderer);
        }
    }

    _attach(renderer) {
        if (!renderer || typeof renderer._onCapturedEvent !== 'function')
            return;

        const state = {
            originalCapturedEvent: renderer._onCapturedEvent,
            hoveredSpecialActor: null,
        };

        renderer._onCapturedEvent = event => {
            const routed = this._routeEvent(renderer, event);
            if (routed !== null)
                return routed;
            return state.originalCapturedEvent.call(renderer, event);
        };

        this._states.set(renderer, state);
    }

    _detach(renderer) {
        const state = this._states.get(renderer);
        if (!state)
            return;

        this._setSpecialHover(renderer, state, null);

        try {
            renderer._onCapturedEvent = state.originalCapturedEvent;
        } catch {
            // Renderer may already be destroyed during a dock rebuild.
        }

        this._states.delete(renderer);
    }

    _routeEvent(renderer, event) {
        if (!event || renderer?._destroyed || renderer?._dragging)
            return null;

        let type;
        try {
            type = event.type();
        } catch {
            return null;
        }

        if (type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            const special = this._hitFinalVisual(renderer, x, y, true);
            this._setSpecialHover(renderer, this._states.get(renderer),
                special?.item?.actor ?? null);
            return null;
        }

        if (renderer._isDockFullyHidden?.() ||
            type !== Clutter.EventType.BUTTON_PRESS)
            return null;

        const [x, y] = event.get_coords();
        const hit = this._hitFinalVisual(renderer, x, y);
        if (!hit)
            return null;

        const special = this._isSpecialItem(hit.item);
        const inBaseRect = hit.item.baseRect &&
            pointInRect(hit.item.baseRect, x, y);

        // Normal application icons keep native handling within their ordinary
        // tile allocation. That preserves app drag/reorder gestures. Only the
        // visually overflowing portion uses this router. Special trailing items
        // always route here because tray translations can move their native
        // proxy beyond a parent's pick/input allocation.
        if (!special && inBaseRect)
            return null;

        const button = event.get_button?.() ?? 0;

        if (button === Clutter.BUTTON_SECONDARY && hit.item.source?.popupMenu) {
            hit.item.source.popupMenu();
            return Clutter.EVENT_STOP;
        }

        if (hit.item.kind === 'show-apps') {
            if (button !== Clutter.BUTTON_PRIMARY)
                return null;

            try {
                // DockManager already owns notify::checked and performs the
                // actual overview/app-grid transition. Toggle that semantic
                // property instead of synthesizing a pointer event at a stale
                // native hit target.
                hit.item.source.checked = !hit.item.source.checked;
                return Clutter.EVENT_STOP;
            } catch (error) {
                console.error(`[macOS Dock] Failed to toggle Show Apps: ${error}`);
                return null;
            }
        }

        if (hit.item.kind === 'app' &&
            (button === Clutter.BUTTON_PRIMARY ||
             button === Clutter.BUTTON_MIDDLE)) {
            try {
                // This is the same DockAppIcon activation API used by the
                // native Dash, so Trash/location apps and ordinary app overflow
                // preserve Dash-to-Dock click-action semantics.
                hit.item.source.activate(button);
                return Clutter.EVENT_STOP;
            } catch (error) {
                console.error(`[macOS Dock] Failed to activate Dock item: ${error}`);
                return null;
            }
        }

        return null;
    }

    _hitFinalVisual(renderer, x, y, specialOnly = false) {
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
                best = {item, rect};
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
            // This includes fish-eye scale, tray displacement and any later
            // bounce translation. Cached visualRect cannot represent all three.
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            if ([x, y, width, height].every(Number.isFinite) &&
                width > 0 && height > 0)
                return {x, y, width, height};
        } catch {
            // Fall back to the renderer's cached geometry below.
        }

        return item.visualRect ?? null;
    }

    _isSpecialItem(item) {
        return item?.kind === 'show-apps' ||
            (item?.kind === 'app' &&
             (item.app?.location || item.app?.isTrash));
    }

    _setSpecialHover(renderer, state, actor) {
        if (!state || state.hoveredSpecialActor === actor)
            return;

        const previous = state.hoveredSpecialActor;
        state.hoveredSpecialActor = actor;

        // Reuse the v117 thumbnail hover-pin manager. This gives thumbnails,
        // Trash, locations and Show Apps one shared actor set and one owner of
        // requiresVisibility, so crossing between them cannot leave the Dock
        // hidden or permanently pinned open.
        if (previous)
            this._thumbnailFisheye?._setThumbnailHover?.(renderer, previous, false);
        if (actor)
            this._thumbnailFisheye?._setThumbnailHover?.(renderer, actor, true);
    }
}

function pointInRect(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width &&
        y >= rect.y && y <= rect.y + rect.height;
}
