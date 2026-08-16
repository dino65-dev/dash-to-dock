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
 * Fixed-slot minimized-window fish-eye.
 *
 * The thumbnail tray is a separate Dock section. Each preview receives a slot
 * large enough for its configured maximum scale. The preview actor keeps the
 * same slot center for the entire hover animation and only its compositor scale
 * changes. This makes magnification incapable of changing tray layout.
 *
 * The trailing system section is shifted once per frame by the maximum slot
 * growth, not by the current spring scale. A fixed guard for the first trailing
 * item also reserves its own maximum inward scale expansion. Consequently:
 *
 *  - direct thumbnail hover cannot make the tray slide under the pointer;
 *  - neighboring previews cannot collide at maximum magnification;
 *  - the last preview cannot grow into Trash/locations/Show Apps;
 *  - material bounds stay based on fixed maximum slots instead of live growth;
 *  - normal app fish-eye, input proxies, DND and autohide remain independent.
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

        // v124's stable tray proxy extends this activation zone over the
        // detached preview section. The preview visuals themselves do not need
        // to own pointer hover and therefore cannot feed layout back into input.
        const active =
            !!renderer._pointerInActivationZone?.(pointerX, pointerY);

        let moving = false;
        const geometry = [];
        let cumulativeSlotGrowth = 0;

        for (const preview of previews) {
            const actor = preview.actor;
            const [width, height] = actor.get_size();
            const baseX = actor.x;
            const baseY = actor.y;
            const extent = horizontal ? width : height;
            const slotGrowth = Math.max(0, extent * (maxScale - 1));

            // The fixed slot shift is computed before pointer influence. The
            // fish-eye distance therefore uses the visual slot center rather
            // than the temporary unshifted layout position restored upstream.
            const primaryShift =
                cumulativeSlotGrowth + slotGrowth / 2;
            const center = horizontal
                ? baseX + primaryShift + width / 2
                : baseY + primaryShift + height / 2;
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
                Math.abs(previewState.velocity) > VELOCITY_EPSILON) {
                moving = true;
            }

            // Constant for a given setting/thumbnail size. This is the key
            // invariant: the slot center never depends on the current spring.
            geometry.push({
                preview,
                width,
                height,
                baseX,
                baseY,
                scale: previewState.scale,
                primaryShift,
            });
            cumulativeSlotGrowth += slotGrowth;
        }

        const [pivotX, pivotY] = this._pivotForPosition(renderer);
        let trayMinX = Number.POSITIVE_INFINITY;
        let trayMinY = Number.POSITIVE_INFINITY;
        let trayMaxX = Number.NEGATIVE_INFINITY;
        let trayMaxY = Number.NEGATIVE_INFINITY;

        for (const entry of geometry) {
            const {
                preview,
                width,
                height,
                baseX,
                baseY,
                scale,
                primaryShift,
            } = entry;
            const x = baseX + (horizontal ? primaryShift : 0);
            const y = baseY + (horizontal ? 0 : primaryShift);

            // Position is fixed at the center of the maximum-scale slot.
            // Pointer motion changes only the compositor scale.
            preview.actor.set_position(Math.round(x), Math.round(y));
            preview.actor.set_scale(scale, scale);

            const slotX = x + pivotX * width * (1 - maxScale);
            const slotY = y + pivotY * height * (1 - maxScale);
            const slotWidth = width * maxScale;
            const slotHeight = height * maxScale;

            if (horizontal) {
                trayMinX = Math.min(trayMinX, slotX);
                trayMaxX = Math.max(trayMaxX, slotX + slotWidth);
                trayMinY = Math.min(trayMinY, baseY);
                trayMaxY = Math.max(trayMaxY, baseY + height);
            } else {
                trayMinX = Math.min(trayMinX, baseX);
                trayMaxX = Math.max(trayMaxX, baseX + width);
                trayMinY = Math.min(trayMinY, slotY);
                trayMaxY = Math.max(trayMaxY, slotY + slotHeight);
            }
        }

        // Reserve the entire preview slot growth plus half of the first
        // trailing system item's own maximum growth. This prevents Trash,
        // locations or Show Apps from scaling back into the final preview.
        const boundary = this._trailingBoundaryItem(renderer, state);
        const boundaryGuard = boundary
            ? Math.max(0, boundary.baseSize * (maxScale - 1) / 2)
            : 0;
        const fixedTrailingShift =
            cumulativeSlotGrowth + boundaryGuard;

        if (fixedTrailingShift > 0.001 && state.specialIndex >= 0) {
            const items = renderer._orderedItems();
            for (let i = state.specialIndex; i < items.length; i++) {
                this._interactions._shiftPaintedItem(
                    renderer, items[i], fixedTrailingShift);
            }
        }

        // If there is no Trash/location section, MacInputIntegrity uses this
        // value later in the same post-paint chain to shift Show Apps.
        state.shiftAmount += fixedTrailingShift;

        // Material uses the maximum reserved slots, not live visual extents,
        // so its long-axis size cannot breathe or slide during magnification.
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
