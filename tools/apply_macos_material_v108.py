#!/usr/bin/env python3
from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


renderer_path = Path('macDockEffects.js')
renderer = renderer_path.read_text()

renderer = replace_once(
    renderer,
    "import {\n    Clutter,\n    Shell,\n    St,\n} from './dependencies/gi.js';",
    "import {\n    Clutter,\n    Gio,\n    Shell,\n    St,\n} from './dependencies/gi.js';",
    'renderer Gio import')

renderer = replace_once(
    renderer,
    "const MATERIAL_HIDDEN_SLIDE = 0.035;\nconst EDGE_REVEAL_TOLERANCE = 2;\nconst DOT_SIZE = 4;",
    "const MATERIAL_HIDDEN_SLIDE = 0.035;\n"
    "const EDGE_REVEAL_TOLERANCE = 2;\n"
    "const REFLECTION_GAP = 2;\n"
    "const DIVIDER_THICKNESS = 1;\n"
    "const DOT_SIZE = 4;",
    'renderer constants')

renderer = replace_once(
    renderer,
    "        this._lastSeparator = null;\n"
    "        this._separatorOpacity = 255;\n"
    "        this._materialRect = null;\n",
    "        this._lastSeparator = null;\n"
    "        this._separatorOpacity = 255;\n"
    "        this._materialRect = null;\n"
    "        this._blurCore = null;\n"
    "        this._divider = null;\n"
    "        this._interfaceSettings = new Gio.Settings({\n"
    "            schema_id: 'org.gnome.desktop.interface',\n"
    "        });\n",
    'renderer constructor')

renderer = replace_once(
    renderer,
    "        Main.uiGroup.add_child(this._layer);\n\n"
    "        this._material = new St.Widget({\n",
    "        Main.uiGroup.add_child(this._layer);\n\n"
    "        // Blur is intentionally isolated from the rounded shell. Keeping\n"
    "        // the compositor blur inside the corner arcs prevents a rectangular\n"
    "        // offscreen halo from leaking outside the rounded dock.\n"
    "        this._blurCore = new St.Widget({\n"
    "            reactive: false,\n"
    "        });\n"
    "        this._layer.add_child(this._blurCore);\n\n"
    "        this._material = new St.Widget({\n",
    'renderer blur core creation')

renderer = replace_once(
    renderer,
    "        this._layer.add_child(this._material);\n"
    "        this._updateMaterialStyle();\n"
    "        this._configureBlur();\n",
    "        this._layer.add_child(this._material);\n\n"
    "        this._divider = new St.Widget({\n"
    "            reactive: false,\n"
    "        });\n"
    "        this._layer.add_child(this._divider);\n\n"
    "        this._updateMaterialStyle();\n"
    "        this._configureBlur();\n"
    "        this._updateDecorationStyle();\n",
    'renderer divider creation')

renderer = replace_once(
    renderer,
    "        this._connect(global.stage, 'notify::width', () => this._resizeLayer());\n"
    "        this._connect(global.stage, 'notify::height', () => this._resizeLayer());\n\n"
    "        this._connect(this._settings, 'changed', (_settings, key) => {\n",
    "        this._connect(global.stage, 'notify::width', () => this._resizeLayer());\n"
    "        this._connect(global.stage, 'notify::height', () => this._resizeLayer());\n"
    "        this._connect(this._interfaceSettings, 'changed::color-scheme', () => {\n"
    "            this._updateMaterialStyle();\n"
    "            this._configureBlur();\n"
    "            this._updateDecorationStyle();\n"
    "            this._materialRect = null;\n"
    "            this._wake();\n"
    "        });\n\n"
    "        this._connect(this._settings, 'changed', (_settings, key) => {\n",
    'renderer color scheme signal')

