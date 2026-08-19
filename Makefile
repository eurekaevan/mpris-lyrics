UUID := mpris-lyrics@eureka
USER_DATA_DIR ?= $(HOME)/.local/share
EXTENSION_DIR := $(USER_DATA_DIR)/gnome-shell/extensions/$(UUID)
SOURCES := metadata.json extension.js indicator.js lyrics.js lyrics-document.js \
	lyrics-matcher.js lyrics-normalizer.js lyrics-parser.js \
	lyrics-synchronizer.js lyricsfile-parser.js mpris.js prefs.js storage.js \
	stylesheet.css
VENDOR_SOURCES := js-yaml.mjs LICENSE.js-yaml README.js-yaml.md
SCHEMA := schemas/org.gnome.shell.extensions.mpris-lyrics.gschema.xml

.PHONY: check integration install enable disable reload pack clean

check:
	glib-compile-schemas --strict --dry-run schemas
	gjs -m tests/test-lrc.js
	gjs -m tests/test-lyrics-document.js
	gjs -m tests/test-lyricsfile.js
	gjs -m tests/test-lyrics-matcher.js
	gjs -m tests/test-mpris.js
	gjs -m tests/test-player-policy.js
	gnome-extensions pack --force --out-dir=/tmp \
		--schema=$(SCHEMA) \
		--extra-source=indicator.js \
		--extra-source=lyrics.js \
		--extra-source=lyrics-document.js \
		--extra-source=lyrics-matcher.js \
		--extra-source=lyrics-normalizer.js \
		--extra-source=lyrics-parser.js \
		--extra-source=lyrics-synchronizer.js \
		--extra-source=lyricsfile-parser.js \
		--extra-source=mpris.js \
		--extra-source=storage.js \
		--extra-source=js-yaml.mjs \
		--extra-source=LICENSE.js-yaml \
		--extra-source=README.js-yaml.md .

integration:
	dbus-run-session -- gjs -m tests/integration-mpris-events.js
	gjs -m tests/test-lyrics-errors.js
	gjs -m tests/integration-lyrics-http.js
	gjs -m tests/integration-storage.js

install:
	install -d "$(EXTENSION_DIR)"
	install -m 0644 $(SOURCES) "$(EXTENSION_DIR)/"
	install -m 0644 $(VENDOR_SOURCES) "$(EXTENSION_DIR)/"
	install -d "$(EXTENSION_DIR)/schemas"
	install -m 0644 $(SCHEMA) "$(EXTENSION_DIR)/schemas/"
	glib-compile-schemas "$(EXTENSION_DIR)/schemas"

enable: install
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

reload: install
	-gnome-extensions disable "$(UUID)"
	gnome-extensions enable "$(UUID)"

pack:
	gnome-extensions pack --force \
		--schema=$(SCHEMA) \
		--extra-source=indicator.js \
		--extra-source=lyrics.js \
		--extra-source=lyrics-document.js \
		--extra-source=lyrics-matcher.js \
		--extra-source=lyrics-normalizer.js \
		--extra-source=lyrics-parser.js \
		--extra-source=lyrics-synchronizer.js \
		--extra-source=lyricsfile-parser.js \
		--extra-source=mpris.js \
		--extra-source=storage.js \
		--extra-source=js-yaml.mjs \
		--extra-source=LICENSE.js-yaml \
		--extra-source=README.js-yaml.md .

clean:
	rm -f "$(UUID).shell-extension.zip"
