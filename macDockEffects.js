// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    St,
} from './dependencies/gi.js';

import {Main} from './dependencies/shell/ui.js';

const MACOS_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock.macos';
const MACOS_BACKGROUND_STYLE = [
    'border-radius: 22px',
    'border-width: 1px',
    'border-color: rgba(255, 255, 255, 0.14)',
    'box-shadow: 0 8px 24px 0 rgba(0, 0, 0, 0.28)',
].join('; ');

/**
 * Optional macOS-inspired presentation layer for Dash to Dock.
 *
 * The effect deliberately transforms the AppIcon actor rather than the
 * DashItemContainer. The latter owns Dash-to-Dock's add/remove animations and
 * allocation geometry; keeping it untouched avoids fighting those transitions
 * and keeps drag-and-drop/hit testing based on stable allocations.
 */
export class MacDockEffects {
    constructor(dockManager, extension) {
        this._dockManager = dockManager;
        this._settings = extension.getSettings(MACOS_SCHEMA);
        this._controllers = new Map();

        this._docksReadyId = dockManager.connect('docks-ready', () => this._sync());
        this._settingsChangedId = this._settings.connect('changed::macos-style', () => this._sync());

        this._sync();
    }

    destroy() {
        if (!this._dockManager)
            return;

        if (this._docksReadyId)
            this._dockManager.disconnect(this._docksReadyId);
        if (this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);

        for (const controller of this._controllers.values())
            controller.destroy();
        this._controllers.clear();
        this._settings = null;
        this._dockManager = null;
    }

    _sync() {
        if (!this._dockManager)
            return;

        const enabled = this._settings.get_boolean('macos-style');
        const docks = this._dockManager._allDocks ?? [];

        for (const [dock, controller] of this._controllers) {
            if (!enabled || !docks.includes(dock)) {
                controller.destroy();
                this._controllers.delete(dock);
            }
        }

        if (!enabled)
            return;

        for (const dock of docks) {
            if (this._controllers.has(dock))
                continue;

            const controller = new DockMagnifier(dock, this._settings);
            controller.enable();
            this._controllers.set(dock, controller);
        }
    }
}

class DockMagnifier {
    constructor(dock, settings) {
        this._dock = dock;
        this._settings = settings;
        this._eventActor = dock._box;
        this._itemsActor = dock.dash._box;
        this._backgroundActor = dock.dash._background;
        this._originalBackgroundStyle = null;
        this._dragging = false;
        this._inside = false;
        this._connections = [];
    }

