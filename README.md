# Dash to Dock
![screenshot](https://github.com/micheleg/dash-to-dock/raw/master/media/screenshot.jpg)

## A dock for the GNOME Shell
This extension enhances the dash moving it out of the overview and transforming it in a dock for an easier launching of applications and a faster switching between windows and desktops without having to leave the desktop view.

[<img src="https://micheleg.github.io/dash-to-dock/media/get-it-on-ego.png" height="100">](https://extensions.gnome.org/extension/307/dash-to-dock)

For additional installation instructions and more information visit [https://micheleg.github.io/dash-to-dock/](https://micheleg.github.io/dash-to-dock/).

## Native macOS dock renderer v2

The `feature/macos-fisheye` branch contains an opt-in native GNOME Shell presentation renderer designed to feel much closer to the macOS Dock than a normal hover-zoom extension.

The first fish-eye prototype transformed the existing Dash-to-Dock icon hierarchy directly. That caused clipping, stale hit-box geometry, repeatedly retargeted easing animations, and low-resolution icons being enlarged. v2 replaces that approach.

### v2 architecture

- Dash-to-Dock remains the application/window, favorites, menu, autohide/intellihide and drag-and-drop backend.
- A separate non-reactive Clutter render layer draws high-resolution application icons.
- Icon textures are created once near their maximum display size and are only scaled/translated by the compositor afterwards.
- Animation is driven by a `Clutter.Timeline` attached to the compositor frame clock, not by one `ease()` call per pointer event.
- Magnification uses a continuous raised-cosine influence curve; there is no discrete "nearest icon" anchor.
- Neighbor spacing is calculated from the actual extra width introduced by magnification rather than an arbitrary spread multiplier.
- A damped second-order spring follows the pointer and remains continuous when targets change every display frame.
- The original Dash icon actors remain nearly transparent input proxies so normal clicks, menus, minimization geometry and native Dash behavior are retained.
- During drag/reorder operations the renderer temporarily gets out of the way and Dash-to-Dock handles the complete native DND interaction.
- The dock material supports a translucent rounded background and optional `Shell.BlurEffect` background blur.
- Running applications receive stable macOS-like dots that do not scale with the icons.

The feature is disabled by default.

### Install the GitHub Actions build

Open the latest **Build & Package** workflow run for `feature/macos-fisheye` and download the artifact named:

`dash-to-dock-macos-native-v2`

Install it with:

```bash
gnome-extensions disable dash-to-dock@micxgx.gmail.com 2>/dev/null || true
gnome-extensions install --force ~/Downloads/dash-to-dock-macos-native-v2.zip
```

On an X11/Xorg GNOME session reload Shell with <kbd>Alt</kbd> + <kbd>F2</kbd>, type `r`, and press <kbd>Enter</kbd>. On Wayland, log out and back in.

Enable the extension if needed:

```bash
gnome-extensions enable dash-to-dock@micxgx.gmail.com
```

### Enable native Mac mode

Point `gsettings` at the extension-local schema directory:

```bash
SCHEMA_DIR="$HOME/.local/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com/schemas"

gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-style true
```

Current defaults are a `1.85x` peak scale, a `150px` fish-eye radius, critically damped spring motion, and high-resolution icon textures created at `1.35x` quality headroom.

### Tune the Mac renderer

```bash
# Peak scale = 1 + this value. 0.85 means 1.85x.
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-magnification 0.85

# Width of the continuous fish-eye wave.
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-magnification-radius 150.0

# Higher response follows the pointer faster.
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-spring-response 26.0

# 1.0 = critically damped. Below 1 can overshoot; above 1 is softer/slower.
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-spring-damping 1.0

# Pre-render icon quality/headroom. Higher values cost more texture memory.
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-icon-quality 1.35

# Glass material.
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-glass-blur true
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-glass-radius 24
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-glass-opacity 0.62
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-corner-radius 18.0
```

`macos-spread` and `macos-animation-duration` remain in the schema only so installs of the first experimental build do not break. v2 does not use them.

Disable the renderer at any time with:

```bash
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-style false
```

## Installation from source

The extension can be installed directly from source, either for the convenience of using git or to test the latest development version. Clone the desired branch with git.

### Build Dependencies

To compile the stylesheet you'll need an implementation of SASS. Dash to Dock supports `dart-sass` (`sass`), `sassc`, and `ruby-sass`. Every distro should have at least one of these implementations, we recommend using `dart-sass` (`sass`) or `sassc` over `ruby-sass` as `ruby-sass` is deprecated.

By default, Dash to Dock will attempt to build with `sassc`. To change this behavior set the `SASS` environment variable to either `dart` or `ruby`.

```bash
export SASS=dart
# or...
export SASS=ruby
```

### Building

Clone the repository or download the branch from github. A simple Makefile is included.

Next use `make` to install the extension into your home directory. A Shell reload is required <kbd>Alt</kbd> + <kbd>F2</kbd> <kbd>r</kbd> <kbd>Enter</kbd> under Xorg or under Wayland you may have to logout and login. The extension has to be enabled with *gnome-extensions-app* (GNOME Extensions) or with *dconf*.

```bash
git clone https://github.com/micheleg/dash-to-dock.git
make -C dash-to-dock install
```

If `msgfmt` is not available on your system, you will see an error message like the following:

```bash
make: msgfmt: No such file or directory
```

In this case install the `gettext` package from your distribution's repository.

## Bug Reporting

Bugs should be reported to the Github bug tracker [https://github.com/micheleg/dash-to-dock/issues](https://github.com/micheleg/dash-to-dock/issues).

## License
Dash to Dock Gnome Shell extension is distributed under the terms of the GNU General Public License,
version 2 or later. See the COPYING file for details.
