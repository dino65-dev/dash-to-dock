// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Cogl,
    GObject,
    Shell,
} from './dependencies/gi.js';

import {DockManager} from './docking.js';
import {MacDockEffects} from './macDockEffects.js';
import {Extension} from './dependencies/shell/extensions/extension.js';

const MACOS_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock.macos';
const BMS_BACKGROUND_NAME = 'bms-dash-backgroundgroup';
const ROUNDED_MASK_NAME = 'macos-dock-rounded-blur-mask';

// We export this so it can be accessed by other extensions
export let dockManager;

/**
 * GPU fragment mask applied after Shell.BlurEffect.
 *
 * Shell's BACKGROUND blur is rectangular. This effect clips the already
 * blurred offscreen texture with an antialiased rounded-rectangle SDF so the
 * blur and the visible dock material have exactly the same silhouette.
 */
const RoundedBlurMaskEffect = GObject.registerClass(
class RoundedBlurMaskEffect extends Shell.GLSLEffect {
    _init(cornerRadius) {
        this._cornerRadius = Math.max(0, cornerRadius);
        super._init();

        this._uTextureSize = this.get_uniform_location('uTextureSize');
        this._uBounds = this.get_uniform_location('uBounds');
        this._uRadius = this.get_uniform_location('uRadius');
    }

    vfunc_build_pipeline() {
        const hook = Cogl.SnippetHook?.FRAGMENT ?? Shell.SnippetHook?.FRAGMENT;
        if (hook === undefined)
            throw new Error('Fragment shader snippets are unavailable');

        this.add_glsl_snippet(
            hook,
            'uniform vec2 uTextureSize;\n' +
            'uniform vec4 uBounds;\n' +
            'uniform float uRadius;\n',
            'vec2 p = cogl_tex_coord0_in.xy * uTextureSize;\n' +
            'vec2 center = 0.5 * (uBounds.xy + uBounds.zw);\n' +
            'vec2 halfSize = 0.5 * (uBounds.zw - uBounds.xy);\n' +
            'float radius = min(uRadius, min(halfSize.x, halfSize.y));\n' +
            'vec2 q = abs(p - center) - max(halfSize - vec2(radius), vec2(0.0));\n' +
            'float distance = length(max(q, vec2(0.0))) + ' +
                'min(max(q.x, q.y), 0.0) - radius;\n' +
            'float coverage = 1.0 - smoothstep(-1.0, 1.0, distance);\n' +
            'cogl_color_out *= coverage;\n',
            false
        );
    }

    vfunc_paint_target(...params) {
        const texture = this.get_texture();
        const actor = this.get_actor();

        if (texture && actor) {
            const textureWidth = Math.max(1, texture.get_width());
            const textureHeight = Math.max(1, texture.get_height());
            const resourceScale = Math.max(1, actor.get_resource_scale?.() ?? 1);
            const actorWidth = Math.max(1, actor.width * resourceScale);
            const actorHeight = Math.max(1, actor.height * resourceScale);

            // Clutter offscreen effects pad their texture around the actor's
            // paint box. The dock blur actor has no children, so centering its
            // allocation inside that texture gives the correct rounded bounds.
            const x1 = Math.max(0, (textureWidth - actorWidth) / 2);
            const y1 = Math.max(0, (textureHeight - actorHeight) / 2);
            const x2 = Math.min(textureWidth, x1 + actorWidth);
            const y2 = Math.min(textureHeight, y1 + actorHeight);
            const radius = Math.min(
                this._cornerRadius * resourceScale,
                (x2 - x1) / 2,
                (y2 - y1) / 2
            );

            this.set_uniform_float(
                this._uTextureSize, 2, [textureWidth, textureHeight]);
            this.set_uniform_float(
                this._uBounds, 4, [x1, y1, x2, y2]);
            this.set_uniform_float(this._uRadius, 1, [radius]);
        }

        super.vfunc_paint_target(...params);
    }
});

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
 * Keeps the native blur aligned with the rounded material and reapplies the
 * mask whenever MacDockRenderer rebuilds its effect chain.
 */
class MacRoundedBlur {
    constructor(macEffects, manager) {
        this._macEffects = macEffects;
        this._dockManager = manager;
        this._settings = macEffects._settings;
        this._states = new Map();

        this._docksReadyId = manager.connect('docks-ready', () => this._sync());
        this._settingsChangedId = this._settings.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        if (!this._macEffects)
            return;

        if (this._docksReadyId)
            this._dockManager?.disconnect(this._docksReadyId);
        if (this._settingsChangedId)
            this._settings?.disconnect(this._settingsChangedId);

        for (const renderer of [...this._states.keys()])
            this._detach(renderer);

        this._states.clear();
        this._settings = null;
        this._dockManager = null;
        this._macEffects = null;
    }

    _sync() {
        if (!this._macEffects || !this._settings)
            return;

        const renderers = [...(this._macEffects._renderers?.values?.() ?? [])];

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

        // Native Shell blur has no rounded shape. Let it fill the *same* box as
        // the rounded material; the shader below then provides the silhouette.
        renderer._layoutBlurCore = rect => {
            const core = renderer._blurCore;
            if (!core)
                return;

            if (!this._settings?.get_boolean('macos-glass-blur')) {
                core.hide();
                return;
            }

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
            renderer._blurCore?.remove_effect_by_name?.(ROUNDED_MASK_NAME);
            if (renderer._layoutBlurCore)
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

        core.remove_effect_by_name?.(ROUNDED_MASK_NAME);

        if (!this._settings.get_boolean('macos-glass-blur'))
            return;

        // Renderer._configureBlur() adds this first. Our mask must be the next
        // effect so it operates on the already-blurred offscreen texture.
        if (!core.get_effect?.('macos-dock-blur'))
            return;

        try {
            const mask = new RoundedBlurMaskEffect(
                this._settings.get_double('macos-corner-radius'));
            core.add_effect_with_name(ROUNDED_MASK_NAME, mask);
            renderer._materialRect = null;
            renderer._wake?.();
        } catch {
            // Never regress to a visible rectangular blur. The rounded tinted
            // material still works perfectly without the blur pass.
            core.remove_effect_by_name?.('macos-dock-blur');
            core.hide();
        }
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
        this._macRoundedBlur = new MacRoundedBlur(this._macDockEffects, dockManager);
    }

    disable() {
        global.disconnect(this._shutdownID);
        delete this._shutdownID;

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
