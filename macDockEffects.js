// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    Gio,
    Shell,
    St,
} from './dependencies/gi.js';

import {Main} from './dependencies/shell/ui.js';

const MACOS_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock.macos';
const MIN_TEXTURE_SIZE = 96;
const MAX_TEXTURE_SIZE = 256;
const SPRING_EPSILON = 0.0025;
const OFFSET_EPSILON = 0.08;
const VELOCITY_EPSILON = 0.02;
const MATERIAL_MARGIN = 5;
const MATERIAL_HIDDEN_SLIDE = 0.035;
const EDGE_REVEAL_TOLERANCE = 2;
const REFLECTION_GAP = 2;
const DIVIDER_THICKNESS = 1;
const DOT_SIZE = 4;

/**
 * macOS-style presentation layer for Dash to Dock.
 *
 * Dash-to-Dock remains the application/window, autohide, menu and DND backend.
 * This module replaces only its presentation while macos-style is enabled.
 *
 * Design rules:
 *  - icon textures are created once at high resolution and never resized per frame;
 *  - only compositor transforms change while the pointer moves;
 *  - a Clutter Timeline drives a damped spring from Mutter's frame clock;
 *  - the native Dash actors remain almost transparent input/DND proxies;
 *  - the glass material expands only along the Dock's long axis, like macOS;
 *  - magnified icons are intentionally allowed to bulge outside the material;
 *  - DND temporarily returns completely to native Dash-to-Dock.
 */
export class MacDockEffects {
    constructor(dockManager, extension) {
        this._dockManager = dockManager;
        this._settings = extension.getSettings(MACOS_SCHEMA);
        this._renderers = new Map();

        this._docksReadyId =
            dockManager.connect('docks-ready', () => this._sync());
        this._styleChangedId = this._settings.connect(
            'changed::macos-style', () => this._sync());

        this._sync();
    }

    destroy() {
        if (!this._dockManager)
            return;

        if (this._docksReadyId)
            this._dockManager.disconnect(this._docksReadyId);
        if (this._styleChangedId)
            this._settings.disconnect(this._styleChangedId);

        for (const renderer of this._renderers.values())
            renderer.destroy();
        this._renderers.clear();

        this._settings = null;
        this._dockManager = null;
    }

    _sync() {
        if (!this._dockManager)
            return;

        const enabled = this._settings.get_boolean('macos-style');
        const docks = this._dockManager._allDocks ?? [];

        for (const [dock, renderer] of this._renderers) {
            if (!enabled || !docks.includes(dock)) {
                renderer.destroy();
                this._renderers.delete(dock);
            }
        }

        if (!enabled)
            return;

        for (const dock of docks) {
            if (this._renderers.has(dock))
                continue;

            const renderer = new MacDockRenderer(dock, this._settings);
            renderer.enable();
            this._renderers.set(dock, renderer);
        }
    }
}

class MacDockRenderer {
    constructor(dock, settings) {
        this._dock = dock;
        this._settings = settings;
        this._items = [];
        this._connections = [];
        this._needsSync = true;
        this._needsTextureRebuild = true;
        this._dragging = false;
        this._destroyed = false;
        this._timeline = null;
        this._timelineFrameId = 0;
        this._runningFramesWithoutWork = 0;
        this._backgroundOpacity = dock.dash._background.opacity;
        this._lastSeparator = null;
        this._separatorOpacity = 255;
        this._materialRect = null;
        this._blurCore = null;
        this._divider = null;
        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
    }

