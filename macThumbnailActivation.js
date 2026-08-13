// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Clutter, St} from './dependencies/gi.js';
import {Main} from './dependencies/shell/ui.js';
import {MacDockInteractions} from './macDockInteractions.js';

export class MacDockInteractionsFixed extends MacDockInteractions {
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
                const event = Clutter.get_current_event?.();
                const timestamp = event?.get_time?.() || global.get_current_time();
                Main.activateWindow(window, timestamp);
            } catch (error) {
                console.error(`[macOS Dock] Failed to activate minimized window: ${error}`);
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
}
