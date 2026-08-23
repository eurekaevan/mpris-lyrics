# EGO Submission Checklist — 0.9.0

Last updated: 2026-08-23

## Deterministic and repository gates

- [x] metadata valid, concise, and contains project URL
- [x] only GNOME Shell 50 declared
- [x] deprecated metadata `version` removed
- [x] lifecycle/resource ownership audit completed
- [x] three repeated packaged enable/disable cycles pass
- [x] no secret or Authorization value in source/package/logging paths
- [x] gettext source structure and compiled locale package correctly
- [x] Shell UI verified in English and Simplified Chinese
- [x] Preferences verified in English and Simplified Chinese
- [x] bundled js-yaml version, upstream, modification status, MIT license, SHA-256 and reproduction documented
- [x] GPL-2.0-or-later project license included in repository and zip
- [x] `make check` passes
- [x] deterministic local integration suite passes
- [x] zip integrity, allowlist/denylist and runtime imports pass
- [x] CI uploads the package produced from the tested checkout
- [x] tag workflow attaches zip and SHA-256 without submitting to EGO
- [x] README installation, privacy, network, limitations and license sections complete
- [x] five privacy-safe release screenshots prepared
- [x] compatibility and GNOME 51 risk document present
- [x] focused changelog present
- [x] current EGO guideline audit recorded

## Final live desktop gates

- [x] install the final zip into a clean user extension directory and byte-compare packaged files
- [ ] log out/in so GNOME Shell 50 fresh-imports the candidate ESM
- [x] open Preferences from the installed candidate in English and Simplified Chinese
- [x] verify upgrade preserves existing GSettings and leaves cache/config namespaces untouched
- [ ] verify upgrade preserves an existing Secret Service credential (none was configured for this install)
- [ ] verify a fresh profile with no cache/offset/credential starts cleanly
- [ ] verify Panel, Popup, Artwork, Progress, Lyrics, Word sync, Translation, Offset and Player select with a live MPRIS player
- [ ] complete a 30–60 minute live soak including seek, track changes, popup, player switch, Firefox close/reopen and settings changes
- [ ] inspect the post-soak user journal and record any warning/error
- [x] review final screenshots and repository diff for personal or secret data

The installed files are the final zip contents plus the expected locally compiled `schemas/gschemas.compiled`. The running Shell still reports the pre-hardening metadata because GNOME Shell 50 has cached the old module and metadata; logout/login is therefore a real remaining gate, not an optional refresh.

The candidate must not be described as fully EGO-ready until every remaining final live desktop gate is checked. A headless Shell run validates the package and lifecycle but is not a substitute for a fresh logged-in GNOME session or a real provider/network soak.
