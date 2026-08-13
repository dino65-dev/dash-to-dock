// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {DockManager} from './docking.js';
import {MacDockEffects} from './macDockEffects.js';
import {Extension} from './dependencies/shell/extensions/extension.js';

const MACOS_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock.macos';
const BMS_BACKGROUND_NAME = 'bms-dash-backgroundgroup';

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

export default class DashToDockExtension extends Extension.Extension {
    enable() {
        // TODO: Remove this when upstream will disable extensions on shutdown
        // See: https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4214
        this._shutdownID = global.connect('shutdown', () => this.disable());
        dockManager = new DockManager(this);
        this._macExternalCompat = new MacExternalCompat(dockManager, this);
        this._macDockEffects = new MacDockEffects(dockManager, this);
    }

    disable() {
        global.disconnect(this._shutdownID);
        delete this._shutdownID;
        this._macDockEffects?.destroy();
        this._macDockEffects = null;
        this._macExternalCompat?.destroy();
        this._macExternalCompat = null;
        dockManager?.destroy();
        dockManager = null;
    }
}
