import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LyricsIndicator} from './indicator.js';
import {LrcParser, LyricsProvider} from './lyrics.js';
import {MprisManager} from './mpris.js';
import {OffsetStore, trackKey} from './storage.js';

const MIN_LYRICS_OFFSET_MS = -10_000;
const MAX_LYRICS_OFFSET_MS = 10_000;

function trackInfo(metadata) {
    const suffix = metadata.artist ? ` — ${metadata.artist}` : '';
    return `${metadata.title}${suffix}`;
}

export default class MprisLyricsExtension extends Extension {
    enable() {
        this._enabled = true;
        this._timerId = 0;
        this._state = null;
        this._currentTrackKey = null;
        this._lyrics = null;
        this._lyricsLoaded = false;
        this._currentLyricIndex = -1;
        this._trackOffsetMs = 0;
        this._settingsSignalIds = [];

        this._settings = this.getSettings();
        this._globalOffsetMs = this._settings.get_int('global-offset-ms');
        this._connectSettings();

        this._offsetStore = new OffsetStore({
            onLoaded: () => this._onOffsetStoreLoaded(),
        });

        this._indicator = new LyricsIndicator(this.metadata.name, {
            onOffsetAdjust: deltaMs => this._adjustTrackOffset(deltaMs),
            onOffsetReset: () => this._setTrackOffsetMs(0),
            onPlayerSelected: stableId => {
                this._settings?.set_string('preferred-player', stableId);
            },
        });
        this._indicator.setMaxPanelWidth(
            this._settings.get_int('max-panel-width'));
        this._indicator.setOffsets(0, this._globalOffsetMs);
        Main.panel.addToStatusArea(this.uuid, this._indicator.actor, 0, 'center');

        this._lyricsProvider = new LyricsProvider();
        this._mprisManager = new MprisManager(
            state => this._onPlayerStateChanged(state), {
                onPlayersChanged: players => this._onPlayersChanged(players),
            });
        this._mprisManager.setPreferredPlayer(
            this._settings.get_string('preferred-player'));
        this._mprisManager.start();
    }

    disable() {
        this._enabled = false;
        this._stopTimer();

        if (this._settings) {
            for (const id of this._settingsSignalIds)
                this._settings.disconnect(id);
        }
        this._settingsSignalIds = [];

        this._mprisManager?.destroy();
        this._mprisManager = null;

        this._lyricsProvider?.destroy();
        this._lyricsProvider = null;

        this._offsetStore?.destroy();
        this._offsetStore = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._state = null;
        this._lyrics = null;
        this._lyricsLoaded = false;
        this._currentTrackKey = null;
        this._currentLyricIndex = -1;
        this._trackOffsetMs = 0;
        this._globalOffsetMs = 0;
        this._settings = null;
    }

    _connectSettings() {
        const connect = (key, callback) => {
            this._settingsSignalIds.push(
                this._settings.connect(`changed::${key}`, callback));
        };

        connect('show-icon', () => this._updateIndicatorAndSchedule(true));
        connect('max-panel-width', () => {
            this._indicator?.setMaxPanelWidth(
                this._settings.get_int('max-panel-width'));
        });
        connect('hide-when-paused', () =>
            this._updateIndicatorAndSchedule(true));
        connect('fallback-track-info', () =>
            this._updateIndicatorAndSchedule(true));
        connect('global-offset-ms', () => {
            this._globalOffsetMs = this._settings.get_int('global-offset-ms');
            this._indicator?.setOffsets(
                this._trackOffsetMs, this._globalOffsetMs);
            this._updateIndicatorAndSchedule(true);
        });
        connect('preferred-player', () => {
            const preferred = this._settings.get_string('preferred-player');
            this._mprisManager?.setPreferredPlayer(preferred);
            this._indicator?.setPlayers(
                this._mprisManager?.getPlayers() ?? [], preferred);
        });
        connect('cache-clear-generation', () => {
            this._lyricsProvider?.clearCaches().catch(error => {
                console.warn(`MPRIS Lyrics: could not clear runtime cache: ${error.message}`);
            });
        });
    }

