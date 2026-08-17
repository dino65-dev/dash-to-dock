// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    GLib,
    St,
} from './dependencies/gi.js';

import {Main} from './dependencies/shell/ui.js';

import {computeTrailingOverlapGuard} from './macTrayLayout.js';

const SCALE_EPSILON = 0.0025;
const VELOCITY_EPSILON = 0.02;
const BOUNDARY_MIN_GAP = 6;

/**
 * Magnifies minimized-window previews without owning layout.
 *
 * MacDockInteractions establishes the compact tray allocation once per frame.
 * This layer changes only compositor scale. No thumbnail position, material
 * width, or base trailing-system displacement is derived from spring growth.
 * If a single/centered preview visually reaches the trailing system section,
 * only that section receives the exact positive overlap correction needed.
 */
export class MacThumbnailFisheye {
    constructor(interactions) {
        this._interactions = interactions;
        this._settings = interactions?._settings ?? null;
        this._previewStates = new WeakMap();
        this._rendererFrameTimes = new WeakMap();

        this._originalCreateThumbnail = interactions?._createThumbnail ?? null;
        this._originalPostPaintItems = interactions?._postPaintItems ?? null;

        if (!interactions || !this._originalCreateThumbnail ||
            !this._originalPostPaintItems)
            return;

        interactions._createThumbnail = (renderer, window) =>
            this._createThumbnail(renderer, window);
        interactions._postPaintItems = (renderer, state) => {
            this._originalPostPaintItems.call(interactions, renderer, state);
            this._applyFisheye(renderer, state);
        };

        this._rebuildExistingThumbnails();
    }

    destroy() {
        const interactions = this._interactions;
        if (!interactions)
            return;

        if (this._originalCreateThumbnail)
            interactions._createThumbnail = this._originalCreateThumbnail;
        if (this._originalPostPaintItems)
            interactions._postPaintItems = this._originalPostPaintItems;

        for (const [renderer, state] of interactions._rendererStates ?? []) {
            for (const preview of state.thumbnails?.values?.() ?? []) {
                try {
                    preview.actor.remove_all_transitions?.();
                    preview.actor.set_scale(1, 1);
                } catch {
                    // Preview may already be destroyed during extension shutdown.
                }
            }
            renderer._materialRect = null;
            renderer._wake?.();
        }

        this._rendererFrameTimes = new WeakMap();
        this._previewStates = new WeakMap();
        this._originalCreateThumbnail = null;
        this._originalPostPaintItems = null;
        this._settings = null;
        this._interactions = null;
    }

    _rebuildExistingThumbnails() {
        const interactions = this._interactions;
        for (const [renderer, state] of interactions._rendererStates ?? []) {
            for (const preview of state.thumbnails?.values?.() ?? []) {
                try {
                    preview.actor.destroy();
                } catch {
                    // Preview may already have disappeared with its window.
                }
            }
            state.thumbnails?.clear?.();
            interactions._syncThumbnailActors(renderer, state);
        }
    }