    enable() {
        this._layer = new Clutter.Actor({
            reactive: false,
            clip_to_allocation: false,
        });
        this._layer.set_size(global.stage.width, global.stage.height);
        Main.uiGroup.add_child(this._layer);

        // Blur is intentionally isolated from the rounded shell. Keeping
        // the compositor blur inside the corner arcs prevents a rectangular
        // offscreen halo from leaking outside the rounded dock.
        this._blurCore = new St.Widget({
            reactive: false,
        });
        this._layer.add_child(this._blurCore);

        this._material = new St.Widget({
            reactive: false,
            style_class: 'macos-dock-native-material',
        });
        this._layer.add_child(this._material);

        this._divider = new St.Widget({
            reactive: false,
        });
        this._layer.add_child(this._divider);

        this._updateMaterialStyle();
        this._configureBlur();
        this._updateDecorationStyle();

        this._connect(this._dock._box, 'enter-event', () => {
            this._wake();
            return Clutter.EVENT_PROPAGATE;
        });
        this._connect(this._dock._box, 'motion-event', () => {
            this._wake();
            return Clutter.EVENT_PROPAGATE;
        });
        this._connect(this._dock._box, 'leave-event', () => {
            this._wake();
            return Clutter.EVENT_PROPAGATE;
        });
        this._connect(this._dock._slider, 'notify::slide-x', () => this._wake());
        this._connect(this._dock, 'showing', () => {
            this._materialRect = null;
            this._wake();
        });
        this._connect(this._dock, 'hiding', () => this._wake());
        this._connect(this._dock.dash._box, 'child-added', () => this._queueSync());
        this._connect(this._dock.dash._box, 'child-removed', () => this._queueSync());
        this._connect(this._dock.dash, 'icon-size-changed', () => {
            this._needsTextureRebuild = true;
            this._queueSync();
        });
        this._connect(this._dock.dash._showAppsIcon, 'notify::visible',
            () => this._queueSync());
        this._connect(global.stage, 'notify::width', () => this._resizeLayer());
        this._connect(global.stage, 'notify::height', () => this._resizeLayer());
        this._connect(this._interfaceSettings, 'changed::color-scheme', () => {
            this._updateMaterialStyle();
            this._configureBlur();
            this._updateDecorationStyle();
            this._materialRect = null;
            this._wake();
        });

        this._connect(this._settings, 'changed', (_settings, key) => {
            if (key === 'macos-style')
                return;

            if (key === 'macos-magnification' || key === 'macos-icon-quality')
                this._needsTextureRebuild = true;

            const materialSetting = key.startsWith('macos-glass') ||
                key === 'macos-corner-radius' ||
                key === 'macos-adaptive-dark' ||
                key === 'macos-light-opacity' ||
                key === 'macos-dark-opacity' ||
                key === 'macos-dynamic-border' ||
                key === 'macos-border-opacity';

            if (materialSetting) {
                this._updateMaterialStyle();
                this._configureBlur();
                this._updateDecorationStyle();
                this._materialRect = null;
            }

            if (key === 'macos-divider-opacity' || key === 'macos-divider')
                this._updateDecorationStyle();

            this._queueSync();
        });

        if (!Main.overview.isDummy) {
            this._connect(Main.overview, 'item-drag-begin',
                () => this._onDragBegin());
            this._connect(Main.overview, 'item-drag-end',
                () => this._onDragEnd());
            this._connect(Main.overview, 'item-drag-cancelled',
                () => this._onDragEnd());
        }

        // Only captures clicks in the visually magnified portion outside
        // Dash-to-Dock's normal allocation. Native clicks/DND remain untouched.
        this._connect(global.stage, 'captured-event', (_stage, event) =>
            this._onCapturedEvent(event));

        this._syncItems(true);
        this._setMacPresentation(true);
        this._wake();
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this._stopTimeline();
        this._setMacPresentation(false);
        this._destroyItems();

        for (const [actor, id] of this._connections) {
            try {
                actor.disconnect(id);
            } catch {
                // Dock actors may already be gone during extension shutdown.
            }
        }
        this._connections = [];

        this._blurCore?.destroy();
        this._divider?.destroy();
        this._material?.destroy();
        this._layer?.destroy();
        this._blurCore = null;
        this._divider = null;
        this._material = null;
        this._layer = null;
        this._interfaceSettings = null;
        this._settings = null;
        this._dock = null;
    }

    _connect(actor, signal, callback) {
        if (!actor)
            return;

        const id = actor.connect(signal, callback);
        this._connections.push([actor, id]);
    }

    _queueSync() {
        this._needsSync = true;
        this._wake();
    }

    _resizeLayer() {
        if (!this._layer)
            return;

        this._layer.set_size(global.stage.width, global.stage.height);
        this._materialRect = null;
        this._wake();
    }

    _createTimeline() {
        if (this._timeline)
            return;

        try {
            this._timeline = Clutter.Timeline.new_for_actor(this._layer, 1000);
        } catch {
            this._timeline = new Clutter.Timeline({
                actor: this._layer,
                duration: 1000,
            });
        }

        this._timeline.set_repeat_count(-1);
        this._timelineFrameId = this._timeline.connect(
            'new-frame', timeline => this._onFrame(timeline));
    }

    _wake() {
        if (this._destroyed || this._dragging || !this._layer)
            return;

        this._createTimeline();
        this._runningFramesWithoutWork = 0;
        if (!this._timeline.is_playing())
            this._timeline.start();
    }

    _stopTimeline() {
        if (!this._timeline)
            return;

        if (this._timelineFrameId) {
            this._timeline.disconnect(this._timelineFrameId);
            this._timelineFrameId = 0;
        }

        this._timeline.stop();
        this._timeline = null;
    }

    _onFrame(timeline) {
        if (this._destroyed || this._dragging)
            return;

        // App list changes wake the frame clock through child-added/removed.
        // Avoid re-walking the entire Dash application model every display frame.
        if (this._needsSync)
            this._syncItems(this._needsTextureRebuild);

        if (!this._items.length) {
            this._material.hide();
            this._runningFramesWithoutWork++;
            if (this._runningFramesWithoutWork > 2)
                timeline.pause();
            return;
        }

        this._updateBaseGeometry();

        let dt = timeline.get_delta() / 1000;
        if (!Number.isFinite(dt) || dt <= 0)
            dt = 1 / 60;
        dt = Math.min(dt, 0.05);

        const [pointerX, pointerY] = global.get_pointer();
        const active = this._pointerInActivationZone(pointerX, pointerY);

        this._updateTargets(pointerX, pointerY, active);
        const moving = this._integrate(dt);
        this._paintItems();
        this._paintMaterial();

        const dockTransitioning = this._isDockTransitioning();

        if (active || moving || dockTransitioning) {
            this._runningFramesWithoutWork = 0;
        } else {
            this._runningFramesWithoutWork++;
            if (this._runningFramesWithoutWork > 2)
                timeline.pause();
        }
    }

