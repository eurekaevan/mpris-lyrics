# Changelog

## [0.9.0] - 2026-08-23

### Added

- English and Simplified Chinese interface translations for the Shell popup and Preferences.
- Fedora 44 CI for deterministic tests, local integration checks, and verified extension packages.
- Tag-triggered GitHub release packaging with a SHA-256 checksum.
- Release documentation for privacy, compatibility, EGO review, and manual verification.

### Changed

- Release metadata now targets GNOME Shell 50 only, includes the project URL and gettext domain, and no longer carries the deprecated metadata version field.
- Async work, signals, timers, later callbacks, transitions, actors, and caches now have explicit lifecycle owners and cancellation paths.
- LRCLIB and translation responses are size-limited, and all network clients identify release version 0.9.0.
- Packaging now includes compiled translations, the project license, and all bundled dependency attribution while excluding development files.

### Fixed

- Stale async artwork, lyrics, cache, and translation work can no longer update a destroyed or replaced owner.
- Repeated enable/disable no longer relies on lifecycle boolean guards and is covered by three-cycle Shell testing.
- Preferences cancels outstanding Secret Service and cache operations and disconnects its settings signals when closed.
- Translation rate-limit waits now remove their timeout and cancellation signal on every completion path.

[0.9.0]: https://github.com/eurekaevan/mpris-lyrics/releases/tag/v0.9.0