    _onPlayerStateChanged(state) {
        if (!this._enabled)
            return;

        this._state = state;

        if (!state) {
            this._currentTrackKey = null;
            this._lyrics = null;
            this._lyricsLoaded = false;
            this._currentLyricIndex = -1;
            this._trackOffsetMs = 0;
            this._lyricsProvider.cancelPending();
            this._stopTimer();
            this._indicator.clearTrack();
            this._indicator.setVisible(false);
            return;
        }

        const key = trackKey(state.metadata);
        if (key !== this._currentTrackKey) {
            this._currentTrackKey = key;
            this._lyrics = null;
            this._lyricsLoaded = false;
            this._currentLyricIndex = -1;
            this._trackOffsetMs = this._offsetStore.get(state.metadata);
            this._indicator.setOffsets(
                this._trackOffsetMs, this._globalOffsetMs);
            this._indicator.setText(this._panelText(trackInfo(state.metadata)));
            this._indicator.setTrack(state.metadata);

            const requestedKey = key;
            this._lyricsProvider.fetch(state.metadata, lines => {
                if (!this._enabled || requestedKey !== this._currentTrackKey)
                    return;

                this._lyrics = lines;
                this._lyricsLoaded = true;
                this._indicator.setLyrics(lines);
                this._updateIndicatorAndSchedule(true);
            });
        }

        this._updateIndicatorAndSchedule(true);
    }

    _onPlayersChanged(players) {
        if (!this._enabled || !this._settings)
            return;

        this._indicator?.setPlayers(
            players, this._settings.get_string('preferred-player'));
    }

    _onOffsetStoreLoaded() {
        if (!this._enabled || !this._state || !this._offsetStore)
            return;

        this._trackOffsetMs = this._offsetStore.get(this._state.metadata);
        this._indicator?.setOffsets(
            this._trackOffsetMs, this._globalOffsetMs);
        this._updateIndicatorAndSchedule(true);
    }

    _stopTimer() {
        if (!this._timerId)
            return;

        GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _updateIndicatorAndSchedule(forceText = false) {
        this._stopTimer();

        if (!this._state || !this._indicator)
            return;

        const fallbackEnabled = this._settings.get_boolean(
            'fallback-track-info');
        let panelContent = fallbackEnabled
            ? trackInfo(this._state.metadata)
            : null;
        let nextLineTimeUs = null;
        if (this._lyrics) {
            const positionUs = this._mprisManager.getPositionUs();
            const effectivePositionUs = positionUs +
                (this._globalOffsetMs + this._trackOffsetMs) * 1000;
            const index = LrcParser.currentIndex(
                this._lyrics, effectivePositionUs);
            const line = index >= 0 ? this._lyrics[index].text : null;
            if (line)
                panelContent = line;

            if (forceText || index !== this._currentLyricIndex) {
                this._currentLyricIndex = index;
                this._indicator.setCurrentLyricIndex(index);
            }

            nextLineTimeUs = this._lyrics[index + 1]?.timeUs ?? null;
        }

        if (panelContent)
            this._indicator.setText(this._panelText(panelContent));

        const hiddenWhilePaused =
            this._settings.get_boolean('hide-when-paused') &&
            this._state.playbackStatus === 'Paused';
        const hasDisplayContent = Boolean(panelContent);
        this._indicator.setVisible(hasDisplayContent && !hiddenWhilePaused);

        if (this._state.playbackStatus !== 'Playing' ||
            nextLineTimeUs === null)
            return;

        const playbackTargetUs = nextLineTimeUs -
            (this._globalOffsetMs + this._trackOffsetMs) * 1000;
        const delayMs = this._mprisManager
            .getDelayUntilPositionUs(playbackTargetUs);
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

    _panelText(content) {
        return this._settings.get_boolean('show-icon')
            ? `♪ ${content}`
            : content;
    }

    _adjustTrackOffset(deltaMs) {
        this._setTrackOffsetMs(this._trackOffsetMs + deltaMs);
    }

    _setTrackOffsetMs(offsetMs) {
        if (!this._state || !this._offsetStore)
            return;

        const clamped = Math.clamp(
            Math.round(offsetMs),
            MIN_LYRICS_OFFSET_MS,
            MAX_LYRICS_OFFSET_MS);
        if (clamped === this._trackOffsetMs)
            return;

        this._trackOffsetMs = this._offsetStore.set(
            this._state.metadata, clamped);
        this._indicator?.setOffsets(
            this._trackOffsetMs, this._globalOffsetMs);
        this._updateIndicatorAndSchedule(true);
    }
}