    _getSourceDescriptors() {
        if (!this._dock?.dash)
            return [];

        const sources = this._dock.dash.getAppIcons().map(source => ({
            kind: 'app',
            source,
            item: source.get_parent(),
            app: source.app,
        }));

        const showAppsItem = this._dock.dash._showAppsIcon;
        if (showAppsItem?.visible && showAppsItem.toggleButton) {
            sources.push({
                kind: 'show-apps',
                source: showAppsItem.toggleButton,
                item: showAppsItem,
                app: null,
            });
        }

        return sources;
    }

    _syncItems(forceTextureRebuild = false) {
        const descriptors = this._getSourceDescriptors();
        const canReuse = !forceTextureRebuild &&
            descriptors.length === this._items.length &&
            descriptors.every((descriptor, i) =>
                descriptor.source === this._items[i].source &&
                descriptor.item === this._items[i].item);

        if (canReuse) {
            this._needsSync = false;
            this._needsTextureRebuild = false;
            return;
        }

        this._destroyItems();
        this._items = descriptors.map(descriptor => this._createItem(descriptor));
        this._needsSync = false;
        this._needsTextureRebuild = false;
        this._materialRect = null;
        this._setMacPresentation(true);
        this._updateDecorationStyle();
    }

    _createItem(descriptor) {
        const baseSize = this._getSourceIconSize(descriptor);
        const maxScale =
            1 + Math.max(0, this._settings.get_double('macos-magnification'));
        const quality =
            Math.max(1, this._settings.get_double('macos-icon-quality'));
        const textureSize = Math.min(MAX_TEXTURE_SIZE, Math.max(MIN_TEXTURE_SIZE,
            Math.ceil(baseSize * maxScale * quality)));

        let actor = null;
        if (descriptor.kind === 'app') {
            try {
                actor = descriptor.app?.create_icon_texture?.(textureSize) ?? null;
            } catch {
                actor = null;
            }

            if (!actor) {
                actor = new St.Icon({
                    gicon: descriptor.app?.get_icon?.() ?? null,
                    icon_size: textureSize,
                });
            }
        } else {
            const showApps = this._dock.dash._showAppsIcon;
            const iconName = showApps?._iconActor?.iconName ??
                `view-app-grid-${Main.sessionMode.currentMode}-symbolic`;
            actor = new St.Icon({
                icon_name: iconName,
                icon_size: textureSize,
            });
        }

        actor.reactive = false;
        actor.set_size(textureSize, textureSize);

        const [pivotX, pivotY] = this._pivotForPosition();
        actor.set_pivot_point(pivotX, pivotY);
        descriptor.source.set_pivot_point(pivotX, pivotY);
        this._layer.add_child(actor);

        let reflection = null;
        try {
            reflection = new Clutter.Clone({
                source: actor,
                reactive: false,
            });
            reflection.set_size(textureSize, textureSize);
            reflection.set_pivot_point(0.5, 1);
            this._layer.add_child(reflection);
            this._layer.set_child_below_sibling(reflection, actor);
        } catch {
            // Reflection is optional if a future Clutter version changes Clone.
            reflection = null;
        }

        const dot = new St.Widget({
            reactive: false,
            style: 'background-color: rgba(255, 255, 255, 0.90); ' +
                'border-radius: 99px;',
        });
        dot.set_size(DOT_SIZE, DOT_SIZE);
        dot.visible = descriptor.kind === 'app' && !!descriptor.source.running;
        this._layer.add_child(dot);

        const item = {
            ...descriptor,
            actor,
            reflection,
            dot,
            textureSize,
            baseSize,
            scale: 1,
            scaleVelocity: 0,
            targetScale: 1,
            offset: 0,
            offsetVelocity: 0,
            targetOffset: 0,
            baseCenterX: 0,
            baseCenterY: 0,
            baseRect: null,
            visualRect: null,
            originalSourceOpacity: descriptor.source.opacity,
            originalItemTranslationX: descriptor.item.translationX,
            originalItemTranslationY: descriptor.item.translationY,
            stateConnections: [],
        };

        for (const signal of ['notify::running', 'notify::focused']) {
            try {
                const id = descriptor.source.connect(signal, () => this._wake());
                item.stateConnections.push([descriptor.source, id]);
            } catch {
                // Not every non-app proxy exposes both state properties.
            }
        }

        return item;
    }

    _getSourceIconSize(descriptor) {
        let actor = null;
        if (descriptor.kind === 'app') {
            actor = descriptor.source.icon?.icon ?? descriptor.source.icon;
        } else {
            actor = this._dock.dash._showAppsIcon?.icon?.icon ??
                this._dock.dash._showAppsIcon?.icon;
        }

        const [width, height] = actor?.get_size?.() ?? [0, 0];
        const measured = Math.max(width || 0, height || 0);
        return Math.max(16, measured || this._dock.dash.iconSize || 48);
    }