renderer = replace_once(
    renderer,
    "            if (key.startsWith('macos-glass') || key === 'macos-corner-radius') {\n"
    "                this._updateMaterialStyle();\n"
    "                this._configureBlur();\n"
    "                this._materialRect = null;\n"
    "            }\n\n"
    "            this._queueSync();\n",
    "            const materialSetting = key.startsWith('macos-glass') ||\n"
    "                key === 'macos-corner-radius' ||\n"
    "                key === 'macos-adaptive-dark' ||\n"
    "                key === 'macos-light-opacity' ||\n"
    "                key === 'macos-dark-opacity' ||\n"
    "                key === 'macos-dynamic-border' ||\n"
    "                key === 'macos-border-opacity';\n\n"
    "            if (materialSetting) {\n"
    "                this._updateMaterialStyle();\n"
    "                this._configureBlur();\n"
    "                this._updateDecorationStyle();\n"
    "                this._materialRect = null;\n"
    "            }\n\n"
    "            if (key === 'macos-divider-opacity' || key === 'macos-divider')\n"
    "                this._updateDecorationStyle();\n\n"
    "            this._queueSync();\n",
    'renderer settings handling')

renderer = replace_once(
    renderer,
    "        this._material?.destroy();\n"
    "        this._layer?.destroy();\n"
    "        this._material = null;\n"
    "        this._layer = null;\n"
    "        this._settings = null;\n"
    "        this._dock = null;\n",
    "        this._blurCore?.destroy();\n"
    "        this._divider?.destroy();\n"
    "        this._material?.destroy();\n"
    "        this._layer?.destroy();\n"
    "        this._blurCore = null;\n"
    "        this._divider = null;\n"
    "        this._material = null;\n"
    "        this._layer = null;\n"
    "        this._interfaceSettings = null;\n"
    "        this._settings = null;\n"
    "        this._dock = null;\n",
    'renderer destroy')

renderer = replace_once(
    renderer,
    "        this._layer.add_child(actor);\n\n"
    "        const dot = new St.Widget({\n",
    "        this._layer.add_child(actor);\n\n"
    "        let reflection = null;\n"
    "        try {\n"
    "            reflection = new Clutter.Clone({\n"
    "                source: actor,\n"
    "                reactive: false,\n"
    "            });\n"
    "            reflection.set_size(textureSize, textureSize);\n"
    "            reflection.set_pivot_point(0.5, 1);\n"
    "            this._layer.add_child(reflection);\n"
    "            this._layer.set_child_below_sibling(reflection, actor);\n"
    "        } catch {\n"
    "            // Reflection is optional if a future Clutter version changes Clone.\n"
    "            reflection = null;\n"
    "        }\n\n"
    "        const dot = new St.Widget({\n",
    'renderer reflection creation')

renderer = replace_once(
    renderer,
    "            actor,\n"
    "            dot,\n"
    "            textureSize,\n",
    "            actor,\n"
    "            reflection,\n"
    "            dot,\n"
    "            textureSize,\n",
    'renderer reflection item property')

renderer = replace_once(
    renderer,
    "            item.actor?.destroy();\n"
    "            item.dot?.destroy();\n",
    "            item.reflection?.destroy();\n"
    "            item.actor?.destroy();\n"
    "            item.dot?.destroy();\n",
    'renderer reflection destroy')

renderer = replace_once(
    renderer,
    "        this._materialRect = null;\n"
    "        this._setMacPresentation(true);\n"
    "    }\n\n"
    "    _createItem(descriptor) {\n",
    "        this._materialRect = null;\n"
    "        this._setMacPresentation(true);\n"
    "        this._updateDecorationStyle();\n"
    "    }\n\n"
    "    _createItem(descriptor) {\n",
    'renderer decoration sync')

