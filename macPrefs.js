// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

const MACOS_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock.macos';

const RESET_KEYS = [
    'macos-style',
    'macos-magnification',
    'macos-magnification-radius',
    'macos-spring-response',
    'macos-spring-damping',
    'macos-icon-quality',
    'macos-glass-blur',
    'macos-glass-radius',
    'macos-glass-opacity',
    'macos-corner-radius',
    'macos-adaptive-dark',
    'macos-light-opacity',
    'macos-dark-opacity',
    'macos-dynamic-border',
    'macos-border-opacity',
    'macos-reflection',
    'macos-reflection-opacity',
    'macos-reflection-height',
    'macos-divider',
    'macos-divider-opacity',
];

/**
 * Add the macOS renderer controls to Dash-to-Dock's existing preferences.
 *
 * @param {object} extensionPreferences GNOME ExtensionPreferences instance
 * @param {Gtk.Notebook} notebook existing Dash-to-Dock settings notebook
 */
export function addMacOSPreferencesPage(extensionPreferences, notebook) {
    if (!notebook)
        return;

    const settings = extensionPreferences.getSettings(MACOS_SCHEMA);
    const page = new Gtk.ScrolledWindow({
        hexpand: true,
        vexpand: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        kinetic_scrolling: true,
        overlay_scrolling: false,
        propagate_natural_height: false,
        min_content_height: 420,
    });
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_start: 14,
        margin_end: 10,
        margin_top: 14,
        margin_bottom: 18,
    });

    page.set_child(content);
    const pageAdjustment = page.get_vadjustment();
    pageAdjustment.set_step_increment(42);
    pageAdjustment.set_page_increment(280);

    // Keep a strong reference for the lifetime of the preferences page.
    page._macOSSettings = settings;

    content.append(makeSectionLabel('macOS Native Dock'));
    content.append(makeSwitchRow(
        settings,
        'macos-style',
        'Enable macOS renderer',
        'Use the high-resolution compositor renderer while keeping Dash-to-Dock as the backend.'
    ));

    content.append(makeSectionLabel('Magnification & Motion'));
    content.append(makeDoubleScaleRow(
        settings, 'macos-magnification', 'Peak magnification',
        'Extra scale applied under the pointer.', 0, 1.25, 0.05,
        value => `${(1 + value).toFixed(2)}×`
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-magnification-radius', 'Fish-eye radius',
        'Distance over which neighboring icons join the wave.', 48, 360, 2,
        value => `${Math.round(value)} px`
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-spring-response', 'Spring response',
        'Higher values make the dock follow the pointer more quickly.', 8, 50, 1,
        value => value.toFixed(0)
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-spring-damping', 'Spring damping',
        '1.0 is critically damped; lower values add a little overshoot.', 0.5, 1.5, 0.05,
        value => value.toFixed(2)
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-icon-quality', 'Icon texture quality',
        'Pre-render headroom for sharp magnification. Higher values use more GPU memory.', 1, 2, 0.05,
        value => `${value.toFixed(2)}×`
    ));

    content.append(makeSectionLabel('Frosted Glass'));
    content.append(makeSwitchRow(
        settings, 'macos-glass-blur', 'Frosted glass blur',
        'Use GNOME Shell background blur so wallpaper and windows tint the material naturally.'
    ));
    content.append(makeIntScaleRow(
        settings, 'macos-glass-radius', 'Blur radius',
        'Blur strength for the small compositor material region.', 0, 64, 1,
        value => `${Math.round(value)} px`
    ));
    content.append(makeSwitchRow(
        settings, 'macos-adaptive-dark', 'Adaptive light / dark material',
        'Follow the GNOME system color scheme automatically.'
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-light-opacity', 'Light material opacity',
        'Opacity used for the frosted light-gray material.', 0.1, 0.9, 0.02,
        value => `${Math.round(value * 100)}%`
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-dark-opacity', 'Dark material opacity',
        'Opacity used for the translucent charcoal material.', 0.1, 0.95, 0.02,
        value => `${Math.round(value * 100)}%`
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-glass-opacity', 'Fallback material opacity',
        'Used when adaptive appearance is disabled.', 0.05, 0.95, 0.02,
        value => `${Math.round(value * 100)}%`
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-corner-radius', 'Corner radius',
        'Radius of the pure rounded dock shell.', 8, 40, 1,
        value => `${Math.round(value)} px`
    ));

    content.append(makeSectionLabel('Border & Shelf'));
    content.append(makeSwitchRow(
        settings, 'macos-dynamic-border', 'Dynamic border',
        'Use a sharp dark edge in light mode and a sharp light edge in dark mode.'
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-border-opacity', 'Border contrast',
        'Strength of the adaptive one-pixel outline.', 0, 0.7, 0.02,
        value => `${Math.round(value * 100)}%`
    ));
    content.append(makeSwitchRow(
        settings, 'macos-reflection', 'Reflective shelf',
        'Show a subtle mirrored icon reflection when the dock is at the bottom of the screen.'
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-reflection-opacity', 'Reflection opacity',
        'Strength of the mirrored icon image.', 0, 0.4, 0.01,
        value => `${Math.round(value * 100)}%`
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-reflection-height', 'Reflection depth',
        'Vertical compression of the mirrored image.', 0.05, 0.35, 0.01,
        value => `${Math.round(value * 100)}%`
    ));

    content.append(makeSectionLabel('Structure'));
    content.append(makeSwitchRow(
        settings, 'macos-divider', 'Persistent divider',
        'Separate normal app icons from mounted locations, folders and Trash.'
    ));
    content.append(makeDoubleScaleRow(
        settings, 'macos-divider-opacity', 'Divider contrast',
        'Strength of the structural separator line.', 0.05, 0.8, 0.02,
        value => `${Math.round(value * 100)}%`
    ));

    const resetButton = new Gtk.Button({
        label: 'Reset macOS settings to defaults',
        halign: Gtk.Align.START,
    });
    resetButton.connect('clicked', () => {
        for (const key of RESET_KEYS)
            settings.reset(key);
    });
    content.append(resetButton);

    notebook.append_page(page, new Gtk.Label({label: 'macOS'}));
}

