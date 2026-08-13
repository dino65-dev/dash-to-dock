// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    Gio,
    GLib,
    Meta,
    Shell,
    St,
} from './dependencies/gi.js';

import {
    DND,
    Main,
    PopupMenu,
} from './dependencies/shell/ui.js';

const MACOS_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock.macos';
const MATERIAL_MARGIN = 5;
const TRAY_GAP = 5;
const TRAY_DIVIDER_GAP = 8;
const TRAY_PADDING = 8;
const LAUNCH_TIMEOUT_MS = 20_000;
const RECENT_RELOAD_DELAY_MS = 180;
const RECENT_CACHE_LIMIT = 80;

let activeService = null;

export function getMacDockInteractions() {
    return activeService;
}

export class MacDockInteractions {
    constructor(macEffects, dockManager, extension) {
        this._macEffects = macEffects;
        this._dockManager = dockManager;
        this._settings = extension.getSettings(MACOS_SCHEMA);
        this._rendererStates = new Map();
        this._recentEntries = [];
        this._recentReloadId = 0;
        this._recentMonitor = null;
        this._timeline = null;
        this._timelineFrameId = 0;
        this._dndActive = false;
        this._dndPointer = null;

        this._docksReadyId = dockManager.connect('docks-ready', () => this._syncAll());
        this._settingsChangedId = this._settings.connect('changed', () => {
            for (const state of this._rendererStates.values())
                state.baseMaterialRect = null;
            this._syncAll();
            this._ensureAnimation();
        });

        this._dragMonitor = {dragMotion: event => this._onDragMotion(event)};
        DND.addDragMonitor(this._dragMonitor);

        this._xdndBeginId = Main.xdndHandler?.connect?.('drag-begin', () => {
            this._dndActive = true;
        }) ?? 0;
        this._xdndEndId = Main.xdndHandler?.connect?.('drag-end', () => this._clearDnd()) ?? 0;

        this._setupRecentFiles();
        activeService = this;
        this._syncAll();
    }

    destroy() {
        if (activeService === this)
            activeService = null;

        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;

        if (this._docksReadyId)
            this._dockManager?.disconnect(this._docksReadyId);
        if (this._settingsChangedId)
            this._settings?.disconnect(this._settingsChangedId);
        if (this._xdndBeginId)
            Main.xdndHandler?.disconnect?.(this._xdndBeginId);
        if (this._xdndEndId)
            Main.xdndHandler?.disconnect?.(this._xdndEndId);

        if (this._recentReloadId)
            GLib.source_remove(this._recentReloadId);
        this._recentReloadId = 0;
        this._recentMonitor?.cancel?.();
        this._recentMonitor = null;

        this._stopTimeline();
        for (const renderer of [...this._rendererStates.keys()])
            this._detachRenderer(renderer);
        this._rendererStates.clear();

        this._recentEntries = [];
        this._settings = null;
        this._dockManager = null;
        this._macEffects = null;
    }

    isQuickMenuEnabled() {
        return !!this._settings?.get_boolean('macos-quick-menu');
    }

    getRecentFilesForApp(app) {
        if (!this.isQuickMenuEnabled())
            return [];

        const limit = Math.max(0, Math.min(10,
            this._settings.get_int('macos-recent-files-count')));
        if (!limit)
            return [];

        const appInfo = app?.get_app_info?.();
        if (!appInfo)
            return [];

        const appId = appInfo.get_id?.() ?? app?.get_id?.() ?? '';
        const executable = appInfo.get_executable?.() ?? '';
        const supportsUris = !!appInfo.supports_uris?.();
        const supportsFiles = !!appInfo.supports_files?.();
        if (!supportsUris && !supportsFiles)
            return [];

        const matches = [];
        const seen = new Set();
        for (const entry of this._recentEntries) {
            if (seen.has(entry.uri) || !this._appHandlesRecentType(
                appId, executable, entry.mime, supportsUris, supportsFiles))
                continue;

            seen.add(entry.uri);
            matches.push(entry);
            if (matches.length >= limit)
                break;
        }
        return matches;
    }

