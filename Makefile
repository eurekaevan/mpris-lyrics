UUID := mpris-lyrics@eureka
USER_DATA_DIR ?= $(HOME)/.local/share
EXTENSION_DIR := $(USER_DATA_DIR)/gnome-shell/extensions/$(UUID)
SOURCES := metadata.json extension.js indicator.js lyrics.js mpris.js stylesheet.css

.PHONY: check integration install enable disable reload pack clean

check:
	gjs -m tests/test-lrc.js
	gjs -m tests/test-mpris.js
	gnome-extensions pack --force --out-dir=/tmp \
		--extra-source=indicator.js \
		--extra-source=lyrics.js \
		--extra-source=mpris.js .

integration:
	dbus-run-session -- gjs -m tests/integration-mpris-events.js
	gjs -m tests/test-lyrics-errors.js
	gjs -m tests/integration-lyrics-http.js

install:
	install -d "$(EXTENSION_DIR)"
	install -m 0644 $(SOURCES) "$(EXTENSION_DIR)/"

enable: install
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

reload: install
	-gnome-extensions disable "$(UUID)"
	gnome-extensions enable "$(UUID)"

pack:
	gnome-extensions pack --force \
		--extra-source=indicator.js \
		--extra-source=lyrics.js \
		--extra-source=mpris.js .

clean:
	rm -f "$(UUID).shell-extension.zip"
