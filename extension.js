import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LyricsIndicator} from './indicator.js';
import {LrcParser, LyricsProvider} from './lyrics.js';
import {MprisManager} from './mpris.js';

function trackKey(state) {
    const {title, artist, album, durationUs} = state.metadata;
    return [title, artist, album, durationUs].join('\u0000');
}

function fallbackText(metadata) {
    const suffix = metadata.artist ? ` — ${metadata.artist}` : '';
    return `♪ ${metadata.title}${suffix}`;
}

export default class MprisLyricsExtension extends Extension {
    enable() {
        this._enabled = true;
        this._timerId = 0;
        this._state = null;
        this._currentTrackKey = null;
        this._lyrics = null;

        this._indicator = new LyricsIndicator(this.metadata.name);
        Main.panel.addToStatusArea(this.uuid, this._indicator.actor, 0, 'center');

        this._lyricsProvider = new LyricsProvider();
        this._mprisManager = new MprisManager(
            state => this._onPlayerStateChanged(state));
        this._mprisManager.start();
    }

    disable() {
        this._enabled = false;
        this._stopTimer();

        this._mprisManager?.destroy();
        this._mprisManager = null;

        this._lyricsProvider?.destroy();
        this._lyricsProvider = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._state = null;
        this._lyrics = null;
        this._currentTrackKey = null;
    }

    _onPlayerStateChanged(state) {
        if (!this._enabled)
            return;

        this._state = state;

        if (!state) {
            this._currentTrackKey = null;
            this._lyrics = null;
            this._lyricsProvider.cancelPending();
            this._stopTimer();
            this._indicator.setVisible(false);
            return;
        }

        this._indicator.setVisible(true);

        const key = trackKey(state);
        if (key !== this._currentTrackKey) {
            this._currentTrackKey = key;
            this._lyrics = null;
            this._indicator.setText(fallbackText(state.metadata));

            const requestedKey = key;
            this._lyricsProvider.fetch(state.metadata, lines => {
                if (!this._enabled || requestedKey !== this._currentTrackKey)
                    return;

                this._lyrics = lines;
                this._updateIndicatorAndSchedule();
            });
        }

        this._updateIndicatorAndSchedule();
    }

    _stopTimer() {
        if (!this._timerId)
            return;

        GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _updateIndicatorAndSchedule() {
        this._stopTimer();

        if (!this._state || !this._indicator)
            return;

        let text = fallbackText(this._state.metadata);
        let nextLineTimeUs = null;
        if (this._lyrics) {
            const positionUs = this._mprisManager.getPositionUs();
            const index = LrcParser.currentIndex(this._lyrics, positionUs);
            const line = index >= 0 ? this._lyrics[index].text : null;
            if (line)
                text = `♪ ${line}`;

            nextLineTimeUs = this._lyrics[index + 1]?.timeUs ?? null;
        }

        this._indicator.setText(text);

        if (this._state.playbackStatus !== 'Playing' ||
            nextLineTimeUs === null)
            return;

        const delayMs = this._mprisManager
            .getDelayUntilPositionUs(nextLineTimeUs);
        if (delayMs === null || !Number.isFinite(delayMs))
            return;

        this._timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(delayMs)),
            () => {
                this._timerId = 0;
                if (this._enabled)
                    this._updateIndicatorAndSchedule();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(
            this._timerId, '[mpris-lyrics] next lyric line');
    }
}
