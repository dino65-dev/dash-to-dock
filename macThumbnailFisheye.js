// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    GLib,
    St,
} from './dependencies/gi.js';

import {Main} from './dependencies/shell/ui.js';

const SCALE_EPSILON = 0.0025;
const VELOCITY_EPSILON = 0.02;

/**
 * Makes minimized-window thumbnails participate in the same continuous
 * magnification field as normal macOS Dock items without changing the known-good
 * macDockEffects renderer.
 *
 * v114 intentionally created thumbnails outside renderer._items, so the main
 * fish-eye solver never saw them. This companion treats thumbnails as virtual
 * Dock items: same pointer-distance curve, same spring response/damping and an
 * edge-anchored compositor scale. Extra thumbnail growth is propagated only
 * toward the trailing Dock section so previews cannot overlap Trash/locations.
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
        const previousFrame = this._rendererFrameTimes.get(renderer) ?? now - 1000 / 60;
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

        // The stock renderer activation zone is still authoritative for normal
        // Dock space. A directly hovered thumbnail also activates the wave because
        // thumbnails can extend beyond the native Dash allocation after shifting.
        const active = previews.some(preview => preview.actor.hover) ||
            !!renderer._pointerInActivationZone?.(pointerX, pointerY);

        let moving = false;
        const geometry = [];
        let cumulativeGrowth = 0;
        let trayMinX = Number.POSITIVE_INFINITY;
        let trayMinY = Number.POSITIVE_INFINITY;
        let trayMaxX = Number.NEGATIVE_INFINITY;
        let trayMaxY = Number.NEGATIVE_INFINITY;

        for (const preview of previews) {
            const actor = preview.actor;
            const [width, height] = actor.get_size();
            const baseX = actor.x;
            const baseY = actor.y;
            const center = horizontal
                ? baseX + width / 2
                : baseY + height / 2;
            const distance = Math.abs(center - pointerAxis);
            let influence = 0;

            if (active && distance < radius) {
                const q = Math.max(0, Math.min(1, 1 - distance / radius));
                const s = Math.sin(q * Math.PI / 2);
                influence = s * s;
            }

            const previewState = this._previewState(preview);
            previewState.targetScale = 1 + (maxScale - 1) * influence;
            [previewState.scale, previewState.velocity] = springStep(
                previewState.scale,
                previewState.velocity,
                previewState.targetScale,
                response,
                damping,
                dt);

            if (Math.abs(previewState.scale - previewState.targetScale) > SCALE_EPSILON ||
                Math.abs(previewState.velocity) > VELOCITY_EPSILON)
                moving = true;

            const extent = horizontal ? width : height;
            const growth = Math.max(0, extent * (previewState.scale - 1));
            const primaryShift = cumulativeGrowth + growth / 2;
            geometry.push({
                preview,
                width,
                height,
                baseX,
                baseY,
                scale: previewState.scale,
                primaryShift,
            });
            cumulativeGrowth += growth;
        }

        const [pivotX, pivotY] = this._pivotForPosition(renderer);
        for (const entry of geometry) {
            const {preview, width, height, baseX, baseY, scale, primaryShift} = entry;
            const x = baseX + (horizontal ? primaryShift : 0);
            const y = baseY + (horizontal ? 0 : primaryShift);

            preview.actor.set_position(Math.round(x), Math.round(y));
            preview.actor.set_scale(scale, scale);

            // Magnified preview artwork bulges out of the material on the short
            // axis exactly like app icons. On the Dock's long axis, however, the
            // tray grows so following items never overlap the preview.
            const visualX = x + pivotX * width * (1 - scale);
            const visualY = y + pivotY * height * (1 - scale);
            const visualWidth = width * scale;
            const visualHeight = height * scale;

            if (horizontal) {
                trayMinX = Math.min(trayMinX, visualX);
                trayMaxX = Math.max(trayMaxX, visualX + visualWidth);
                trayMinY = Math.min(trayMinY, baseY);
                trayMaxY = Math.max(trayMaxY, baseY + height);
            } else {
                trayMinX = Math.min(trayMinX, baseX);
                trayMaxX = Math.max(trayMaxX, baseX + width);
                trayMinY = Math.min(trayMinY, visualY);
                trayMaxY = Math.max(trayMaxY, visualY + visualHeight);
            }
        }

        if (cumulativeGrowth > 0.001 && state.specialIndex >= 0) {
            const items = renderer._orderedItems();
            for (let i = state.specialIndex; i < items.length; i++)
                this._interactions._shiftPaintedItem(renderer, items[i], cumulativeGrowth);
        }
        state.shiftAmount += cumulativeGrowth;

        if (Number.isFinite(trayMinX)) {
            state.trayBounds = {
                minX: trayMinX,
                minY: trayMinY,
                maxX: trayMaxX,
                maxY: trayMaxY,
            };
        }

        if (active || moving)
            renderer._wake?.();
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
