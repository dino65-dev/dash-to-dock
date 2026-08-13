// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Clutter, St} from './dependencies/gi.js';
import {Main} from './dependencies/shell/ui.js';
import {MacThumbnailFisheye as MacThumbnailFisheyeBase}
    from './macThumbnailFisheyeBase.js';

/**
 * v116 keeps the green v115 fish-eye implementation intact and overrides only
 * thumbnail construction so restore/raise/focus happens through Mutter's single
 * activation path instead of a separate unminimize followed by activation.
 */
export class MacThumbnailFisheye extends MacThumbnailFisheyeBase {
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
}
