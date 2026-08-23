# Compatibility

## Current release candidate matrix

| Environment | Status | Evidence |
|---|---|---|
| Fedora 44, GNOME Shell 50.4, Wayland | PASS | `make check`, local integration suite, packaged `gnome-shell-test-tool` runs in English and Simplified Chinese |
| Firefox MPRIS discovery and player policy | PASS, 2026-08-23 | Live Firefox owner plus a controlled second player verified selection, preference, disappearance fallback, and changed instance bus names |
| Firefox with Spotify Web lyrics | PASS, last full live check 2026-08-20 | Native MPRIS and LRCLIB path; not re-run after this hardening diff because the current desktop Shell has cached the previous ESM |
| Spotify Linux client | Not tested | No compatibility claim beyond its standard MPRIS interface |
| GNOME Shell 49 | Not tested / not declared | Absent from `shell-version` |
| GNOME Shell 51 | Not tested / not declared | Absent from `shell-version` |

Headless Shell testing verifies the package, actors, layout, settings, timers, repeated enable/disable, and deterministic runtime behavior. It does not replace a post-login live-player soak test.

## GNOME 51 preparation

Do not add `51` to `shell-version` until each of these areas has been tested on a real GNOME 51 session:

- centralized panel placement using `Main.panel._leftBox`, `_centerBox`, and `_rightBox`;
- `PanelMenu.Button` and `PopupMenu` layout/ownership;
- `St.ScrollView` adjustment and comfortable-zone scrolling;
- Shell theme CSS and symbolic icon behavior in light/dark modes;
- Clutter transitions, reduced motion, and `Meta.Later` cleanup;
- GTK4/Libadwaita Preferences API and extension gettext loading.

The panel boxes are private GNOME Shell fields. GNOME Shell 50 has no equivalent public API for moving one existing indicator among all five requested positions, so access remains centralized in `extension.js` rather than replaced with a broader hack.
