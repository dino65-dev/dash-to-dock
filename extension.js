// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {St} from './dependencies/gi.js';

import {DockManager} from './docking.js';
import {MacDockEffects} from './macDockEffects.js';
import {MacDockInteractions} from './macDockInteractions.js';
import {MacThumbnailFisheye} from './macThumbnailFisheye.js';
import {MacInputIntegrity} from './macInputIntegrity.js';
import {MacDirectInputStability} from './macDirectInputStability.js';
import {Extension} from './dependencies/shell/extensions/extension.js';

const MACOS_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock.macos';
const BMS_BACKGROUND_NAME = 'bms-dash-backgroundgroup';
const BLUR_EFFECT_NAME = 'macos-dock-blur';

let RoundedBlur = null;
try {
    RoundedBlur = await import('gi://Blur');
} catch {
    // gnome-rounded-blur is optional. Without it we deliberately use the
    // clean translucent material instead of GNOME's rectangular dynamic blur.
}

const HAS_ROUNDED_BLUR = Boolean(
    RoundedBlur?.BlurEffect?.list_properties?.()
        .some(property => property.name === 'corner-radius')
);

// We export this so it can be accessed by other extensions
export let dockManager;

class MacExternalCompat {
    constructor(manager, extension) {
        this._dockManager = manager;
        this._settings = extension.getSettings(MACOS_SCHEMA);
        this._dockStates = new Map();

        this._docksReadyId = manager.connect(
            'docks-ready', () => this._sync());
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

        for (const dock of [...this._dockStates.keys()])
            this._detachDock(dock);

        this._settings = null;
        this._dockManager = null;
    }

    _sync() {
        if (!this._dockManager)
            return;

        const enabled = this._settings.get_boolean('macos-style');
        const docks = this._dockManager._allDocks ?? [];

        for (const dock of [...this._dockStates.keys()]) {
            if (!enabled || !docks.includes(dock))
                this._detachDock(dock);
        }

        if (!enabled)
            return;

        for (const dock of docks) {
            if (!this._dockStates.has(dock))
                this._attachDock(dock);
        }
    }

    _attachDock(dock) {
        const parent = dock?.dash?.get_parent?.();
        if (!parent)
            return;

        const state = {
            parent,
            backgrounds: new Map(),
            childAddedId: 0,
        };

        state.childAddedId = parent.connect(
            'child-added', (_parent, actor) => this._suppress(state, actor));
        this._dockStates.set(dock, state);

        for (const actor of parent.get_children?.() ?? [])
            this._suppress(state, actor);
    }

    _detachDock(dock) {
        const state = this._dockStates.get(dock);
        if (!state)
            return;

        if (state.childAddedId) {
            try {
                state.parent.disconnect(state.childAddedId);
            } catch {
                // The dock parent may already be destroyed during shutdown.
            }
        }

        for (const [actor, original] of state.backgrounds) {
            try {
                actor.opacity = original.opacity;
                actor.visible = original.visible;
            } catch {
                // Blur My Shell may already have recreated its background.
            }
        }

        state.backgrounds.clear();
        this._dockStates.delete(dock);
    }

    _suppress(state, actor) {
        if (actor?.get_name?.() !== BMS_BACKGROUND_NAME ||
            state.backgrounds.has(actor))
            return;

        state.backgrounds.set(actor, {
            opacity: actor.opacity,
            visible: actor.visible,
        });

        try {
            actor.opacity = 0;
        } catch {
            state.backgrounds.delete(actor);
        }
    }
}

/**
 * Uses true rounded dynamic blur only when gnome-rounded-blur is available.
 *
 * GNOME 46's Shell.BlurEffect paints BACKGROUND blur as a rectangle and has no
 * corner-radius property. Trying to cover that with CSS or another effect leaves
 * a faint rectangular paint region. The clean fallback therefore removes that
 * effect completely and relies on the already-rounded translucent material.
 */
class MacRoundedBlurCompat {
    constructor(macEffects, manager) {
        this._macEffects = macEffects;
        this._dockManager = manager;
        this._settings = macEffects._settings;
        this._states = new Map();
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);

