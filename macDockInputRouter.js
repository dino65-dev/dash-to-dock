// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Clutter, GLib} from './dependencies/gi.js';

/**
 * Routes pointer input against the final macOS compositor geometry.
 *
 * Native Dash-to-Dock actors remain the DND/backend proxies, but tray and
 * fish-eye transforms can legitimately paint special items outside their
 * parent's original allocation. Clutter cannot pick a translated child once
 * an ancestor/input region excludes that point, even when the child is visible.
 *
 * This service therefore makes the final transformed visual rectangle
 * authoritative for special-item pointer activation while preserving native
 * handling inside normal application allocations so app reordering/dragging is
 * not changed.
 */
export class MacDockInputRouter {
    constructor(macEffects, interactions, dockManager) {
        this._macEffects = macEffects;
        this._interactions = interactions;
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
        this._interactions = null;
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
            hoverPinned: false,
            previousRequiresVisibility: false,
            previousVisibilityWasTimed: false,
            releaseId: 0,
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

        if (state.releaseId)
            GLib.source_remove(state.releaseId);
        state.releaseId = 0;
        this._releaseVisualHover(renderer, state, true);

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
            this._updateVisualHover(renderer, x, y);
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
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            if ([x, y, width, height].every(Number.isFinite) &&
                width > 0 && height > 0) {
                return {x, y, width, height};
            }
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

    _updateVisualHover(renderer, x, y) {
        const state = this._states.get(renderer);
        if (!state)
            return;

        const specialHit = this._hitFinalVisual(renderer, x, y, true);
        if (specialHit) {
            this._pinVisualHover(renderer, state);
            return;
        }

        if (!state.hoverPinned)
            return;

        // Defer release until target hover notifications from the same motion
        // event have run. This avoids fighting the minimized-thumbnail hover pin
        // when crossing directly between a thumbnail and Trash/Show Apps.
        if (state.releaseId)
            return;

        state.releaseId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            state.releaseId = 0;
            const [pointerX, pointerY] = global.get_pointer();
            if (this._hitFinalVisual(renderer, pointerX, pointerY, true) ||
                this._thumbnailHovered(renderer))
                return GLib.SOURCE_REMOVE;

            this._releaseVisualHover(renderer, state, false);
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(state.releaseId,
            '[dash-to-dock] macOS special visual hover release');
    }

    _pinVisualHover(renderer, state) {
        if (state.releaseId) {
            GLib.source_remove(state.releaseId);
            state.releaseId = 0;
        }

        const dock = renderer?._dock;
        const dash = dock?.dash;
        const box = dock?._box;
        if (!dock || !dash || !box)
            return;

        if (!state.hoverPinned) {
            state.previousRequiresVisibility = !!dash.requiresVisibility;
            state.previousVisibilityWasTimed = !!dash._requiresVisibilityTimeout;
            state.hoverPinned = true;
        }

        // Reassert on every motion so crossing from a separately pinned
        // thumbnail cannot clear this visual-region hold due signal ordering.
        box.set_hover?.(true);
        if (!dash.requiresVisibility)
            dash.requiresVisibility = true;
        dock._show?.();
        renderer._wake?.();
    }

    _releaseVisualHover(renderer, state, force) {
        if (!state?.hoverPinned)
            return;

        const dock = renderer?._dock;
        const dash = dock?.dash;
        const box = dock?._box;
        state.hoverPinned = false;

        if (!dock || !dash || !box)
            return;

        box.sync_hover?.();

        if (!force && this._thumbnailHovered(renderer))
            return;

        const timedVisibilityStillActive = !!dash._requiresVisibilityTimeout;
        const preserveUntimedVisibility =
            state.previousRequiresVisibility && !state.previousVisibilityWasTimed;
        const shouldRemainRequired =
            timedVisibilityStillActive || preserveUntimedVisibility;

        if (dash.requiresVisibility !== shouldRemainRequired)
            dash.requiresVisibility = shouldRemainRequired;

        dock._updateDashVisibility?.();
        renderer._wake?.();
    }

    _thumbnailHovered(renderer) {
        const interactionState = this._interactions?._rendererStates?.get(renderer);
        for (const preview of interactionState?.thumbnails?.values?.() ?? []) {
            if (preview.actor?.hover)
                return true;
        }
        return false;
    }
}

function pointInRect(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width &&
        y >= rect.y && y <= rect.y + rect.height;
}