    openRecentFile(app, uri) {
        const appInfo = app?.get_app_info?.();
        if (!appInfo || !uri)
            return;

        try {
            const context = global.create_app_launch_context(
                global.get_current_time(), -1);
            appInfo.launch_uris([uri], context);
        } catch (error) {
            console.error(`[macOS Dock] Failed to open recent file: ${error}`);
        }
    }

    _syncAll() {
        if (!this._macEffects || !this._settings)
            return;

        const renderers = [...this._macEffects._renderers.values()];
        for (const renderer of [...this._rendererStates.keys()]) {
            if (!renderers.includes(renderer))
                this._detachRenderer(renderer);
        }

        for (const renderer of renderers) {
            if (!this._rendererStates.has(renderer))
                this._attachRenderer(renderer);
            this._syncRenderer(renderer);
        }
    }

    _attachRenderer(renderer) {
        const state = {
            sources: [],
            connections: [],
            windowConnections: [],
            itemState: new Map(),
            thumbnails: new Map(),
            minimizedWindows: [],
            halo: new St.Widget({reactive: false, visible: false}),
            baseMaterialRect: null,
            trayBounds: null,
            trayActive: false,
            specialIndex: -1,
            shiftAmount: 0,
            originalPaintItems: renderer._paintItems,
            originalPaintMaterial: renderer._paintMaterial,
        };

        state.halo.set_style(
            'background-color: rgba(255, 255, 255, 0.10); ' +
            'border: 2px solid rgba(255, 255, 255, 0.78); ' +
            'border-radius: 12px;');
        renderer._layer.add_child(state.halo);

        renderer._paintItems = (...args) => {
            state.originalPaintItems.apply(renderer, args);
            this._postPaintItems(renderer, state);
        };
        renderer._paintMaterial = (...args) => {
            if (state.baseMaterialRect)
                renderer._materialRect = state.baseMaterialRect;
            state.originalPaintMaterial.apply(renderer, args);
            state.baseMaterialRect = renderer._materialRect;
            this._postPaintMaterial(renderer, state);
        };

        this._rendererStates.set(renderer, state);
    }

    _detachRenderer(renderer) {
        const state = this._rendererStates.get(renderer);
        if (!state)
            return;

        this._disconnectState(state);
        for (const preview of state.thumbnails.values())
            preview.actor.destroy();
        state.thumbnails.clear();
        state.halo?.destroy();

        try {
            renderer._paintItems = state.originalPaintItems;
            renderer._paintMaterial = state.originalPaintMaterial;
            for (const item of renderer._items ?? []) {
                item.actor.opacity = 255;
                item.actor.translationY = 0;
                if (item.reflection)
                    item.reflection.translationY = 0;
            }
            renderer._materialRect = null;
            renderer._wake?.();
        } catch {
            // The renderer may already be tearing down.
        }

        this._rendererStates.delete(renderer);
    }

    _disconnectState(state) {
        for (const [actor, id] of [...state.connections, ...state.windowConnections]) {
            try {
                actor.disconnect(id);
            } catch {
                // Actor may already be destroyed.
            }
        }
        state.connections = [];
        state.windowConnections = [];
        state.itemState.clear();
    }

