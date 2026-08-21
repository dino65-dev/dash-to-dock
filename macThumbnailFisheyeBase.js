// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    St,
} from './dependencies/gi.js';

import {Main} from './dependencies/shell/ui.js';

/**
 * Paints minimized-window previews from the renderer's unified effect state.
 *
 * MacDockEffects owns the one app -> preview -> system-item magnification wave.
 * MacDockInteractions owns base positions and primary-axis offsets. This class
 * applies only the already-integrated scale and paint order, so it cannot create
 * a second coordinate system or move Trash after its target was calculated.
 */
export class MacThumbnailFisheye {
    constructor(interactions) {
        this._interactions = interactions;
        this._settings = interactions?._settings ?? null;
        this._previewStates = new WeakMap();

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
        const effectItem = {
            kind: 'thumbnail',
            actor,
            baseSize: Math.max(width + 2, height + 2),
            effectExtent: width + 2,
            scale: 1,
            scaleVelocity: 0,
            targetScale: 1,
            offset: 0,
            offsetVelocity: 0,
            targetOffset: 0,
            layoutShift: 0,
            baseCenterX: 0,
            baseCenterY: 0,
            baseRect: null,
        };
        const preview = {actor, clone, window, effectItem};
        effectItem.preview = preview;
        this._previewStates.set(preview, effectItem);
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

        const scaled = [];

        for (const preview of previews) {
            const {actor} = preview;
            const previewState = this._previewState(preview);
            const [pivotX, pivotY] = this._pivotForPosition(renderer);
            const scale = Number.isFinite(previewState.scale)
                ? Math.max(1, previewState.scale)
                : 1;
            actor.set_pivot_point(pivotX, pivotY);
            actor.set_scale(scale, scale);
            scaled.push({actor, scale});
        }

        // Keep the most magnified preview above neighboring preview artwork.
        scaled.sort((a, b) => a.scale - b.scale);
        for (const entry of scaled)
            entry.actor.raise_top?.();
    }

    _previewState(preview) {
        let state = preview?.effectItem ?? this._previewStates.get(preview);
        if (!state) {
            state = {
                scale: 1,
                scaleVelocity: 0,
                targetScale: 1,
                offset: 0,
                offsetVelocity: 0,
                targetOffset: 0,
            };
            preview.effectItem = state;
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