    enable() {
        this._dock.add_style_class_name('macos-style');
        this._applyMacStyle();

        // The outer dock box is already reactive and receives pointer events on
        // both X11 and Wayland. No compositor-specific pointer API is required.
        this._connect(this._eventActor, 'enter-event', () => {
            this._inside = true;
            return Clutter.EVENT_PROPAGATE;
        });
        this._connect(this._eventActor, 'motion-event', (_actor, event) => {
            if (!this._dragging) {
                const [x, y] = event.get_coords();
                this._update(x, y);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._connect(this._eventActor, 'leave-event', () => {
            this._inside = false;
            this._restore();
            return Clutter.EVENT_PROPAGATE;
        });

        if (!Main.overview.isDummy) {
            this._connect(Main.overview, 'item-drag-begin', () => {
                this._dragging = true;
                this._restore(true);
            });
            this._connect(Main.overview, 'item-drag-end', () => {
                this._dragging = false;
            });
            this._connect(Main.overview, 'item-drag-cancelled', () => {
                this._dragging = false;
            });
        }

        this._connect(this._itemsActor, 'child-added', () => {
            if (this._inside)
                this._restore(true);
        });
        this._connect(this._itemsActor, 'child-removed', () => {
            if (this._inside)
                this._restore(true);
        });
    }

    destroy() {
        this._restore(true);
        this._restoreMacStyle();
        this._dock?.remove_style_class_name('macos-style');

        for (const [actor, id] of this._connections) {
            try {
                actor.disconnect(id);
            } catch (_) {
                // The actor may already have been destroyed with its dock.
            }
        }

        this._connections = [];
        this._dock = null;
        this._settings = null;
        this._eventActor = null;
        this._itemsActor = null;
        this._backgroundActor = null;
    }

    _connect(actor, signal, callback) {
        const id = actor.connect(signal, callback);
        this._connections.push([actor, id]);
    }

    _applyMacStyle() {
        if (!this._backgroundActor)
            return;

        this._originalBackgroundStyle = this._backgroundActor.get_style();
        const currentStyle = this._originalBackgroundStyle?.trim() ?? '';
        const separator = currentStyle && !currentStyle.endsWith(';') ? '; ' : ' ';
        this._backgroundActor.set_style(
            `${currentStyle}${separator}${MACOS_BACKGROUND_STYLE};`);
    }

    _restoreMacStyle() {
        if (!this._backgroundActor)
            return;

        this._backgroundActor.set_style(this._originalBackgroundStyle);
        this._originalBackgroundStyle = null;
    }

    _getItems() {
        if (!this._itemsActor)
            return [];

        return this._itemsActor.get_children()
            .filter(item => item.visible && item.child?.icon && !item.animatingOut)
            .map(item => ({
                item,
                actor: item.child,
            }));
    }

    _update(pointerX, pointerY) {
        const items = this._getItems();
        if (!items.length)
            return;

        const horizontal = this._dock.isHorizontal;
        const pointer = horizontal ? pointerX : pointerY;
        const radius = Math.max(24, this._settings.get_double('macos-magnification-radius'));
        const strength = Math.max(0, this._settings.get_double('macos-magnification'));
        const spread = Math.max(0, this._settings.get_double('macos-spread'));
        const duration = Math.max(0, this._settings.get_int('macos-animation-duration'));

        // A Gaussian produces the continuous macOS-like wave. Sigma is chosen
        // so influence is already very small at the configured radius.
        const sigma = radius / 2.15;
        const twoSigmaSquared = 2 * sigma * sigma;
        const [stageX, stageY] = this._itemsActor.get_transformed_position();

        const samples = [];
        let nearestIndex = -1;
        let nearestDistance = Number.POSITIVE_INFINITY;

        for (let i = 0; i < items.length; i++) {
            const {item} = items[i];
            const box = item.get_allocation_box();
            const center = horizontal
                ? stageX + (box.x1 + box.x2) / 2
                : stageY + (box.y1 + box.y2) / 2;
            const distance = Math.abs(center - pointer);

            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = i;
            }

            const influence = distance > radius
                ? 0
                : Math.exp(-(distance * distance) / twoSigmaSquared);
            const scale = 1 + strength * influence;
            const baseSize = horizontal ? item.width : item.height;

            samples.push({
                influence,
                scale,
                growth: Math.max(0, baseSize * (scale - 1) * spread),
            });
        }

        const translations = new Array(items.length).fill(0);
        if (nearestIndex >= 0 && spread > 0) {
            let accumulated = 0;
            for (let i = nearestIndex - 1; i >= 0; i--) {
                accumulated += (samples[i].growth + samples[i + 1].growth) / 2;
                translations[i] = -accumulated;
            }

            accumulated = 0;
            for (let i = nearestIndex + 1; i < items.length; i++) {
                accumulated += (samples[i - 1].growth + samples[i].growth) / 2;
                translations[i] = accumulated;
            }
        }

        for (let i = 0; i < items.length; i++) {
            const {actor, item} = items[i];
            const {scale, influence} = samples[i];
            const baseSize = horizontal ? item.height : item.width;
            const lift = baseSize * (scale - 1) * 0.12;
            const [pivotX, pivotY, liftX, liftY] = this._transformForPosition(lift);

            actor.set_pivot_point(pivotX, pivotY);
            actor.z_position = Math.round(influence * 100);

            actor.ease({
                scale_x: scale,
                scale_y: scale,
                translation_x: horizontal ? translations[i] : liftX,
                translation_y: horizontal ? liftY : translations[i],
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _transformForPosition(lift) {
        switch (this._dock.position) {
        case St.Side.TOP:
            return [0.5, 0.0, 0, lift];
        case St.Side.LEFT:
            return [0.0, 0.5, lift, 0];
        case St.Side.RIGHT:
            return [1.0, 0.5, -lift, 0];
        case St.Side.BOTTOM:
        default:
            return [0.5, 1.0, 0, -lift];
        }
    }

    _restore(immediate = false) {
        const duration = immediate || !this._settings
            ? 0
            : Math.max(0, this._settings.get_int('macos-animation-duration'));

        for (const {actor} of this._getItems()) {
            actor.ease({
                scale_x: 1,
                scale_y: 1,
                translation_x: 0,
                translation_y: 0,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    actor.z_position = 0;
                },
            });
        }
    }
}