    _destroyItems() {
        for (const item of this._items) {
            this._restoreSourceItem(item);

            for (const [actor, id] of item.stateConnections ?? []) {
                try {
                    actor.disconnect(id);
                } catch {
                    // Source may already be destroyed by a Dash redisplay.
                }
            }

            item.reflection?.destroy();
            item.actor?.destroy();
            item.dot?.destroy();
        }

        this._items = [];
    }

    _restoreSourceItem(item) {
        if (!item?.source || !item?.item)
            return;

        try {
            item.source.opacity = item.originalSourceOpacity ?? 255;
            item.source.set_scale(1, 1);
            item.source.set_pivot_point(0.5, 0.5);
            item.item.translationX = item.originalItemTranslationX ?? 0;
            item.item.translationY = item.originalItemTranslationY ?? 0;
        } catch {
            // Item may have been destroyed by a Dash redisplay.
        }
    }

    _setMacPresentation(enabled) {
        if (!this._dock?.dash)
            return;

        if (!enabled || this._dragging) {
            this._dock.dash._background.opacity = this._backgroundOpacity;
            for (const item of this._items) {
                try {
                    item.source.opacity = item.originalSourceOpacity ?? 255;
                } catch {
                    // Source may have disappeared during redisplay.
                }
            }
            this._restoreSeparator();
            return;
        }

        // Opacity 1 keeps native actors in Clutter's pick/input graph while
        // visually replacing their normal icon and indicator presentation.
        this._dock.dash._background.opacity = 0;
        for (const item of this._items) {
            try {
                item.source.opacity = 1;
            } catch {
                // Source may have disappeared during redisplay.
            }
        }

        this._hideSeparator();
    }

    _hideSeparator() {
        const separator = this._dock?.dash?._separator;
        if (!separator)
            return;

        if (separator !== this._lastSeparator) {
            this._restoreSeparator();
            this._lastSeparator = separator;
            this._separatorOpacity = separator.opacity;
        }

        separator.opacity = 0;
    }

    _restoreSeparator() {
        if (!this._lastSeparator)
            return;

        try {
            this._lastSeparator.opacity = this._separatorOpacity;
        } catch {
            // Separator may have been destroyed by redisplay.
        }

        this._lastSeparator = null;
        this._separatorOpacity = 255;
    }

    _updateBaseGeometry() {
        for (const item of this._items) {
            let [x, y] = item.item.get_transformed_position();
            const [width, height] = item.item.get_transformed_size();

            // Strip our previous primary-axis translation to recover the stable
            // Dash allocation used as the next frame's layout input.
            x -= item.item.translationX ?? 0;
            y -= item.item.translationY ?? 0;

            item.baseCenterX = x + width / 2;
            item.baseCenterY = y + height / 2;
            item.baseRect = {x, y, width, height};
        }
    }

    _orderedItems() {
        const horizontal = this._dock.isHorizontal;
        return [...this._items].sort((a, b) => horizontal
            ? a.baseCenterX - b.baseCenterX
            : a.baseCenterY - b.baseCenterY);
    }

    _isDockTransitioning() {
        const state = this._dock?.getDockState?.();
        // docking.js: SHOWING = 1, HIDING = 3.
        return state === 1 || state === 3;
    }

    _isDockFullyHidden() {
        const state = this._dock?.getDockState?.();
        const slide = Math.max(0, Math.min(1,
            this._dock?._slider?.slideX ?? 1));
        // docking.js: HIDDEN = 0. Requiring lifecycle state and final
        // slide position prevents reveal startup from looking hidden.
        return state === 0 && slide <= MATERIAL_HIDDEN_SLIDE;
    }

    _pointerInActivationZone(pointerX, pointerY) {
        if (!this._items.length || this._isDockFullyHidden())
            return false;

        const orderedItems = this._orderedItems();
        const [first] = orderedItems;
        const last = orderedItems.at(-1);
        const horizontal = this._dock.isHorizontal;
        const maxScale =
            1 + Math.max(0, this._settings.get_double('macos-magnification'));
        const radius =
            Math.max(32, this._settings.get_double('macos-magnification-radius'));
        const baseSize = Math.max(...orderedItems.map(item => item.baseSize));
        const inwardReach = baseSize * maxScale * 0.62 + 16;
        const outwardReach = baseSize * 0.65 + 16;

        if (horizontal) {
            if (pointerX < first.baseCenterX - radius ||
                pointerX > last.baseCenterX + radius)
                return false;

            const centerY = orderedItems.reduce((sum, item) =>
                sum + item.baseCenterY, 0) / orderedItems.length;

            if (this._dock.position === St.Side.BOTTOM) {
                return pointerY >= centerY - inwardReach &&
                    pointerY <= centerY + outwardReach;
            }

            return pointerY >= centerY - outwardReach &&
                pointerY <= centerY + inwardReach;
        }

        if (pointerY < first.baseCenterY - radius ||
            pointerY > last.baseCenterY + radius)
            return false;

        const centerX = orderedItems.reduce((sum, item) =>
            sum + item.baseCenterX, 0) / orderedItems.length;

        if (this._dock.position === St.Side.LEFT) {
            return pointerX >= centerX - outwardReach &&
                pointerX <= centerX + inwardReach;
        }

        return pointerX >= centerX - inwardReach &&
            pointerX <= centerX + outwardReach;
    }