    _syncRenderer(renderer) {
        const state = this._rendererStates.get(renderer);
        if (!state)
            return;

        const sources = (renderer._items ?? []).map(item => item.source);
        const sameSources = sources.length === state.sources.length &&
            sources.every((source, index) => source === state.sources[index]);
        if (sameSources) {
            this._syncMinimizedWindows(renderer, state);
            return;
        }

        this._disconnectState(state);
        state.sources = sources;

        for (const item of renderer._items ?? []) {
            if (item.kind !== 'app' || !item.app || item.app.location || item.app.isTrash)
                continue;

            const itemState = {
                launchRequestedAt: 0,
                launchDeadline: 0,
            };
            state.itemState.set(item.source, itemState);

            this._connect(state.connections, item.app, 'notify::state', () => {
                this._ensureAnimation();
            });
            this._connect(state.connections, item.app, 'windows-changed', () => {
                this._syncMinimizedWindows(renderer, state);
                this._ensureAnimation();
            });
            this._connect(state.connections, item.source, 'notify::urgent', () => {
                this._ensureAnimation();
            });
            this._connect(state.connections, item.source, 'notify::focused', () => {
                this._ensureAnimation();
            });
            this._connect(state.connections, item.source, 'button-press-event', (_actor, event) => {
                if (!this._settings.get_boolean('macos-launch-bounce'))
                    return Clutter.EVENT_PROPAGATE;

                const button = event.get_button?.() ?? 0;
                if ((button === 1 || button === 2) &&
                    item.app.state === Shell.AppState.STOPPED) {
                    const now = this._nowMs();
                    itemState.launchRequestedAt = now;
                    itemState.launchDeadline = now + LAUNCH_TIMEOUT_MS;
                    this._ensureAnimation();
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._connect(state.connections, item.source, 'menu-state-changed',
                (_source, open) => {
                    if (open && this.isQuickMenuEnabled())
                        this._queueQuickMenu(item.source);
                });
        }

        this._syncMinimizedWindows(renderer, state);
        this._ensureAnimation();
    }

    _connect(list, actor, signal, callback) {
        try {
            const id = actor.connect(signal, callback);
            list.push([actor, id]);
        } catch {
            // Optional signal/property across supported Shell versions.
        }
    }

    _syncMinimizedWindows(renderer, state) {
        for (const [actor, id] of state.windowConnections) {
            try {
                actor.disconnect(id);
            } catch {
                // Window may already be unmanaged.
            }
        }
        state.windowConnections = [];

        const windows = [];
        const seen = new Set();
        for (const item of renderer._items ?? []) {
            if (item.kind !== 'app' || !item.app || item.app.location || item.app.isTrash)
                continue;

            for (const window of item.app.get_windows?.() ?? []) {
                if (seen.has(window))
                    continue;
                seen.add(window);
                this._connect(state.windowConnections, window, 'notify::minimized', () => {
                    this._syncMinimizedWindows(renderer, state);
                    renderer._materialRect = null;
                    renderer._wake?.();
                });
                this._connect(state.windowConnections, window, 'unmanaged', () => {
                    this._syncMinimizedWindows(renderer, state);
                    renderer._materialRect = null;
                    renderer._wake?.();
                });

                if (window.minimized && !window.skip_taskbar)
                    windows.push(window);
            }
        }

        windows.sort((a, b) =>
            (a.get_stable_sequence?.() ?? 0) - (b.get_stable_sequence?.() ?? 0));
        state.minimizedWindows = windows;
        this._syncThumbnailActors(renderer, state);
    }

    _syncThumbnailActors(renderer, state) {
        const enabled = this._settings.get_boolean('macos-minimized-thumbnails');
        const desired = enabled ? new Set(state.minimizedWindows) : new Set();

        for (const [window, preview] of [...state.thumbnails]) {
            if (!desired.has(window)) {
                preview.actor.destroy();
                state.thumbnails.delete(window);
            }
        }

        for (const window of desired) {
            if (state.thumbnails.has(window))
                continue;
            const preview = this._createThumbnail(renderer, window);
            if (preview)
                state.thumbnails.set(window, preview);
        }

        state.baseMaterialRect = null;
        renderer._materialRect = null;
        renderer._wake?.();
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
        actor.connect('clicked', () => {
            try {
                if (window.minimized)
                    window.unminimize();
                Main.activateWindow(window);
            } catch {
                // Window may have closed between click and activation.
            }
        });
        actor.connect('notify::hover', () => {
            actor.ease({
                scale_x: actor.hover ? 1.08 : 1,
                scale_y: actor.hover ? 1.08 : 1,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });

        renderer._layer.add_child(actor);
        return {actor, clone, window};
    }

    _postPaintItems(renderer, state) {
        if (!this._sourcesMatch(renderer, state)) {
            this._syncRenderer(renderer);
            return;
        }

        state.trayActive = this._settings.get_boolean('macos-minimized-thumbnails') &&
            state.thumbnails.size > 0;
        state.trayBounds = null;
        state.specialIndex = -1;
        state.shiftAmount = 0;

        if (!state.trayActive) {
            for (const preview of state.thumbnails.values())
                preview.actor.hide();
            return;
        }

        const items = renderer._orderedItems();
        const specialIndex = items.findIndex(item =>
            item.kind === 'app' && (item.app?.location || item.app?.isTrash));
        state.specialIndex = specialIndex;

        let previous = null;
        const previousSearchEnd = specialIndex >= 0 ? specialIndex : items.length;
        for (let i = previousSearchEnd - 1; i >= 0; i--) {
            const item = items[i];
            if (item.kind === 'app' && !item.app?.location && !item.app?.isTrash) {
                previous = item;
                break;
            }
        }
        if (!previous?.baseRect)
            return;

        const previews = state.minimizedWindows
            .map(window => state.thumbnails.get(window))
            .filter(Boolean);
        const totalPreviewExtent = previews.reduce((sum, preview) => {
            const [width, height] = preview.actor.get_size();
            return sum + (renderer._dock.isHorizontal ? width : height);
        }, 0) + Math.max(0, previews.length - 1) * TRAY_GAP;
        state.shiftAmount = totalPreviewExtent + TRAY_PADDING * 2 + TRAY_DIVIDER_GAP;

        if (specialIndex >= 0) {
            for (let i = specialIndex; i < items.length; i++)
                this._shiftPaintedItem(renderer, items[i], state.shiftAmount);
        }

        this._positionThumbnails(renderer, state, previous, previews);
    }

    _sourcesMatch(renderer, state) {
        const items = renderer._items ?? [];
        return items.length === state.sources.length &&
            items.every((item, index) => item.source === state.sources[index]);
    }

    _shiftPaintedItem(renderer, item, amount) {
        if (!amount)
            return;

        if (renderer._dock.isHorizontal) {
            item.actor.x += amount;
            if (item.reflection)
                item.reflection.x += amount;
            if (item.dot)
                item.dot.x += amount;
            item.item.translationX += amount;
            if (item.visualRect)
                item.visualRect.x += amount;
        } else {
            item.actor.y += amount;
            if (item.reflection)
                item.reflection.y += amount;
            if (item.dot)
                item.dot.y += amount;
            item.item.translationY += amount;
            if (item.visualRect)
                item.visualRect.y += amount;
        }
    }

    _positionThumbnails(renderer, state, previous, previews) {
        const horizontal = renderer._dock.isHorizontal;
        const previousEnd = horizontal
            ? previous.baseRect.x + previous.offset + previous.baseRect.width
            : previous.baseRect.y + previous.offset + previous.baseRect.height;
        let cursor = previousEnd + TRAY_DIVIDER_GAP + TRAY_PADDING;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        for (const preview of previews) {
            const [width, height] = preview.actor.get_size();
            let x;
            let y;
            if (horizontal) {
                x = cursor;
                y = previous.baseCenterY - height / 2;
                cursor += width + TRAY_GAP;
            } else {
                x = previous.baseCenterX - width / 2;
                y = cursor;
                cursor += height + TRAY_GAP;
            }

            preview.actor.set_position(Math.round(x), Math.round(y));
            preview.actor.show();
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + width);
            maxY = Math.max(maxY, y + height);
        }

        if (Number.isFinite(minX))
            state.trayBounds = {minX, minY, maxX, maxY};
    }

    _postPaintMaterial(renderer, state) {
        if (!state.trayActive || !state.trayBounds || renderer._isDockFullyHidden())
            return;

        const horizontal = renderer._dock.isHorizontal;
        const items = renderer._orderedItems();
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.baseRect)
                continue;
            const shifted = state.specialIndex >= 0 && i >= state.specialIndex
                ? state.shiftAmount : 0;
            const x = item.baseRect.x + (horizontal ? item.offset + shifted : 0);
            const y = item.baseRect.y + (horizontal ? 0 : item.offset + shifted);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + item.baseRect.width);
            maxY = Math.max(maxY, y + item.baseRect.height);
        }

        minX = Math.min(minX, state.trayBounds.minX);
        minY = Math.min(minY, state.trayBounds.minY);
        maxX = Math.max(maxX, state.trayBounds.maxX);
        maxY = Math.max(maxY, state.trayBounds.maxY);

        const rect = {
            x: Math.round(minX - MATERIAL_MARGIN),
            y: Math.round(minY - MATERIAL_MARGIN),
            width: Math.max(1, Math.round(maxX - minX + MATERIAL_MARGIN * 2)),
            height: Math.max(1, Math.round(maxY - minY + MATERIAL_MARGIN * 2)),
        };
        renderer._material.set_position(rect.x, rect.y);
        renderer._material.set_size(rect.width, rect.height);
        renderer._layoutBlurCore(rect);
        renderer._materialRect = rect;

        this._positionTrayDivider(renderer, state, rect);
    }

    _positionTrayDivider(renderer, state, rect) {
        if (!renderer._divider || !this._settings.get_boolean('macos-divider'))
            return;

        const items = renderer._orderedItems();
        const searchEnd = state.specialIndex >= 0 ? state.specialIndex : items.length;
        let previous = null;
        for (let i = searchEnd - 1; i >= 0; i--) {
            const item = items[i];
            if (item.kind === 'app' && !item.app?.location && !item.app?.isTrash) {
                previous = item;
                break;
            }
        }
        if (!previous?.baseRect)
            return;

        if (renderer._dock.isHorizontal) {
            const previousEnd = previous.baseRect.x + previous.offset + previous.baseRect.width;
            const x = previousEnd + TRAY_DIVIDER_GAP / 2;
            const height = Math.max(18, Math.min(rect.height * 0.62, previous.baseSize * 0.78));
            renderer._divider.set_position(
                Math.round(x), Math.round(rect.y + (rect.height - height) / 2));
            renderer._divider.set_size(1, Math.round(height));
        } else {
            const previousEnd = previous.baseRect.y + previous.offset + previous.baseRect.height;
            const y = previousEnd + TRAY_DIVIDER_GAP / 2;
            const width = Math.max(18, Math.min(rect.width * 0.62, previous.baseSize * 0.78));
            renderer._divider.set_position(
                Math.round(rect.x + (rect.width - width) / 2), Math.round(y));
            renderer._divider.set_size(Math.round(width), 1);
        }
        renderer._divider.show();
    }

    _ensureAnimation() {
        if (!this._hasAnimatedItems()) {
            this._resetBounceTransforms();
            this._timeline?.pause();
            return;
        }

        if (!this._timeline) {
            try {
                this._timeline = Clutter.Timeline.new_for_actor(global.stage, 1000);
            } catch {
                this._timeline = new Clutter.Timeline({actor: global.stage, duration: 1000});
            }
            this._timeline.set_repeat_count(-1);
            this._timelineFrameId = this._timeline.connect('new-frame', () => {
                this._animateBounces();
            });
        }
        if (!this._timeline.is_playing())
            this._timeline.start();
    }

    _stopTimeline() {
        if (!this._timeline)
            return;
        if (this._timelineFrameId)
            this._timeline.disconnect(this._timelineFrameId);
        this._timeline.stop();
        this._timeline = null;
        this._timelineFrameId = 0;
        this._resetBounceTransforms();
    }

    _hasAnimatedItems() {
        const now = this._nowMs();
        for (const [renderer, state] of this._rendererStates) {
            for (const item of renderer._items ?? []) {
                const sourceState = state.itemState.get(item.source);
                if (this._bounceMode(item, sourceState, now))
                    return true;
            }
        }
        return false;
    }

    _animateBounces() {
        const now = this._nowMs();
        let active = false;

        for (const [renderer, state] of this._rendererStates) {
            for (const item of renderer._items ?? []) {
                const sourceState = state.itemState.get(item.source);
                const mode = this._bounceMode(item, sourceState, now);
                const translation = mode ? this._bounceTranslation(renderer, item, mode, now) : 0;
                item.actor.translationY = translation;
                if (item.reflection)
                    item.reflection.translationY = translation;
                if (mode)
                    active = true;
            }
        }

        if (!active) {
            this._resetBounceTransforms();
            this._timeline?.pause();
        }
    }

    _resetBounceTransforms() {
        for (const renderer of this._rendererStates.keys()) {
            for (const item of renderer._items ?? []) {
                if (item.actor)
                    item.actor.translationY = 0;
                if (item.reflection)
                    item.reflection.translationY = 0;
            }
        }
    }

    _bounceMode(item, sourceState, now) {
        if (item.kind !== 'app' || !item.app || item.app.location || item.app.isTrash)
            return null;

        if (sourceState && this._hasMainWindow(item.app)) {
            sourceState.launchRequestedAt = 0;
            sourceState.launchDeadline = 0;
        }

        const launchEnabled = this._settings.get_boolean('macos-launch-bounce');
        const launchPending = sourceState?.launchDeadline > now && !this._hasMainWindow(item.app);
        const starting = item.app.state === Shell.AppState.STARTING && !this._hasMainWindow(item.app);
        if (launchEnabled && (launchPending || starting))
            return 'launch';

        const alertEnabled = this._settings.get_boolean('macos-alert-bounce');
        if (alertEnabled && item.source.urgent && !item.source.focused)
            return 'alert';

        return null;
    }

    _hasMainWindow(app) {
        const acceptedTypes = new Set([
            Meta.WindowType.NORMAL,
            Meta.WindowType.DIALOG,
            Meta.WindowType.MODAL_DIALOG,
        ]);
        return (app.get_windows?.() ?? []).some(window =>
            !window.skip_taskbar && acceptedTypes.has(window.get_window_type?.()));
    }

    _bounceTranslation(renderer, item, mode, now) {
        const launch = mode === 'launch';
        const period = launch ? 680 : 1750;
        const activeFraction = launch ? 0.74 : 0.38;
        const phase = (now % period) / period;
        if (phase >= activeFraction)
            return 0;

        const local = phase / activeFraction;
        const arc = Math.pow(Math.sin(Math.PI * local), launch ? 0.92 : 1.15);
        const amplitude = launch
            ? Math.max(12, item.baseSize * 0.38)
            : Math.max(7, item.baseSize * 0.20);
        const direction = renderer._dock.position === St.Side.TOP ? 1 : -1;
        return Math.round(direction * amplitude * arc);
    }

    _onDragMotion(event) {
        const isExternal = event.source === Main.xdndHandler;
        if (!isExternal) {
            if (this._dndActive)
                this._clearDnd();
            return DND.DragMotionResult.CONTINUE;
        }

        this._dndActive = true;
        this._dndPointer = {x: event.x, y: event.y};
        this._applyDndHighlights();
        return DND.DragMotionResult.CONTINUE;
    }

    _applyDndHighlights() {
        if (!this._settings.get_boolean('macos-dnd-highlights')) {
            this._clearDndVisuals();
            return;
        }

        for (const [renderer, state] of this._rendererStates) {
            let target = null;
            for (const item of renderer._items ?? []) {
                if (item.kind !== 'app' || !item.app || item.app.location || item.app.isTrash)
                    continue;

                const compatible = this._appAcceptsFiles(item.app);
                const hovered = this._dndPointer && item.visualRect &&
                    this._pointInside(this._dndPointer, item.visualRect);
                item.actor.opacity = compatible ? 205 : 95;
                if (hovered && compatible) {
                    item.actor.opacity = 255;
                    target = item;
                } else if (hovered) {
                    item.actor.opacity = 70;
                }
            }
            this._paintDndHalo(renderer, state, target);
        }
    }

    _paintDndHalo(renderer, state, item) {
        if (!item?.visualRect) {
            state.halo.hide();
            return;
        }

        const rect = item.visualRect;
        const padding = Math.max(4, Math.min(8, rect.width * 0.10));
        state.halo.set_position(
            Math.round(rect.x - padding), Math.round(rect.y - padding));
        state.halo.set_size(
            Math.round(rect.width + padding * 2), Math.round(rect.height + padding * 2));
        state.halo.show();
        try {
            renderer._layer.set_child_below_sibling(state.halo, item.actor);
        } catch {
            // Layer ordering is cosmetic; keep the highlight if reordering fails.
        }
    }

    _clearDnd() {
        this._dndActive = false;
        this._dndPointer = null;
        this._clearDndVisuals();
    }

    _clearDndVisuals() {
        for (const [renderer, state] of this._rendererStates) {
            for (const item of renderer._items ?? [])
                item.actor.opacity = 255;
            state.halo.hide();
        }
    }

    _appAcceptsFiles(app) {
        const info = app?.get_app_info?.();
        return !!(info?.supports_files?.() || info?.supports_uris?.());
    }

    _pointInside(point, rect) {
        return point.x >= rect.x && point.x <= rect.x + rect.width &&
            point.y >= rect.y && point.y <= rect.y + rect.height;
    }

    _queueQuickMenu(source) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._augmentQuickMenu(source);
            return GLib.SOURCE_REMOVE;
        });
    }

    _augmentQuickMenu(source) {
        if (!this.isQuickMenuEnabled() || !source?._menu?.isOpen)
            return;

        const menu = source._menu;
        const existing = menu._getMenuItems?.() ?? [];
        if (existing.some(item => item._macQuickMenu))
            return;

        const app = source.app;
        const windows = source.getInterestingWindows?.() ?? app?.get_windows?.() ?? [];
        const insertion = Math.max(1,
            existing.indexOf(menu._quitMenuItem) >= 0
                ? existing.indexOf(menu._quitMenuItem)
                : existing.length);
        let index = insertion;

        if (windows.length) {
            const controls = new PopupMenu.PopupSubMenuMenuItem('Window Controls', false);
            controls._macQuickMenu = true;
            for (const window of windows.slice(0, 5)) {
                const title = this._shortTitle(window.get_title?.() || app.get_name?.() || 'Window');
                const focus = new PopupMenu.PopupMenuItem(`Show — ${title}`);
                focus.connect('activate', () => Main.activateWindow(window));
                controls.menu.addMenuItem(focus);

                const minimizeLabel = window.minimized ? `Restore — ${title}` : `Minimize — ${title}`;
                const minimize = new PopupMenu.PopupMenuItem(minimizeLabel);
                minimize.connect('activate', () => {
                    if (window.minimized) {
                        window.unminimize();
                        Main.activateWindow(window);
                    } else {
                        window.minimize();
                    }
                });
                controls.menu.addMenuItem(minimize);

                const maximized = !!(window.get_maximized?.() & Meta.MaximizeFlags.BOTH);
                const maximize = new PopupMenu.PopupMenuItem(
                    `${maximized ? 'Unmaximize' : 'Maximize'} — ${title}`);
                maximize.connect('activate', () => {
                    if (maximized)
                        window.unmaximize(Meta.MaximizeFlags.BOTH);
                    else
                        window.maximize(Meta.MaximizeFlags.BOTH);
                });
                controls.menu.addMenuItem(maximize);

                const close = new PopupMenu.PopupMenuItem(`Close — ${title}`);
                close.connect('activate', () => window.delete(global.get_current_time()));
                controls.menu.addMenuItem(close);
                controls.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }
            menu.addMenuItem(controls, index++);
        }

        const recent = this.getRecentFilesForApp(app);
        if (recent.length) {
            const recentMenu = new PopupMenu.PopupSubMenuMenuItem('Recent Files', false);
            recentMenu._macQuickMenu = true;
            for (const entry of recent) {
                const item = new PopupMenu.PopupMenuItem(entry.label);
                item.connect('activate', () => this.openRecentFile(app, entry.uri));
                recentMenu.menu.addMenuItem(item);
            }
            menu.addMenuItem(recentMenu, index);
        }
    }

    _shortTitle(title) {
        const text = `${title}`.trim();
        return text.length > 34 ? `${text.slice(0, 31)}…` : text;
    }

    _setupRecentFiles() {
        const file = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'recently-used.xbel',
        ]));
        this._recentFile = file;
        this._reloadRecentFiles();

        try {
            this._recentMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._recentMonitor.connect('changed', () => this._queueRecentReload());
        } catch {
            this._recentMonitor = null;
        }
    }

    _queueRecentReload() {
        if (this._recentReloadId)
            GLib.source_remove(this._recentReloadId);
        this._recentReloadId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, RECENT_RELOAD_DELAY_MS, () => {
                this._recentReloadId = 0;
                this._reloadRecentFiles();
                return GLib.SOURCE_REMOVE;
            });
    }

    _reloadRecentFiles() {
        this._recentFile?.load_contents_async(null, (file, result) => {
            try {
                const [ok, bytes] = file.load_contents_finish(result);
                if (!ok)
                    return;
                const xml = new TextDecoder('utf-8').decode(bytes);
                this._recentEntries = this._parseRecentXbel(xml);
            } catch {
                this._recentEntries = [];
            }
        });
    }

    _parseRecentXbel(xml) {
        const entries = [];
        const bookmarkPattern = /<bookmark\b([^>]*)>([\s\S]*?)<\/bookmark>/g;
        let match;
        while ((match = bookmarkPattern.exec(xml)) && entries.length < RECENT_CACHE_LIMIT) {
            const attrs = match[1];
            const body = match[2];
            const href = /\bhref="([^"]+)"/.exec(attrs)?.[1];
            if (!href)
                continue;
            const modified = /\bmodified="([^"]+)"/.exec(attrs)?.[1] ?? '';
            const mime = /<mime:mime-type\b[^>]*type="([^"]+)"/.exec(body)?.[1] ?? '';
            const uri = this._xmlUnescape(href);
            let label = uri;
            try {
                label = Gio.File.new_for_uri(uri).get_basename() || uri;
            } catch {
                // Keep URI as the fallback label.
            }
            entries.push({uri, mime: this._xmlUnescape(mime), modified, label});
        }

        entries.sort((a, b) => b.modified.localeCompare(a.modified));
        return entries.slice(0, RECENT_CACHE_LIMIT);
    }

    _xmlUnescape(text) {
        return `${text}`
            .replaceAll('&amp;', '&')
            .replaceAll('&quot;', '"')
            .replaceAll('&apos;', "'")
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>');
    }

    _appHandlesRecentType(appId, executable, mime, supportsUris, supportsFiles) {
        if (!mime)
            return supportsUris || supportsFiles;

        try {
            const handlers = Gio.AppInfo.get_all_for_type(mime) ?? [];
            return handlers.some(info =>
                (appId && info.get_id?.() === appId) ||
                (executable && info.get_executable?.() === executable));
        } catch {
            return supportsUris || supportsFiles;
        }
    }

    _nowMs() {
        return GLib.get_monotonic_time() / 1000;
    }
}