        this._docksReadyId = manager.connect('docks-ready', () => this._sync());
        this._settingsChangedId = this._settings.connect('changed', () => this._sync());
        this._scaleChangedId = this._themeContext.connect(
            'notify::scale-factor', () => this._sync());
        this._sync();
    }

    destroy() {
        if (!this._macEffects)
            return;

        if (this._docksReadyId)
            this._dockManager?.disconnect(this._docksReadyId);
        if (this._settingsChangedId)
            this._settings?.disconnect(this._settingsChangedId);
        if (this._scaleChangedId)
            this._themeContext?.disconnect(this._scaleChangedId);

        for (const renderer of [...this._states.keys()])
            this._detach(renderer);

        this._states.clear();
        this._themeContext = null;
        this._settings = null;
        this._dockManager = null;
        this._macEffects = null;
    }

    _sync() {
        if (!this._macEffects || !this._settings)
            return;

        const renderers = [...this._macEffects._renderers.values()];

        for (const renderer of [...this._states.keys()]) {
            if (!renderers.includes(renderer))
                this._detach(renderer);
        }

        for (const renderer of renderers) {
            if (!this._states.has(renderer))
                this._attach(renderer);
            this._apply(renderer);
        }
    }

    _attach(renderer) {
        const state = {
            originalLayoutBlurCore: renderer._layoutBlurCore,
            interfaceSettings: renderer._interfaceSettings,
            colorSchemeId: 0,
        };

        renderer._layoutBlurCore = rect => {
            const core = renderer._blurCore;
            const enabled = HAS_ROUNDED_BLUR &&
                this._settings?.get_boolean('macos-glass-blur');

            if (!core || !enabled) {
                core?.hide();
                return;
            }

            // The patched native effect clips its own background capture to
            // corner-radius, so it can safely use the exact material bounds.
            core.set_position(rect.x, rect.y);
            core.set_size(rect.width, rect.height);
            core.show();
        };

        if (state.interfaceSettings) {
            state.colorSchemeId = state.interfaceSettings.connect(
                'changed::color-scheme', () => this._apply(renderer));
        }

        this._states.set(renderer, state);
        renderer._materialRect = null;
        renderer._wake?.();
    }

    _detach(renderer) {
        const state = this._states.get(renderer);
        if (!state)
            return;

        if (state.colorSchemeId && state.interfaceSettings) {
            try {
                state.interfaceSettings.disconnect(state.colorSchemeId);
            } catch {
                // The renderer may already be destroyed.
            }
        }

        try {
            renderer._blurCore?.clear_effects?.();
            renderer._blurCore?.hide();
            renderer._layoutBlurCore = state.originalLayoutBlurCore;
        } catch {
            // Renderer actors may already be gone during a dock rebuild.
        }

        this._states.delete(renderer);
    }

    _apply(renderer) {
        const core = renderer?._blurCore;
        if (!core || !this._settings)
            return;

        // Remove both the stock rectangular Shell.BlurEffect created by the
        // renderer and any previous rounded effect before deciding what to use.
        core.clear_effects?.();
        core.set_style('background-color: transparent;');

        if (!HAS_ROUNDED_BLUR ||
            !this._settings.get_boolean('macos-glass-blur')) {
            core.hide();
            renderer._materialRect = null;
            renderer._wake?.();
            return;
        }

        try {
            const scale = Math.max(1, this._themeContext?.scale_factor ?? 1);
            const blur = new RoundedBlur.BlurEffect({
                mode: RoundedBlur.BlurMode.BACKGROUND,
                radius: Math.max(0,
                    this._settings.get_int('macos-glass-radius') * scale),
                brightness: renderer._isDarkMode?.() ? 0.88 : 1.02,
            });
            blur.corner_radius = Math.max(0,
                this._settings.get_double('macos-corner-radius') * scale);
            core.add_effect_with_name(BLUR_EFFECT_NAME, blur);
        } catch {
            // A broken/mismatched helper must never bring the square back.
            core.clear_effects?.();
            core.hide();
        }

        renderer._materialRect = null;
        renderer._wake?.();
    }
}

export default class DashToDockExtension extends Extension.Extension {
    enable() {
        // TODO: Remove this when upstream will disable extensions on shutdown
        // See: https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4214
        this._shutdownID = global.connect('shutdown', () => this.disable());
        dockManager = new DockManager(this);
        this._macExternalCompat = new MacExternalCompat(dockManager, this);
        this._macDockEffects = new MacDockEffects(dockManager, this);
        this._macRoundedBlur = new MacRoundedBlurCompat(
            this._macDockEffects, dockManager);
        this._macDockInteractions = new MacDockInteractions(
            this._macDockEffects, dockManager, this);
        this._macThumbnailFisheye = new MacThumbnailFisheye(
            this._macDockInteractions);
        this._macInputIntegrity = new MacInputIntegrity(
            this._macDockInteractions, this._macThumbnailFisheye);
        this._macDirectInputStability = new MacDirectInputStability(
            this._macDockInteractions,
            this._macThumbnailFisheye,
            this._macInputIntegrity);
    }

    disable() {
        global.disconnect(this._shutdownID);
        delete this._shutdownID;

        this._macDirectInputStability?.destroy();
        this._macDirectInputStability = null;
        this._macInputIntegrity?.destroy();
        this._macInputIntegrity = null;
        this._macThumbnailFisheye?.destroy();
        this._macThumbnailFisheye = null;
        this._macDockInteractions?.destroy();
        this._macDockInteractions = null;
        this._macRoundedBlur?.destroy();
        this._macRoundedBlur = null;
        this._macDockEffects?.destroy();
        this._macDockEffects = null;
        this._macExternalCompat?.destroy();
        this._macExternalCompat = null;
        dockManager?.destroy();
        dockManager = null;
    }
}