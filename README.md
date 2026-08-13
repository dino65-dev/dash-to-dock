# Dash to Dock — macOS Native

![screenshot](https://github.com/micheleg/dash-to-dock/raw/master/media/screenshot.jpg)

## A dock for GNOME Shell

This fork keeps Dash to Dock's application/window backend and adds an optional macOS-inspired native compositor renderer for a smoother, more physical dock presentation.

The normal Dash to Dock mode remains available. The macOS renderer is opt-in from the extension preferences.

## macOS Native mode

The macOS mode is designed around GNOME Shell's Clutter/Mutter compositor rather than CSS hover scaling.

### Features

- continuous fish-eye magnification with no discrete nearest-icon snap
- high-resolution icon textures created near maximum display size
- frame-clock-driven damped spring motion
- elastic rounded dock material that grows with icon spreading
- subtle bottom-dock icon reflections
- adaptive light/dark material and contrast-aware border
- persistent separator before minimized-window previews, locations/folders/Trash
- continuous launch bounce until an application's main window appears
- slower persistent alert bounce when a background app requires attention
- live miniature previews for minimized windows in a tray after the divider
- file-drag dim/highlight feedback for applications that declare file or URI support
- contextual right-click/long-press menus with recent files and window controls
- native desktop-file app actions, Dash to Dock click behavior, autohide/intellihide and DND backend
- Blur My Shell Dash background suppression while macOS mode is active
- dedicated macOS preferences page for visual and interaction controls

### Rendering architecture

Dash to Dock remains responsible for favorites, running applications, windows, menus, autohide/intellihide, monitors and drag-and-drop. `macDockEffects.js` provides the known-good visual layer, while `macDockInteractions.js` adds interaction-only behavior around that renderer.

Application icons are rendered in a separate non-reactive Clutter layer using high-resolution textures. The compositor handles icon scale/translation and alpha compositing; JavaScript only updates the small amount of fish-eye/spring state needed per frame.

The fish-eye influence is continuous, and neighboring icons are displaced from their actual additional magnified width rather than an arbitrary spread multiplier. Animation is driven from `Clutter.Timeline`, so it follows Mutter's frame clock instead of starting a new fixed-duration ease on every pointer event.

### Interaction behavior

**Launch bounce** watches the application's Shell state and window list. A launch can start the bounce immediately from the Dock click, and the bounce stops when a normal/dialog main window becomes available. A safety timeout prevents a failed launch from bouncing forever.

**Alert bounce** uses Dash to Dock's existing urgency tracking. The bounce is deliberately slower and persists while an unfocused application has an urgent or demands-attention window.

**Minimized-window trays** use live `Clutter.Clone` previews of Mutter's compositor window actors, the same underlying technique already used by Dash to Dock's window previews. Clicking a tray thumbnail restores and activates that window. The tray is inserted after normal apps and before location/Trash items, with the divider placed immediately before the tray.

**File-drag highlights** monitor GNOME Shell's external Xdnd path. GNOME exposes the drag position and target chain to Shell, but not a reliable per-file URI/MIME payload at this layer, so the Dock does not pretend to know exact per-file compatibility. Instead it highlights applications whose `GAppInfo` declares general file or URI support and dims applications that do not.

**Contextual quick menus** extend the existing native Dash to Dock right-click/long-press menu rather than replacing it. Existing app-specific desktop actions remain intact. The extension adds a Window Controls submenu and compatible recent files read from the desktop recent-files database.

### Seamless glass behavior

Stock GNOME dynamic `Shell.BlurEffect(BACKGROUND)` paints a rectangular background region on GNOME versions that do not expose rounded blur support. To avoid the faint square/box artifact around a rounded dock, this fork deliberately does **not** use that rectangular blur as a fallback.

- If a compatible `gi://Blur` / `gnome-rounded-blur` provider with a real `corner-radius` property is available, the dock can use true rounded dynamic blur.
- Otherwise, the dock uses the seamless rounded translucent material with no Gaussian background blur. This keeps the silhouette clean and avoids a rectangular compositor artifact.

The translucent material, adaptive tint and border still work without the optional rounded-blur provider.

## Controls

Open the extension preferences:

```bash
gnome-extensions prefs dash-to-dock@micxgx.gmail.com
```

The **macOS** tab exposes:

- enable/disable macOS Native mode
- peak magnification
- fish-eye radius
- spring response and damping
- high-resolution icon texture quality
- frosted-glass toggle and blur radius
- adaptive light/dark material and opacity
- corner radius
- dynamic border and contrast
- reflective shelf opacity/depth
- structural divider and contrast
- bounce on launch
- alert bouncing
- minimized-window thumbnail tray
- drag-and-drop compatibility highlights
- contextual quick menus
- recent-file menu count
- reset macOS settings

The feature is disabled by default; the individual interaction behaviors default to enabled once macOS Native mode is active.

## Manual GSettings control

The macOS settings use an extension-local schema. After installation:

```bash
SCHEMA_DIR="$HOME/.local/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com/schemas"

gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-style true
```

Disable it with:

```bash
gsettings --schemadir "$SCHEMA_DIR" set \
  org.gnome.shell.extensions.dash-to-dock.macos macos-style false
```

## Installation from source

### Build dependencies

To compile the stylesheet you'll need an implementation of SASS. Dash to Dock supports `dart-sass` (`sass`), `sassc`, and `ruby-sass`. We recommend `dart-sass` or `sassc`.

By default, Dash to Dock attempts to build with `sassc`. To select another implementation:

```bash
export SASS=dart
# or
export SASS=ruby
```

### Build and install

```bash
git clone https://github.com/dino65-dev/dash-to-dock.git
make -C dash-to-dock install
```

Under Xorg/X11, reload GNOME Shell with <kbd>Alt</kbd> + <kbd>F2</kbd>, type `r`, and press <kbd>Enter</kbd>. Under Wayland, log out and back in.

Enable the extension with GNOME Extensions or:

```bash
gnome-extensions enable dash-to-dock@micxgx.gmail.com
```

If `msgfmt` is missing, install the `gettext` package from your distribution.

## Validation

The macOS renderer was iterated against a real GNOME 46 X11 session. CI validates the renderer and interaction JavaScript syntax, ESLint, schema compilation and the installable package tree.

## Upstream Dash to Dock

This project is a fork of [Dash to Dock](https://github.com/micheleg/dash-to-dock). For upstream documentation and general Dash to Dock information, visit [micheleg.github.io/dash-to-dock](https://micheleg.github.io/dash-to-dock/).

## License

Dash to Dock GNOME Shell extension is distributed under the terms of the GNU General Public License, version 2 or later. See `COPYING` for details.
