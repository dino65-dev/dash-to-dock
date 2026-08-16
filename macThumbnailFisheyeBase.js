// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    GLib,
    St,
} from './dependencies/gi.js';

import {Main} from './dependencies/shell/ui.js';

const SCALE_EPSILON = 0.0025;
const VELOCITY_EPSILON = 0.02;
const BOUNDARY_MIN_GAP = 6;

/**
 * Static-layout minimized-window fish-eye.
 *
 * v126 deliberately keeps the compact v124 tray geometry. Thumbnail actor
 * allocations are laid out once by MacDirectInputStability and are never moved
 * by the fish-eye spring. Pointer motion changes compositor scale only.
 *
 * This removes the two bad alternatives from the earlier experiments:
 *  - v124 moved every later preview/system item by live spring growth;
 *  - v125 reserved every preview's full maximum width and created huge gaps.
 *
 * The only extra layout reservation here is a small fixed guard between the
 * final preview and the first trailing system item. The guard is calculated
 * from the actual compact base gap plus the maximum inward/outward scale growth,
 * so Trash/locations/Show Apps cannot overlap the final thumbnail without
 * creating per-thumbnail empty slots.
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
        for (const preview of previews) {
            const actor = preview.actor;
            const [width, height] = actor.get_size();
            const center = horizontal
                ? actor.x + width / 2
                : actor.y + height / 2;
            const distance = Math.abs(center - pointerAxis);
            let influence = 0;

            if (active && distance < radius) {
                const q = Math.max(0, Math.min(1, 1 - distance / radius));
                const s = Math.sin(q * Math.PI / 2);
                influence = s * s;
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

            // Upstream restores the compact actor allocation every frame.
            // Never translate it here: scale is purely a compositor transform.
            actor.set_scale(previewState.scale, previewState.scale);
        }

        const boundary = this._trailingBoundaryItem(renderer, state);
        const lastPreview = previews[previews.length - 1];
        const boundaryGuard = this._boundaryGuard(
            renderer, state, lastPreview, boundary, maxScale);

        if (boundaryGuard > 0.001 && state.specialIndex >= 0) {
            const items = renderer._orderedItems();
            for (let i = state.specialIndex; i < items.length; i++) {
                this._interactions._shiftPaintedItem(
                    renderer, items[i], boundaryGuard);
            }
        }

        // With no Trash/location section, MacInputIntegrity consumes this value
        // later in the same post-paint chain when it shifts Show Apps.
        state.shiftAmount += boundaryGuard;

        // Keep state.trayBounds from the compact v124 layout. Magnified artwork
        // may bulge outside the material just like normal Dock icons, but the
        // material itself never breathes or slides with the thumbnail spring.
        if (active || moving)
            renderer._wake?.();
    }

    _boundaryGuard(renderer, state, preview, boundary, maxScale) {
        if (!preview?.actor || !boundary?.baseRect)
            return 0;

        const [width, height] = preview.actor.get_size();
        const horizontal = renderer._dock.isHorizontal;
        const previewExtent = horizontal ? width : height;
        const boundaryExtent = Math.max(1,
            boundary.baseSize ?? (horizontal
                ? boundary.baseRect.width
                : boundary.baseRect.height));
        const previewGrowth =
            previewExtent * Math.max(0, maxScale - 1) / 2;
        const boundaryGrowth =
            boundaryExtent * Math.max(0, maxScale - 1) / 2;
        const previewEnd = horizontal
            ? preview.actor.x + width
            : preview.actor.y + height;
        const boundaryStart = horizontal
            ? boundary.baseRect.x + state.shiftAmount
            : boundary.baseRect.y + state.shiftAmount;
        const compactGap = Number.isFinite(boundaryStart - previewEnd)
            ? Math.max(0, boundaryStart - previewEnd)
            : 0;

        return Math.max(0,
            previewGrowth + boundaryGrowth + BOUNDARY_MIN_GAP - compactGap);
    }

    _trailingBoundaryItem(renderer, state) {
        const items = renderer._orderedItems?.() ?? renderer._items ?? [];
        if (state.specialIndex >= 0)
            return items[state.specialIndex] ?? null;
        return items.find(item => item.kind === 'show-apps') ?? null;
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