    _updateTargets(pointerX, pointerY, active) {
        const horizontal = this._dock.isHorizontal;
        const pointerAxis = horizontal ? pointerX : pointerY;
        const maxScale =
            1 + Math.max(0, this._settings.get_double('macos-magnification'));
        const radius =
            Math.max(32, this._settings.get_double('macos-magnification-radius'));
        const orderedItems = this._orderedItems();
        const growth = [];

        for (const item of orderedItems) {
            const center = horizontal ? item.baseCenterX : item.baseCenterY;
            const distance = Math.abs(center - pointerAxis);
            let influence = 0;

            if (active && distance < radius) {
                const q = Math.max(0, Math.min(1, 1 - distance / radius));
                const s = Math.sin(q * Math.PI / 2);
                influence = s * s;
            }

            item.targetScale = 1 + (maxScale - 1) * influence;
            growth.push(item.baseSize * (item.targetScale - 1));
        }

        // Each icon receives half of all extra growth on its left minus half
        // of all extra growth on its right. There is no nearest-icon anchor.
        const totalGrowth = growth.reduce((sum, value) => sum + value, 0);
        let leftGrowth = 0;

        for (let i = 0; i < orderedItems.length; i++) {
            const rightGrowth = totalGrowth - leftGrowth - growth[i];
            orderedItems[i].targetOffset = active
                ? 0.5 * (leftGrowth - rightGrowth)
                : 0;
            leftGrowth += growth[i];
        }
    }

    _integrate(dt) {
        const response =
            Math.max(8, this._settings.get_double('macos-spring-response'));
        const damping =
            Math.max(0.5, this._settings.get_double('macos-spring-damping'));
        let moving = false;

        for (const item of this._items) {
            [item.scale, item.scaleVelocity] = springStep(
                item.scale, item.scaleVelocity, item.targetScale,
                response, damping, dt);
            [item.offset, item.offsetVelocity] = springStep(
                item.offset, item.offsetVelocity, item.targetOffset,
                response * 0.86, damping, dt);

            if (Math.abs(item.scale - item.targetScale) > SPRING_EPSILON ||
                Math.abs(item.offset - item.targetOffset) > OFFSET_EPSILON ||
                Math.abs(item.scaleVelocity) > VELOCITY_EPSILON ||
                Math.abs(item.offsetVelocity) > VELOCITY_EPSILON)
                moving = true;
        }

        return moving;
    }

    _paintItems() {
        const horizontal = this._dock.isHorizontal;
        const hidden = this._isDockFullyHidden();

        for (const item of this._items) {
            const {scale} = item;
            const baseTextureScale = item.baseSize / item.textureSize;
            const renderScale = baseTextureScale * scale;
            let centerX = item.baseCenterX;
            let centerY = item.baseCenterY;

            if (horizontal)
                centerX += item.offset;
            else
                centerY += item.offset;

            let actorX;
            let actorY;
            switch (this._dock.position) {
            case St.Side.TOP:
                actorX = centerX - item.textureSize / 2;
                actorY = item.baseCenterY - item.baseSize / 2;
                break;
            case St.Side.LEFT:
                actorX = item.baseCenterX - item.baseSize / 2;
                actorY = centerY - item.textureSize / 2;
                break;
            case St.Side.RIGHT:
                actorX = item.baseCenterX - item.textureSize + item.baseSize / 2;
                actorY = centerY - item.textureSize / 2;
                break;
            case St.Side.BOTTOM:
            default:
                actorX = centerX - item.textureSize / 2;
                actorY = item.baseCenterY - item.textureSize + item.baseSize / 2;
                break;
            }

            item.actor.set_position(Math.round(actorX), Math.round(actorY));
            item.actor.set_scale(renderScale, renderScale);
            item.actor.visible = !hidden;

            // The nearly transparent native actor remains the real interaction
            // proxy and follows the same primary-axis geometry.
            if (horizontal) {
                item.item.translationX = item.offset;
                item.item.translationY = item.originalItemTranslationY ?? 0;
            } else {
                item.item.translationX = item.originalItemTranslationX ?? 0;
                item.item.translationY = item.offset;
            }

            item.source.set_scale(scale, scale);

            const visualSize = item.baseSize * scale;
            let visualCenterX = centerX;
            let visualCenterY = centerY;

            switch (this._dock.position) {
            case St.Side.TOP:
                visualCenterY =
                    item.baseCenterY - item.baseSize / 2 + visualSize / 2;
                break;
            case St.Side.LEFT:
                visualCenterX =
                    item.baseCenterX - item.baseSize / 2 + visualSize / 2;
                break;
            case St.Side.RIGHT:
                visualCenterX =
                    item.baseCenterX + item.baseSize / 2 - visualSize / 2;
                break;
            case St.Side.BOTTOM:
            default:
                visualCenterY =
                    item.baseCenterY + item.baseSize / 2 - visualSize / 2;
                break;
            }

            item.visualRect = {
                x: visualCenterX - visualSize / 2,
                y: visualCenterY - visualSize / 2,
                width: visualSize,
                height: visualSize,
            };

            this._paintReflection(item, actorX, hidden);
            this._paintRunningDot(item, centerX, centerY, hidden);
        }
    }