renderer = replace_once(
    renderer,
    "            this._paintRunningDot(item, centerX, centerY, hidden);\n"
    "        }\n"
    "    }\n\n"
    "    _paintRunningDot(item, centerX, centerY, hidden) {\n",
    "            this._paintReflection(item, actorX, hidden);\n"
    "            this._paintRunningDot(item, centerX, centerY, hidden);\n"
    "        }\n"
    "    }\n\n"
    "    _paintReflection(item, actorX, hidden) {\n"
    "        if (!item.reflection)\n"
    "            return;\n\n"
    "        const enabled = !hidden &&\n"
    "            this._dock.position === St.Side.BOTTOM &&\n"
    "            this._settings.get_boolean('macos-reflection');\n"
    "        if (!enabled) {\n"
    "            item.reflection.hide();\n"
    "            return;\n"
    "        }\n\n"
    "        const opacity = Math.max(0, Math.min(0.4,\n"
    "            this._settings.get_double('macos-reflection-opacity')));\n"
    "        const depth = Math.max(0.05, Math.min(0.35,\n"
    "            this._settings.get_double('macos-reflection-height')));\n"
    "        const baseTextureScale = item.baseSize / item.textureSize;\n"
    "        const renderScale = baseTextureScale * item.scale;\n"
    "        const shelfY = item.baseCenterY + item.baseSize / 2 + REFLECTION_GAP;\n\n"
    "        item.reflection.set_position(\n"
    "            Math.round(actorX), Math.round(shelfY - item.textureSize));\n"
    "        item.reflection.set_scale(renderScale, -renderScale * depth);\n"
    "        item.reflection.opacity = Math.round(opacity * 255);\n"
    "        item.reflection.show();\n"
    "    }\n\n"
    "    _paintRunningDot(item, centerX, centerY, hidden) {\n",
    'renderer reflection paint')

old_material = '''    _paintMaterial() {
        // Hide the detached glass only at the real final HIDDEN state.
        // SHOWING/HIDING continue painting while slide-x animates.
        if (!this._items.length || this._isDockFullyHidden()) {
            this._material.hide();
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

        // Avoid pointless layout/blur invalidation on frames where integer
        // geometry did not change.
        if (sameRect(this._materialRect, rect))
            return;

        this._material.set_position(rect.x, rect.y);
        this._material.set_size(rect.width, rect.height);
        this._materialRect = rect;
    }

    _updateMaterialStyle() {
        if (!this._material || !this._settings)
            return;

        const opacity = Math.max(0.05, Math.min(0.95,
            this._settings.get_double('macos-glass-opacity')));
        const radius =
            Math.max(8, this._settings.get_double('macos-corner-radius'));

        this._material.set_style(
            `background-color: rgba(30, 30, 32, ${opacity}); ` +
            `border-radius: ${radius}px; ` +
            'border: 1px solid rgba(255, 255, 255, 0.18); ' +
            'box-shadow: 0 10px 32px 0 rgba(0, 0, 0, 0.34);');
    }

    _configureBlur() {
        if (!this._material || !this._settings)
            return;

        this._material.clear_effects?.();

        if (!this._settings.get_boolean('macos-glass-blur'))
            return;
        if (!Shell.BlurEffect || Shell.BlurMode?.BACKGROUND === undefined)
            return;

        try {
            const blur = new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                radius: this._settings.get_int('macos-glass-radius'),
                brightness: 0.88,
            });
            this._material.add_effect_with_name('macos-dock-blur', blur);
        } catch {
            // Blur is optional across the supported GNOME Shell range.
        }
    }
'''

new_material = '''    _paintMaterial() {
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
        const opacity = adaptive
            ? (dark ? darkOpacity : lightOpacity)
            : fallbackOpacity;
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
            `background-color: rgba(255, 255, 255, 0.008); ` +
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
'''

renderer = replace_once(
    renderer, old_material, new_material, 'renderer material block')

renderer_path.write_text(renderer)

prefs_path = Path('prefs.js')
prefs = prefs_path.read_text()

prefs = replace_once(
    prefs,
    "import {\n    ExtensionPreferences,\n",
    "import {addMacOSPreferencesPage} from './macPrefs.js';\n\n"
    "import {\n    ExtensionPreferences,\n",
    'prefs mac page import')

prefs = replace_once(
    prefs,
    "        this.widget = this._builder.get_object('settings_notebook');\n\n"
    "        // Set a reasonable initial window height\n",
    "        this.widget = this._builder.get_object('settings_notebook');\n"
    "        addMacOSPreferencesPage(extensionPreferences, this.widget);\n\n"
    "        // Set a reasonable initial window height\n",
    'prefs mac page attach')

prefs_path.write_text(prefs)