function makeSectionLabel(text) {
    const label = new Gtk.Label({
        label: `<b>${text}</b>`,
        use_markup: true,
        xalign: 0,
        margin_top: 4,
    });
    label.add_css_class('title-3');
    return label;
}

function makeSwitchRow(settings, key, title, subtitle) {
    const row = makeRow(title, subtitle);
    const toggle = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.END,
    });

    settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.append(toggle);
    return row;
}

function makeDoubleScaleRow(settings, key, title, subtitle, min, max, step, formatter) {
    return makeScaleRow(settings, key, title, subtitle, min, max, step,
        formatter, false);
}

function makeIntScaleRow(settings, key, title, subtitle, min, max, step, formatter) {
    return makeScaleRow(settings, key, title, subtitle, min, max, step,
        formatter, true);
}

function makeScaleRow(settings, key, title, subtitle, min, max, step, formatter, integer) {
    const wrapper = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 5,
    });
    const header = makeRow(title, subtitle);
    const valueLabel = new Gtk.Label({
        xalign: 1,
        width_chars: 8,
    });
    header.append(valueLabel);
    wrapper.append(header);

    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, min, max, step);
    scale.set_hexpand(true);
    scale.set_draw_value(false);
    scale.set_value(integer ? settings.get_int(key) : settings.get_double(key));
    installPageWheelScroll(scale);

    const updateLabel = () => valueLabel.set_label(formatter(scale.get_value()));
    updateLabel();

    scale.connect('value-changed', () => {
        const value = scale.get_value();
        if (integer)
            settings.set_int(key, Math.round(value));
        else
            settings.set_double(key, value);
        updateLabel();
    });
    settings.connect(`changed::${key}`, () => {
        const value = integer ? settings.get_int(key) : settings.get_double(key);
        if (Math.abs(scale.get_value() - value) > 0.0001)
            scale.set_value(value);
        updateLabel();
    });

    wrapper.append(scale);
    return wrapper;
}

function installPageWheelScroll(scale) {
    const controller = Gtk.EventControllerScroll.new(
        Gtk.EventControllerScrollFlags.VERTICAL);
    controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    controller.connect('scroll', (scroll, _dx, dy) => {
        if (!Number.isFinite(dy) || Math.abs(dy) < 0.001)
            return false;

        let parent = scale.get_parent();
        while (parent && typeof parent.get_vadjustment !== 'function')
            parent = parent.get_parent();

        if (!parent)
            return false;

        const adjustment = parent.get_vadjustment();
        const lower = adjustment.get_lower();
        const upper = adjustment.get_upper();
        const pageSize = adjustment.get_page_size();
        const maximum = Math.max(lower, upper - pageSize);
        let delta;

        if (scroll.get_unit?.() === Gdk.ScrollUnit.SURFACE) {
            // Touchpads report logical surface pixels: use them directly and
            // cap a single event so a driver spike cannot jump half the page.
            delta = Math.max(-72, Math.min(72, dy));
        } else {
            // Mouse wheels report detent clicks. Give each click one stable,
            // modest page step rather than multiplying raw deltas.
            const clicks = Math.max(-3, Math.min(3, dy));
            delta = clicks * 42;
        }

        const value = Math.max(lower, Math.min(maximum,
            adjustment.get_value() + delta));
        adjustment.set_value(value);
        return true;
    });
    scale.add_controller(controller);
}

function makeRow(title, subtitle) {
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
    });
    const labels = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        hexpand: true,
    });
    const titleLabel = new Gtk.Label({
        label: title,
        xalign: 0,
        wrap: true,
    });
    const subtitleLabel = new Gtk.Label({
        label: subtitle,
        xalign: 0,
        wrap: true,
        max_width_chars: 56,
    });

    subtitleLabel.add_css_class('dim-label');
    labels.append(titleLabel);
    labels.append(subtitleLabel);
    row.append(labels);
    return row;
}