    _paintReflection(item, actorX, hidden) {
        if (!item.reflection)
            return;

        const enabled = !hidden &&
            this._dock.position === St.Side.BOTTOM &&
            this._settings.get_boolean('macos-reflection');
        if (!enabled) {
            item.reflection.hide();
            return;
        }

        const opacity = Math.max(0, Math.min(0.4,
            this._settings.get_double('macos-reflection-opacity')));
        const depth = Math.max(0.05, Math.min(0.35,
            this._settings.get_double('macos-reflection-height')));
        const baseTextureScale = item.baseSize / item.textureSize;
        const renderScale = baseTextureScale * item.scale;
        const shelfY = item.baseCenterY + item.baseSize / 2 + REFLECTION_GAP;

        item.reflection.set_position(
            Math.round(actorX), Math.round(shelfY - item.textureSize));
        item.reflection.set_scale(renderScale, -renderScale * depth);
        item.reflection.opacity = Math.round(opacity * 255);
        item.reflection.show();
    }

    _paintRunningDot(item, centerX, centerY, hidden) {
        const shouldShow =
            !hidden && item.kind === 'app' && !!item.source.running;

        if (!shouldShow) {
            item.dot.hide();
            return;
        }

        item.dot.show();
        const gap = 4;
        let x = centerX - DOT_SIZE / 2;
        let y = centerY - DOT_SIZE / 2;

        switch (this._dock.position) {
        case St.Side.TOP:
            y = item.baseCenterY + item.baseSize / 2 + gap;
            break;
        case St.Side.LEFT:
            x = item.baseCenterX - item.baseSize / 2 - gap - DOT_SIZE;
            break;
        case St.Side.RIGHT:
            x = item.baseCenterX + item.baseSize / 2 + gap;
            break;
        case St.Side.BOTTOM:
        default:
            y = item.baseCenterY + item.baseSize / 2 + gap;
            break;
        }

        item.dot.set_position(Math.round(x), Math.round(y));
        item.dot.opacity = item.source.focused ? 255 : 205;
    }

    _pivotForPosition() {
        switch (this._dock.position) {
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

    _paintMaterial() {
        // Hide the detached glass only at the real final HIDDEN state.
        // SHOWING/HIDING continue painting while slide-x animates.
        if (!this._items.length || this._isDockFullyHidden()) {
            this._material.hide();
            this._blurCore?.hide();
            this._divider?.hide();
            this._materialRect = null;
            return;
        }

        const horizontal = this._dock.isHorizontal;
        const orderedItems = this._orderedItems();
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        for (const item of orderedItems) {
            if (!item.baseRect)
                continue;

            // macOS behavior: the material follows the translated tile slots
            // along the Dock's long axis, but keeps its normal cross-axis
            // thickness. Magnified icon artwork is allowed to bulge outside.
            const x = item.baseRect.x + (horizontal ? item.offset : 0);
            const y = item.baseRect.y + (horizontal ? 0 : item.offset);

            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + item.baseRect.width);
            maxY = Math.max(maxY, y + item.baseRect.height);
        }

        if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
            this._material.hide();
            this._blurCore?.hide();
            this._divider?.hide();
            this._materialRect = null;
            return;
        }

        const rect = {
            x: Math.round(minX - MATERIAL_MARGIN),
            y: Math.round(minY - MATERIAL_MARGIN),
            width: Math.max(1,
                Math.round(maxX - minX + MATERIAL_MARGIN * 2)),
            height: Math.max(1,
                Math.round(maxY - minY + MATERIAL_MARGIN * 2)),
        };

        this._material.show();
        this._paintDivider(orderedItems, rect);

        // Avoid pointless layout/blur invalidation on frames where integer
        // geometry did not change. Divider geometry still updates every frame.
        if (sameRect(this._materialRect, rect))
            return;

        this._material.set_position(rect.x, rect.y);
        this._material.set_size(rect.width, rect.height);
        this._layoutBlurCore(rect);
        this._materialRect = rect;
    }