    _createThumbnail(renderer, window) {
        const source = window.get_compositor_private?.();
        if (!source)
            return null;

        const [sourceWidth, sourceHeight] = source.get_size?.() ?? [0, 0];
        if (!sourceWidth || !sourceHeight)
            return null;

        const normalItems = (renderer._items ?? []).filter(item =>
            item.kind === 'app' && !item.app?.location && !item.app?.isTrash);
        const baseSize = Math.max(32, normalItems[0]?.baseSize ?? 48);
        const height = Math.max(26, Math.min(40, baseSize * 0.70));
        const width = Math.max(height * 0.78,
            Math.min(height * 1.70, height * sourceWidth / sourceHeight));

        const clone = new Clutter.Clone({source, reactive: false});
        clone.set_size(Math.round(width), Math.round(height));

        const actor = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            child: clone,
            style: 'padding: 1px; border-radius: 6px; ' +
                'background-color: rgba(255,255,255,0.10); ' +
                'border: 1px solid rgba(255,255,255,0.24);',
            accessible_name: window.get_title?.() ?? 'Minimized window',
        });
        actor.set_size(Math.round(width + 2), Math.round(height + 2));

        const [pivotX, pivotY] = this._pivotForPosition(renderer);
        actor.set_pivot_point(pivotX, pivotY);

        actor.connect('clicked', () => {
            try {
                if (window.minimized)
                    window.unminimize();
                Main.activateWindow(window);
            } catch {
                // Window may have closed between click and activation.
            }
        });

        // Thumbnails live in the detached visual layer rather than the native
        // Dash allocation, so pointer events on them must wake the renderer's
        // frame clock explicitly.
        for (const signal of ['enter-event', 'motion-event', 'leave-event']) {
            actor.connect(signal, () => {
                renderer._wake?.();
                return Clutter.EVENT_PROPAGATE;
            });
        }

        renderer._layer.add_child(actor);
        const preview = {actor, clone, window};
        this._previewStates.set(preview, {
            scale: 1,
            velocity: 0,
            targetScale: 1,
        });
        return preview;
    }

    _applyFisheye(renderer, state) {
        if (!state?.trayActive || !state.thumbnails?.size ||
            renderer._isDockFullyHidden?.())
            return;

        const previews = state.minimizedWindows
            .map(window => state.thumbnails.get(window))
            .filter(Boolean);
        if (!previews.length)
            return;

        const now = GLib.get_monotonic_time() / 1000;
        const previousFrame =
            this._rendererFrameTimes.get(renderer) ?? now - 1000 / 60;
        let dt = (now - previousFrame) / 1000;
        if (!Number.isFinite(dt) || dt <= 0)
            dt = 1 / 60;
        dt = Math.min(dt, 0.05);
        this._rendererFrameTimes.set(renderer, now);

        const [pointerX, pointerY] = global.get_pointer();
        const horizontal = renderer._dock.isHorizontal;
        const pointerAxis = horizontal ? pointerX : pointerY;
        const maxScale = 1 + Math.max(0,
            this._settings.get_double('macos-magnification'));
        const radius = Math.max(32,
            this._settings.get_double('macos-magnification-radius'));
        const response = Math.max(8,
            this._settings.get_double('macos-spring-response'));
        const damping = Math.max(0.5,
            this._settings.get_double('macos-spring-damping'));
        const active =
            !!renderer._pointerInActivationZone?.(pointerX, pointerY);
        let moving = false;
        const scaled = [];

        for (let i = 0; i < previews.length; i++) {
            const preview = previews[i];
            const actor = preview.actor;
            const [width, height] = actor.get_size();
            const center = horizontal
                ? actor.x + width / 2
                : actor.y + height / 2;
            const distance = Math.abs(center - pointerAxis);
            let influence = 0;

            if (active && distance < radius) {
                const q = Math.max(0, Math.min(1, 1 - distance / radius));
                const sin = Math.sin(q * Math.PI / 2);
                influence = sin * sin;
            }

            const previewState = this._previewState(preview);
            previewState.targetScale =
                1 + (maxScale - 1) * influence;
            [previewState.scale, previewState.velocity] = springStep(
                previewState.scale,
                previewState.velocity,
                previewState.targetScale,
                response,
                damping,
                dt);

            if (Math.abs(previewState.scale - previewState.targetScale) >
                SCALE_EPSILON ||
                Math.abs(previewState.velocity) > VELOCITY_EPSILON)
                moving = true;

            const [pivotX, pivotY] = this._pivotForPreview(
                renderer, i, previews.length);
            actor.set_pivot_point(pivotX, pivotY);
            actor.set_scale(previewState.scale, previewState.scale);
            scaled.push({actor, scale: previewState.scale});
        }

        // Keep the most magnified preview above neighboring preview artwork.
        scaled.sort((a, b) => a.scale - b.scale);
        for (const entry of scaled)
            entry.actor.raise_top?.();

        const boundary = this._trailingBoundaryItem(renderer, state);
        const lastPreview = previews.at(-1);
        const guard = computeTrailingOverlapGuard({
            horizontal,
            previewRect: transformedRect(lastPreview?.actor),
            boundaryRect: transformedRect(boundary?.actor),
            minGap: BOUNDARY_MIN_GAP,
        });

        if (guard > 0.001 && state.specialIndex >= 0) {
            const items = renderer._orderedItems();
            for (let i = state.specialIndex; i < items.length; i++)
                this._interactions._shiftPaintedItem(renderer, items[i], guard);
            state.shiftAmount += guard;
            state.boundaryGuard = guard;
        } else {
            state.boundaryGuard = 0;
        }

        if (active || moving)
            renderer._wake?.();
    }

    _trailingBoundaryItem(renderer, state) {
        const items = renderer._orderedItems?.() ?? renderer._items ?? [];
        if (state.specialIndex >= 0)
            return items[state.specialIndex] ?? null;
        return null;
    }

    _pivotForPreview(renderer, index, count) {
        const primary = count > 1 ? index / (count - 1) : 0.25;
        switch (renderer._dock.position) {
        case St.Side.TOP:
            return [primary, 0];
        case St.Side.LEFT:
            return [0, primary];
        case St.Side.RIGHT:
            return [1, primary];
        case St.Side.BOTTOM:
        default:
            return [primary, 1];
        }
    }

    _previewState(preview) {
        let state = this._previewStates.get(preview);
        if (!state) {
            state = {scale: 1, velocity: 0, targetScale: 1};
            this._previewStates.set(preview, state);
        }
        return state;
    }

    _pivotForPosition(renderer) {
        switch (renderer._dock.position) {
        case St.Side.TOP:
            return [0.5, 0];
        case St.Side.LEFT:
            return [0, 0.5];
        case St.Side.RIGHT:
            return [1, 0.5];
        case St.Side.BOTTOM:
        default:
            return [0.5, 1];
        }
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
        // Actor may disappear during a window/dock rebuild.
    }
    return null;
}

/**
 * Stable implicit integration of the same damped second-order spring used by
 * macDockEffects.js:
 *
 *   x'' + 2*zeta*omega*x' + omega^2*(x - target) = 0
 */
function springStep(value, velocity, target, omega, damping, dt) {
    const f = 1 + 2 * dt * damping * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const inverseDeterminant = 1 / (f + hhoo);
    const nextValue =
        (f * value + dt * velocity + hhoo * target) * inverseDeterminant;
    const nextVelocity =
        (velocity + hoo * (target - value)) * inverseDeterminant;
    return [nextValue, nextVelocity];
}
