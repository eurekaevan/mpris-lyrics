# EGO Review Audit for 0.9.0

Audit date: 2026-08-23

Sources checked:

- [GNOME Extensions Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- [GNOME Extensions Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html)
- [GNOME Extension Translations](https://gjs.guide/extensions/development/translations.html)
- [GNOME Extension Anatomy](https://gjs.guide/extensions/overview/anatomy.html)
- [GNOME Shell 50 porting guide](https://gjs.guide/extensions/upgrading/gnome-shell-50.html)

This document records the current source and package audit. “PASS” means deterministic evidence exists in this checkout; it does not substitute for the remaining post-login live soak gates in `EGO-CHECKLIST.md`.

| Requirement | Current status | Action needed | Evidence |
|---|---|---|---|
| Metadata is valid JSON and contains UUID/name/description/URL | PASS | None | `metadata.json`; packaged Shell metadata assertion |
| Supported Shell versions are honest | PASS | Keep only `50` until separately tested | `shell-version: ["50"]`; compatibility matrix |
| Deprecated metadata `version` is absent | PASS | Let EGO manage submitted revisions | Metadata/package assertions |
| Gettext domain and compiled locale are packaged | PASS | Maintain POT/PO on string changes | `po/`, `locale/zh_CN/...mo`, English/Chinese Shell and prefs tests |
| No module-scope runtime objects, signals, or timers | PASS | None | Entry-point audit; resources created during `enable()`/window fill |
| Disable destroys all extension-owned objects | PASS | Complete live post-login soak | Three-cycle packaged Shell lifecycle test |
| Signals and D-Bus subscriptions are disconnected | PASS | None | Explicit IDs/owners in `extension.js`, `mpris.js`, `indicator.js` |
| GLib timeout and Meta later sources are removed | PASS | None | Explicit stop/remove methods plus lifecycle assertions |
| Async work is cancellable and stale-safe | PASS | None | `Gio.Cancellable`, request serial/generation, current-owner identity |
| Actors and Clutter transitions are destroyed/stopped | PASS | None | Indicator/artwork destroy paths and transition removal |
| No lifecycle `_enabled`/`_destroyed` boolean guards | PASS | None | Production source search returns no matches |
| No monkey patching or prototype modification | PASS | None | Static source audit |
| No subprocess, executable, or runtime script dependency | PASS | None | Static audit; no `Gio.Subprocess`; package contains JS/data only |
| Shell and Preferences libraries remain process-separated | PASS | None | Shell uses St/Clutter; prefs uses GTK4/Libadwaita |
| Networking is asynchronous, bounded, and cancellable | PASS | None | Local HTTP tests for success, 429, timeout/cancel, malformed and oversized responses |
| Credentials avoid settings/cache/log/source | PASS | None | `credentials.js`; secret-pattern audit; Secret Service CRUD/cleanup test passed |
| Filesystem access is namespaced and bounded | PASS | None | XDG paths, atomic replace, safe-miss corruption tests, bounded caches |
| Bundled libraries are readable and attributed | PASS | None | Unmodified js-yaml 4.1.0 ESM, upstream/version/hashes/MIT/reproduction notes |
| Project license is EGO-compatible and packaged | PASS | None | GPL-2.0-or-later `LICENSE`; package content check |
| Preferences uses GSettings schema conventions | PASS | None | Strict schema compile and GTK window test |
| Stylesheet is theme-derived and package-owned | PASS | None | `stylesheet.css`; no bundled theme or hard-coded light/dark palette |
| Private Shell API is minimized | RISK ACCEPTED | Re-test for every new Shell major | Three panel box fields centralized in `_panelBox()`; no public GNOME 50 equivalent |
| `session-modes` does not enable user extensions at login/lock | PASS | None | No `session-modes` field |
| Package excludes development-only files | PASS | None | `tools/check-package.sh`; zip contains runtime, schema, MO and licenses only |
| Logging is contextual and not excessive | PASS | Re-check live soak journal | No lyrics/key/header logging; expected network failures use bounded warnings |
| AI-assisted code is understandable and maintainable | PASS | Author review remains required | Removed redundant identity lifecycle booleans and no new abstraction layer |

## Private API decision

GNOME Shell 50 exposes `Main.panel.addToStatusArea()` for initial placement but no public API that moves one existing indicator between the left, center, and right panel boxes while preserving all five configured positions. The extension therefore keeps exactly three private-field reads in one compatibility function. Reaching into more internals, reconstructing the indicator, or monkey-patching Shell would be riskier.

## Maintainability notes

The lifecycle can be explained as:

```text
enable
  → settings + owner objects
  → MPRIS signals
  → lyrics/translation/artwork requests
  → one-shot synchronization sources and actors

disable
  → cancel requests
  → remove sources and transitions
  → disconnect signals/subscriptions
  → destroy actors and owners
  → release references
```

The remaining complex state is product-essential: current playback identity, lyrics document, translation document, effective offset, and one-shot line/word scheduling. It was not replaced with a new framework during hardening.
