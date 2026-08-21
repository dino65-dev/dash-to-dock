// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Clutter, GLib, St} from './dependencies/gi.js';
import {Main} from './dependencies/shell/ui.js';
import {MacThumbnailFisheye as MacThumbnailFisheyeBase}
    from './macThumbnailFisheyeBase.js';

/**
 * v120 keeps the green v115 fish-eye implementation plus the v116/v117
 * activation and hover fixes. Floating geometry is maintained as a lifecycle
 * invariant instead of monkeypatching Dash-to-Dock's _resetPosition method.
 *
 * Dash-to-Dock binds some _resetPosition callbacks during construction, so a
 * later method replacement cannot intercept every startup/work-area reset.
 * Instead we observe the dock's real x/y lifecycle, recompute an absolute
 * edge-relative target, and explicitly invalidate Shell's chrome input region.
 * This keeps visual items and the native Trash/Show Apps hit targets aligned.
 */
export class MacThumbnailFisheye extends MacThumbnailFisheyeBase {
    constructor(interactions) {
        super(interactions);
        this._installFloatingGeometry();
    }

    destroy() {
        this._releaseAllDockHoverPins();
        this._removeFloatingGeometry();
        super.destroy();
        this._dockHoverPins?.clear?.();
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
                const event = Clutter.get_current_event?.();
                const timestamp = event?.get_time?.() || global.get_current_time();
                Main.activateWindow(window, timestamp);
            } catch (error) {
                console.error(`[macOS Dock] Failed to activate minimized window: ${error}`);
            }
        });

        actor.connect('notify::hover', () => {
            this._setThumbnailHover(renderer, actor, actor.hover);
            renderer._wake?.();
        });
        actor.connect('destroy', () => {
            // A clicked thumbnail can be destroyed immediately when its window
            // is restored, before Clutter has emitted a final hover=false.
            this._setThumbnailHover(renderer, actor, false);
        });

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
        // MacDockInteractions lays its detached previews out after the normal
        // renderer has painted, so it can accidentally re-show a preview even
        // after macDockEffects has reached the final hidden state. Make hidden
        // authoritative here and reset the spring so the next reveal starts
        // cleanly from 1x instead of from a stale magnified transform.
        if (renderer._isDockFullyHidden?.()) {
            this._releaseDockHoverPin(renderer);
            for (const preview of state?.thumbnails?.values?.() ?? []) {
                try {
                    preview.actor.remove_all_transitions?.();
                    preview.actor.set_scale(1, 1);
                    preview.actor.hide();
                } catch {
                    // Preview may disappear while its window is being restored.
                }

                const previewState = this._previewStates.get(preview);
                if (previewState) {
                    previewState.scale = 1;
                    previewState.scaleVelocity = 0;
                    previewState.targetScale = 1;
                    previewState.offset = 0;
                    previewState.offsetVelocity = 0;
                    previewState.targetOffset = 0;
                }
            }
            return;
        }

        super._applyFisheye(renderer, state);
    }

    _setThumbnailHover(renderer, actor, hovering) {
        const dock = renderer?._dock;
        const dash = dock?.dash;
        const box = dock?._box;
        if (!dock || !dash || !box)
            return;

        this._dockHoverPins ??= new Map();
        let pin = this._dockHoverPins.get(renderer);

        if (!hovering) {
            // Do not create bookkeeping for destroy/leave events after the pin
            // was already released during extension shutdown or window restore.
            if (!pin)
                return;

            pin.actors.delete(actor);
            if (!pin.actors.size)
                this._releaseDockHoverPin(renderer, pin);
            return;
        }

        if (!pin) {
            pin = {
                actors: new Set(),
                previousRequiresVisibility: !!dash.requiresVisibility,
                previousVisibilityWasTimed: !!dash._requiresVisibilityTimeout,
            };
            this._dockHoverPins.set(renderer, pin);
        }

        pin.actors.add(actor);

        // Extend Dash-to-Dock's native hover region instead of adding a custom
        // autohide timer. set_hover() is an St.Widget API, and sync_hover() below
        // restores the real pointer-derived state when the thumbnail is left.
        box.set_hover?.(true);

        // requiresVisibility is Dash-to-Dock's existing higher-priority keep-open
        // property. It also covers intellihide-only configurations where hover by
        // itself is intentionally ignored.
        if (!dash.requiresVisibility)
            dash.requiresVisibility = true;

        // Cancel an already-started hide transition immediately if the pointer
        // crossed from the native Dock allocation into the detached thumbnail.
        dock._show?.();
        renderer._wake?.();
    }

    _releaseDockHoverPin(renderer, knownPin = null) {
        const pin = knownPin ?? this._dockHoverPins?.get(renderer);
        if (!pin)
            return;

        const dock = renderer?._dock;
        const dash = dock?.dash;
        const box = dock?._box;

        this._dockHoverPins?.delete(renderer);

        if (!dock || !dash || !box)
            return;

        // Recompute hover from the actual stage pointer. This emits the same
        // notify::hover transition the normal Dock relies on for its hide delay.
        box.sync_hover?.();

        // Do not clear another subsystem's visibility request. Dash-to-Dock's
        // built-in urgent-app hold uses _requiresVisibilityTimeout; a non-timed
        // pre-existing true value is also preserved for forward compatibility.
        const timedVisibilityStillActive = !!dash._requiresVisibilityTimeout;
        const preserveUntimedVisibility =
            pin.previousRequiresVisibility && !pin.previousVisibilityWasTimed;
        const shouldRemainRequired =
            timedVisibilityStillActive || preserveUntimedVisibility;

        if (dash.requiresVisibility !== shouldRemainRequired)
            dash.requiresVisibility = shouldRemainRequired;

        dock._updateDashVisibility?.();
        renderer._wake?.();
    }

    _releaseAllDockHoverPins() {
        if (!this._dockHoverPins)
            return;

        for (const renderer of [...this._dockHoverPins.keys()])
            this._releaseDockHoverPin(renderer);
    }

    _installFloatingGeometry() {
        const manager = this._interactions?._dockManager;
        const settings = this._settings;
        if (!manager || !settings)
            return;

        this._floatingDockStates = new Map();
        this._floatingRefreshId = 0;
        this._floatingDocksReadyId = manager.connect(
            'docks-ready', () => this._syncFloatingDocks());
        this._floatingStyleId = settings.connect(
            'changed::macos-style', () => this._queueFloatingRefresh());
        this._floatingGapId = settings.connect(
            'changed::macos-floating-gap', () => this._queueFloatingRefresh());

        this._syncFloatingDocks();
    }

    _removeFloatingGeometry() {
        const manager = this._interactions?._dockManager;
        const settings = this._settings;

        if (this._floatingDocksReadyId)
            manager?.disconnect?.(this._floatingDocksReadyId);
        if (this._floatingStyleId)
            settings?.disconnect?.(this._floatingStyleId);
        if (this._floatingGapId)
            settings?.disconnect?.(this._floatingGapId);
        if (this._floatingRefreshId)
            GLib.source_remove(this._floatingRefreshId);

        this._floatingRefreshId = 0;
        for (const dock of [...this._floatingDockStates?.keys?.() ?? []])
            this._detachFloatingDock(dock, true);

        this._floatingDockStates?.clear?.();
        this._floatingDockStates = null;
        this._floatingDocksReadyId = 0;
        this._floatingStyleId = 0;
        this._floatingGapId = 0;
    }

    _syncFloatingDocks() {
        const manager = this._interactions?._dockManager;
        if (!manager || !this._floatingDockStates)
            return;

        const docks = manager._allDocks ?? [];
        for (const dock of [...this._floatingDockStates.keys()]) {
            if (!docks.includes(dock))
                this._detachFloatingDock(dock, false);
        }

        for (const dock of docks) {
            if (!this._floatingDockStates.has(dock))
                this._attachFloatingDock(dock);
        }

        this._queueFloatingRefresh();
    }

    _attachFloatingDock(dock) {
        if (!dock?.connect)
            return;

        const state = {connections: []};
        const queue = () => this._queueFloatingRefresh();

        // Observe the actual fixed coordinates rather than replacing
        // _resetPosition. Dash-to-Dock binds reset callbacks before this module
        // exists, but every reset ultimately writes x/y and therefore reaches us.
        for (const signal of ['notify::x', 'notify::y']) {
            try {
                state.connections.push(dock.connect(signal, queue));
            } catch {
                // Older/future Clutter may expose only one of these properties.
            }
        }

        try {
            state.connections.push(dock.connect('destroy', () => {
                this._floatingDockStates?.delete(dock);
                this._queueFloatingRefresh();
            }));
        } catch {
            // Dock may already be tearing down during a monitor rebuild.
        }

        this._floatingDockStates.set(dock, state);
    }

    _detachFloatingDock(dock, restoreGeometry) {
        const state = this._floatingDockStates?.get(dock);
        if (!state)
            return;

        for (const id of state.connections) {
            try {
                dock.disconnect(id);
            } catch {
                // Dock may already be destroyed.
            }
        }

        this._floatingDockStates.delete(dock);

        if (restoreGeometry)
            this._applyFloatingOffset(dock, 0);
    }

    _queueFloatingRefresh() {
        if (!this._floatingDockStates || this._floatingRefreshId)
            return;

        this._floatingRefreshId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._floatingRefreshId = 0;
                this._refreshFloatingDocks();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(this._floatingRefreshId,
            '[dash-to-dock] macOS floating dock geometry');
    }

    _refreshFloatingDocks() {
        if (!this._floatingDockStates)
            return;

        for (const dock of this._floatingDockStates.keys())
            this._applyFloatingOffset(dock);

        for (const renderer of this._interactions?._macEffects?._renderers?.values?.() ?? []) {
            renderer._materialRect = null;
            renderer._wake?.();
        }
    }

    _applyFloatingOffset(dock, forcedGap = null) {
        const monitor = dock?._monitor;
        if (!monitor)
            return;

        const enabled = this._settings?.get_boolean('macos-style') ?? false;
        const configuredGap = enabled
            ? Math.max(0, Math.min(32,
                this._settings.get_int('macos-floating-gap')))
            : 0;
        const gap = forcedGap ?? configuredGap;

        let targetX = dock.x;
        let targetY = dock.y;

        switch (dock.position) {
        case St.Side.TOP:
            targetY = monitor.y + gap;
            break;
        case St.Side.LEFT:
            targetX = monitor.x + gap;
            break;
        case St.Side.RIGHT:
            targetX = monitor.x + monitor.width - gap;
            break;
        case St.Side.BOTTOM:
        default:
            targetY = monitor.y + monitor.height - gap;
            break;
        }

        const xChanged = Math.abs(dock.x - targetX) > 0.01;
        const yChanged = Math.abs(dock.y - targetY) > 0.01;
        if (!xChanged && !yChanged)
            return;

        if (xChanged)
            dock.x = targetX;
        if (yChanged)
            dock.y = targetY;

        // Shell tracks chrome input regions separately from visual painting.
        // Make the new fixed position authoritative for native proxy targets
        // (Trash, Show Apps, app clicks/DND) before the next redraw.
        dock.queue_relayout?.();
        dock._updateStaticBox?.();
        Main.layoutManager._queueUpdateRegions?.();
    }
}