    _layoutBlurCore(rect) {
        if (!this._blurCore)
            return;

        if (!this._settings.get_boolean('macos-glass-blur')) {
            this._blurCore.hide();
            return;
        }

        const radius = Math.max(8,
            this._settings.get_double('macos-corner-radius'));
        const blurRadius = Math.max(0,
            this._settings.get_int('macos-glass-radius'));
        const arcInset = Math.max(6, radius * 0.72, blurRadius * 0.5);
        const edgeInset = Math.max(4, Math.min(9, blurRadius * 0.25));
        const horizontal = this._dock.isHorizontal;
        const xInset = horizontal ? arcInset : edgeInset;
        const yInset = horizontal ? edgeInset : arcInset;
        const width = Math.max(1, rect.width - xInset * 2);
        const height = Math.max(1, rect.height - yInset * 2);

        this._blurCore.set_position(
            Math.round(rect.x + xInset), Math.round(rect.y + yInset));
        this._blurCore.set_size(Math.round(width), Math.round(height));
        this._blurCore.show();
    }

    _paintDivider(orderedItems, rect) {
        if (!this._divider ||
            !this._settings.get_boolean('macos-divider')) {
            this._divider?.hide();
            return;
        }

        const specialIndex = orderedItems.findIndex(item =>
            item.kind === 'app' && (item.app?.location || item.app?.isTrash));
        if (specialIndex <= 0) {
            this._divider.hide();
            return;
        }

        const special = orderedItems[specialIndex];
        let previous = null;
        for (let i = specialIndex - 1; i >= 0; i--) {
            if (orderedItems[i].kind === 'app') {
                previous = orderedItems[i];
                break;
            }
        }

        if (!previous?.baseRect || !special.baseRect) {
            this._divider.hide();
            return;
        }

        const horizontal = this._dock.isHorizontal;
        if (horizontal) {
            const previousEnd = previous.baseRect.x + previous.offset +
                previous.baseRect.width;
            const specialStart = special.baseRect.x + special.offset;
            const x = (previousEnd + specialStart) / 2;
            const height = Math.max(18,
                Math.min(rect.height * 0.62, special.baseSize * 0.78));
            this._divider.set_position(
                Math.round(x - DIVIDER_THICKNESS / 2),
                Math.round(rect.y + (rect.height - height) / 2));
            this._divider.set_size(DIVIDER_THICKNESS, Math.round(height));
        } else {
            const previousEnd = previous.baseRect.y + previous.offset +
                previous.baseRect.height;
            const specialStart = special.baseRect.y + special.offset;
            const y = (previousEnd + specialStart) / 2;
            const width = Math.max(18,
                Math.min(rect.width * 0.62, special.baseSize * 0.78));
            this._divider.set_position(
                Math.round(rect.x + (rect.width - width) / 2),
                Math.round(y - DIVIDER_THICKNESS / 2));
            this._divider.set_size(Math.round(width), DIVIDER_THICKNESS);
        }

        this._divider.show();
    }

    _isDarkMode() {
        if (!this._settings?.get_boolean('macos-adaptive-dark'))
            return true;

        try {
            return this._interfaceSettings?.get_string('color-scheme') ===
                'prefer-dark';
        } catch {
            return true;
        }
    }

    _updateMaterialStyle() {
        if (!this._material || !this._settings)
            return;

        const adaptive = this._settings.get_boolean('macos-adaptive-dark');
        const dark = this._isDarkMode();
        const fallbackOpacity = Math.max(0.05, Math.min(0.95,
            this._settings.get_double('macos-glass-opacity')));
        const lightOpacity = Math.max(0.1, Math.min(0.9,
            this._settings.get_double('macos-light-opacity')));
        const darkOpacity = Math.max(0.1, Math.min(0.95,
            this._settings.get_double('macos-dark-opacity')));
        let opacity = fallbackOpacity;
        if (adaptive)
            opacity = dark ? darkOpacity : lightOpacity;
        const radius = Math.max(8,
            this._settings.get_double('macos-corner-radius'));
        const dynamicBorder =
            this._settings.get_boolean('macos-dynamic-border');
        const borderOpacity = Math.max(0, Math.min(0.7,
            this._settings.get_double('macos-border-opacity')));
        const background = dark
            ? `rgba(26, 26, 30, ${opacity})`
            : `rgba(242, 242, 246, ${opacity})`;
        let border = 'rgba(255, 255, 255, 0.18)';

        if (dynamicBorder) {
            border = dark
                ? `rgba(255, 255, 255, ${borderOpacity})`
                : `rgba(0, 0, 0, ${borderOpacity})`;
        }

        // Intentionally no box-shadow: St's shadow paint box is rectangular
        // outside the rounded background and caused the visible square halo.
        this._material.set_style(
            `background-color: ${background}; ` +
            `border-radius: ${radius}px; ` +
            `border: 1px solid ${border};`);

        this._blurCore?.set_style(
            'background-color: rgba(255, 255, 255, 0.008); ' +
            `border-radius: ${Math.max(2, radius - 6)}px;`);
    }

    _updateDecorationStyle() {
        if (!this._settings)
            return;

        const dark = this._isDarkMode();
        const foreground = dark
            ? 'rgba(255, 255, 255, 0.90)'
            : 'rgba(0, 0, 0, 0.72)';
        const dividerOpacity = Math.max(0.05, Math.min(0.8,
            this._settings.get_double('macos-divider-opacity')));
        const dividerColor = dark
            ? `rgba(255, 255, 255, ${dividerOpacity})`
            : `rgba(0, 0, 0, ${dividerOpacity})`;

        for (const item of this._items) {
            item.dot?.set_style(
                `background-color: ${foreground}; border-radius: 99px;`);
        }
        this._divider?.set_style(`background-color: ${dividerColor};`);
    }

    _configureBlur() {
        if (!this._blurCore || !this._settings)
            return;

        this._blurCore.clear_effects?.();

        if (!this._settings.get_boolean('macos-glass-blur')) {
            this._blurCore.hide();
            return;
        }
        if (!Shell.BlurEffect || Shell.BlurMode?.BACKGROUND === undefined)
            return;

        try {
            const blur = new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                radius: this._settings.get_int('macos-glass-radius'),
                brightness: this._isDarkMode() ? 0.88 : 1.02,
            });
            this._blurCore.add_effect_with_name('macos-dock-blur', blur);
        } catch {
            // Blur is optional across the supported GNOME Shell range.
        }
    }

    _onDragBegin() {
        if (this._dragging)
            return;

        this._dragging = true;
        if (this._timeline?.is_playing())
            this._timeline.pause();

        this._neutralizeTransforms();
        this._setMacPresentation(false);
        this._layer.opacity = 0;
    }

    _onDragEnd() {
        if (!this._dragging)
            return;

        this._dragging = false;
        this._needsSync = true;
        this._materialRect = null;
        this._layer.opacity = 255;
        this._setMacPresentation(true);
        this._wake();
    }

    _neutralizeTransforms() {
        for (const item of this._items) {
            item.scale = 1;
            item.scaleVelocity = 0;
            item.targetScale = 1;
            item.offset = 0;
            item.offsetVelocity = 0;
            item.targetOffset = 0;

            try {
                item.source.set_scale(1, 1);
                item.item.translationX = item.originalItemTranslationX ?? 0;
                item.item.translationY = item.originalItemTranslationY ?? 0;
            } catch {
                // Source may disappear during drag/drop redisplay.
            }
        }
    }

    _maybeRevealFromEdge(pointerX, pointerY) {
        if (!this._isDockFullyHidden() || Main.overview.visibleTarget)
            return;

        if (!this._dock?._autohideIsEnabled &&
            !this._dock?._intellihideIsEnabled)
            return;

        const monitor = this._dock?._monitor;
        if (!monitor || monitor.inFullscreen)
            return;

        const left = monitor.x;
        const right = monitor.x + monitor.width - 1;
        const top = monitor.y;
        const bottom = monitor.y + monitor.height - 1;
        const tolerance = EDGE_REVEAL_TOLERANCE;
        const insideX = pointerX >= left && pointerX <= right;
        const insideY = pointerY >= top && pointerY <= bottom;
        let onEdge = false;

        switch (this._dock.position) {
        case St.Side.LEFT:
            onEdge = insideY && pointerX <= left + tolerance;
            break;
        case St.Side.RIGHT:
            onEdge = insideY && pointerX >= right - tolerance;
            break;
        case St.Side.TOP:
            onEdge = insideX && pointerY <= top + tolerance;
            break;
        case St.Side.BOTTOM:
        default:
            onEdge = insideX && pointerY >= bottom - tolerance;
            break;
        }

        if (!onEdge)
            return;

        this._materialRect = null;
        this._wake();
        this._dock._show?.();
    }

    _onCapturedEvent(event) {
        if (this._destroyed || this._dragging || !event)
            return Clutter.EVENT_PROPAGATE;

        let type;
        try {
            type = event.type();
        } catch {
            return Clutter.EVENT_PROPAGATE;
        }

        // Stage capture sees pointer motion before it reaches windows.
        if (type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            this._maybeRevealFromEdge(x, y);
            return Clutter.EVENT_PROPAGATE;
        }

        if (this._isDockFullyHidden() ||
            type !== Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const hit = this._hitTest(x, y);
        if (!hit || !hit.baseRect || pointInRect(hit.baseRect, x, y))
            return Clutter.EVENT_PROPAGATE;

        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY && hit.source.popupMenu) {
            hit.source.popupMenu();
            return Clutter.EVENT_STOP;
        }

        if (hit.kind === 'app' &&
            (button === Clutter.BUTTON_PRIMARY ||
             button === Clutter.BUTTON_MIDDLE)) {
            hit.source.activate(button);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _hitTest(x, y) {
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const item of this._items) {
            if (!item.visualRect || !pointInRect(item.visualRect, x, y))
                continue;

            const dx = x -
                (item.visualRect.x + item.visualRect.width / 2);
            const dy = y -
                (item.visualRect.y + item.visualRect.height / 2);
            const distance = dx * dx + dy * dy;

            if (distance < bestDistance) {
                best = item;
                bestDistance = distance;
            }
        }

        return best;
    }
}

/**
 * Stable implicit integration of a damped second-order spring:
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

function pointInRect(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width &&
        y >= rect.y && y <= rect.y + rect.height;
}

function sameRect(a, b) {
    return !!a && a.x === b.x && a.y === b.y &&
        a.width === b.width && a.height === b.height;
}
