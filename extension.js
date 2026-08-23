import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LyricsIndicator} from './indicator.js';
import {LyricsProvider} from './lyrics.js';
import {SyncLevel} from './lyrics-document.js';
import {LyricsSynchronizer} from './lyrics-synchronizer.js';
import {MprisManager} from './mpris.js';
import {OffsetStore, trackKey} from './storage.js';
import {sourceLyricsHash} from './translation-document.js';
import {
    TranslationService,
    TranslationStatus,
} from './translation-service.js';

const MIN_LYRICS_OFFSET_MS = -10_000;
const MAX_LYRICS_OFFSET_MS = 10_000;
const PROGRESS_UPDATE_INTERVAL_MS = 500;
const MPRIS_NO_TRACK_ID = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
const DEFAULT_PANEL_POSITION = 'center';
const PANEL_PLACEMENTS = Object.freeze({
    'far-left': Object.freeze({boxName: 'left', atEnd: false}),
    left: Object.freeze({boxName: 'left', atEnd: true}),
    center: Object.freeze({boxName: 'center', atEnd: false}),
    right: Object.freeze({boxName: 'right', atEnd: false}),
    'far-right': Object.freeze({boxName: 'right', atEnd: true}),
});

function panelPlacement(position) {
    return PANEL_PLACEMENTS[position] ??
        PANEL_PLACEMENTS[DEFAULT_PANEL_POSITION];
}

function trackInfo(metadata) {
    const suffix = metadata.artist ? ` — ${metadata.artist}` : '';
    return `${metadata.title}${suffix}`;
}

function explicitLineEndMs(line) {
    if (Number.isFinite(line?.endMs) && line.endMs > line.startMs)
        return line.endMs;

    for (let index = (line?.words?.length ?? 0) - 1; index >= 0; index--) {
        const endMs = line.words[index].endMs;
        if (Number.isFinite(endMs) && endMs > line.startMs)
            return endMs;
    }
    return null;
}

function playbackTrackIdentity(state) {
    const stableTrackId = state.metadata.trackId?.trim();
    const trackId = stableTrackId && stableTrackId !== MPRIS_NO_TRACK_ID
        ? stableTrackId
        : '';

    // TrackId is not universally unique per track. Firefox, for example,
    // exposes one constant object path for every Spotify Web track. Keep it as
    // a useful signal for compliant players, but also include the metadata
    // fields that identify a new lyrics lookup. Album is deliberately omitted
    // so a display-only album correction does not rebuild the lyrics view.
    return [
        state.busName,
        trackId,
        state.metadata.title ?? '',
        state.metadata.artist ?? '',
        Math.max(0, Number(state.metadata.durationUs) || 0),
    ].join('\u0000');
}

function displayMetadataKey(metadata) {
    return [metadata.title, metadata.artist, metadata.album].join('\u0000');
}

export default class MprisLyricsExtension extends Extension {
    enable() {
        this._enabled = true;
        this._lineTimerId = 0;
        this._wordTimerId = 0;
        this._progressTimerId = 0;
        this._state = null;
        this._currentTrackKey = null;
        this._currentTrackIdentity = null;
        this._lyricsDocument = null;
        this._lyricsLoaded = false;
        this._translationDocument = null;
        this._translationGeneration = 0;
        this._currentLyricIndex = -1;
        this._trackOffsetMs = 0;
        this._settingsSignalIds = [];

        this._settings = this.getSettings();
        this._globalOffsetMs = this._settings.get_int('global-offset-ms');
        this._wordSyncEnabled = this._settings.get_boolean('word-sync-enabled');
        this._translationEnabled = this._settings.get_boolean(
            'translation-enabled');
        this._translationDisplayMode = this._settings.get_string(
            'translation-display-mode');
        this._panelLyricsLanguage = this._settings.get_string(
            'panel-lyrics-language');
        this._panelPosition = this._settings.get_string('panel-position');
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
            onPopupOpenChanged: open => this._onPopupOpenChanged(open),
            onTranslationAction: options =>
                this._requestTranslation({...options, allowNetwork: true}),
        });
        this._indicator.setWordSyncEnabled(this._wordSyncEnabled);
        this._indicator.setTranslationEnabled(this._translationEnabled);
        this._indicator.setTranslationDisplayMode(
            this._translationDisplayMode);
        this._indicator.setMaxPanelWidth(
            this._settings.get_int('max-panel-width'));
        this._indicator.setShowIcon(
            this._settings.get_boolean('show-icon'));
        this._indicator.setOffsets(0, this._globalOffsetMs);
        const placement = panelPlacement(this._panelPosition);
        const panelBox = this._panelBox(placement.boxName);
        const panelIndex = placement.atEnd
            ? panelBox.get_n_children()
            : 0;
        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator.actor,
            panelIndex,
            placement.boxName);

        this._lyricsProvider = new LyricsProvider();
        this._translationService = new TranslationService();
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
        this._stopLineTimer();
        this._stopWordTimer();
        this._stopProgressTimer();
        this._cancelTranslation();

        if (this._settings) {
            for (const id of this._settingsSignalIds)
                this._settings.disconnect(id);
        }
        this._settingsSignalIds = [];

        this._mprisManager?.destroy();
        this._mprisManager = null;

        this._lyricsProvider?.destroy();
        this._lyricsProvider = null;

        this._translationService?.destroy();
        this._translationService = null;

        this._offsetStore?.destroy();
        this._offsetStore = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._state = null;
        this._lyricsDocument = null;
        this._lyricsLoaded = false;
        this._translationDocument = null;
        this._currentTrackKey = null;
        this._currentTrackIdentity = null;
        this._currentLyricIndex = -1;
        this._trackOffsetMs = 0;
        this._globalOffsetMs = 0;
        this._wordSyncEnabled = false;
        this._translationEnabled = false;
        this._translationDisplayMode = 'bilingual';
        this._panelLyricsLanguage = 'original';
        this._panelPosition = DEFAULT_PANEL_POSITION;
        this._settings = null;
    }

    _connectSettings() {
        const connect = (key, callback) => {
            this._settingsSignalIds.push(
                this._settings.connect(`changed::${key}`, callback));
        };

        connect('show-icon', () => {
            this._indicator?.setShowIcon(
                this._settings.get_boolean('show-icon'));
            this._updateIndicatorAndSchedule(true);
        });
        connect('panel-position', () => {
            this._moveIndicator(
                this._settings.get_string('panel-position'));
        });
        connect('max-panel-width', () => {
            this._indicator?.setMaxPanelWidth(
                this._settings.get_int('max-panel-width'));
        });
        connect('hide-when-paused', () =>
            this._updateIndicatorAndSchedule(true));
        connect('fallback-track-info', () =>
            this._updateIndicatorAndSchedule(true));
        connect('word-sync-enabled', () => {
            this._wordSyncEnabled =
                this._settings.get_boolean('word-sync-enabled');
            this._indicator?.setWordSyncEnabled(this._wordSyncEnabled);
            if (this._wordSyncEnabled)
                this._updateWordAndSchedule();
            else
                this._stopWordTimer();
        });
        connect('translation-enabled', () => {
            this._translationEnabled = this._settings.get_boolean(
                'translation-enabled');
            this._indicator?.setTranslationEnabled(this._translationEnabled);
            this._cancelTranslation();
            if (this._translationEnabled)
                this._requestTranslation();
            else
                this._clearTranslation('idle');
            this._updateIndicatorAndSchedule(true);
        });
        connect('translation-target-language', () => {
            this._restartTranslation();
        });
        connect('translation-provider', () => {
            this._restartTranslation();
        });
        connect('translation-display-mode', () => {
            this._translationDisplayMode = this._settings.get_string(
                'translation-display-mode');
            this._indicator?.setTranslationDisplayMode(
                this._translationDisplayMode);
            this._updateWordAndSchedule();
        });
        connect('auto-translate', () => {
            this._restartTranslation();
        });
        connect('panel-lyrics-language', () => {
            this._panelLyricsLanguage = this._settings.get_string(
                'panel-lyrics-language');
            this._updateIndicatorAndSchedule(true);
        });
        connect('translation-credential-generation', () => {
            this._restartTranslation();
        });
        connect('translation-cache-clear-generation', () => {
            this._cancelTranslation();
            this._translationService?.clearCache().then(() => {
                if (this._enabled && this._translationEnabled)
                    this._requestTranslation();
            }).catch(() => {
                console.warn('MPRIS Lyrics: could not clear translation cache');
            });
            this._clearTranslation('idle');
        });
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

    _panelBox(boxName) {
        return Main.panel[`_${boxName}Box`];
    }

    _moveIndicator(position) {
        this._panelPosition = PANEL_PLACEMENTS[position]
            ? position
            : DEFAULT_PANEL_POSITION;
        const container = this._indicator?.actor?.container;
        if (!container)
            return;

        const placement = panelPlacement(this._panelPosition);
        const targetBox = this._panelBox(placement.boxName);
        this._indicator.actor.menu.close();
        container.get_parent()?.remove_child(container);
        const targetIndex = placement.atEnd
            ? targetBox.get_n_children()
            : 0;
        targetBox.insert_child_at_index(container, targetIndex);
    }

    _onPlayerStateChanged(state) {
        if (!this._enabled)
            return;

        const previousState = this._state;
        this._state = state;

        if (!state) {
            this._currentTrackKey = null;
            this._currentTrackIdentity = null;
            this._lyricsDocument = null;
            this._lyricsLoaded = false;
            this._translationDocument = null;
            this._currentLyricIndex = -1;
            this._trackOffsetMs = 0;
            this._lyricsProvider.cancelPending();
            this._cancelTranslation();
            this._stopLineTimer();
            this._stopWordTimer();
            this._stopProgressTimer();
            this._indicator.clearTrack();
            this._indicator.setVisible(false);
            return;
        }

        const identity = playbackTrackIdentity(state);
        const key = trackKey(state.metadata);
        if (identity !== this._currentTrackIdentity) {
            this._stopLineTimer();
            this._stopWordTimer();
            this._currentTrackIdentity = identity;
            this._currentTrackKey = key;
            this._lyricsDocument = null;
            this._lyricsLoaded = false;
            this._translationDocument = null;
            this._currentLyricIndex = -1;
            this._trackOffsetMs = this._offsetStore.get(state.metadata);
            this._indicator.setOffsets(
                this._trackOffsetMs, this._globalOffsetMs);
            this._indicator.setText(this._panelText(trackInfo(state.metadata)));
            this._indicator.setTrack(state.metadata, identity);
            this._indicator.setTranslation(null);
            this._indicator.setTranslationState('idle');
            this._cancelTranslation();

            const requestedKey = key;
            const requestedIdentity = identity;
            this._lyricsProvider.fetch(state.metadata, document => {
                if (!this._enabled || requestedKey !== this._currentTrackKey ||
                    requestedIdentity !== this._currentTrackIdentity)
                    return;

                this._lyricsDocument = document;
                this._lyricsLoaded = true;
                this._indicator.setLyrics(document);
                this._updateIndicatorAndSchedule(true);
                this._requestTranslation();
            });
        } else {
            const previousMetadata = previousState?.metadata;
            if (!previousMetadata ||
                displayMetadataKey(previousMetadata) !==
                    displayMetadataKey(state.metadata))
                this._indicator.updateMetadataDisplay(state.metadata);
            if (!previousMetadata ||
                previousMetadata.artUrl !== state.metadata.artUrl)
                this._indicator.setArtwork(state.metadata.artUrl, identity);
        }

        this._indicator.setProgress(
            state.positionUs,
            state.metadata.durationUs,
            {playing: state.playbackStatus === 'Playing'});
        this._updateIndicatorAndSchedule(true);
    }

    _onPopupOpenChanged(open) {
        if (open) {
            this._startProgressTimer();
            this._updateWordAndSchedule();
        } else {
            this._stopProgressTimer();
            this._stopWordTimer();
        }
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

    _cancelTranslation() {
        this._translationGeneration++;
        this._translationService?.cancelAll();
    }

    _clearTranslation(status = TranslationStatus.IDLE) {
        this._translationDocument = null;
        this._indicator?.setTranslation(null);
        this._indicator?.setTranslationState(status);
    }

    _restartTranslation() {
        if (!this._settings)
            return;
        this._cancelTranslation();
        this._clearTranslation();
        if (this._translationEnabled)
            this._requestTranslation();
        this._updateIndicatorAndSchedule(true);
    }

    _requestTranslation({
        forceRefresh = false,
        allowNetwork = null,
    } = {}) {
        if (!this._enabled || !this._translationEnabled ||
            !this._translationService || !this._lyricsDocument ||
            !this._currentTrackKey)
            return;

        const generation = ++this._translationGeneration;
        const requestedTrackKey = this._currentTrackKey;
        const requestedHash = sourceLyricsHash(this._lyricsDocument);
        const targetLanguage = this._settings.get_string(
            'translation-target-language').trim();
        const providerId = this._settings.get_string('translation-provider');
        const useNetwork = allowNetwork ??
            this._settings.get_boolean('auto-translate');

        this._translationService.translate(this._lyricsDocument, {
            trackKey: requestedTrackKey,
            targetLanguage,
            providerId,
            forceRefresh,
            allowNetwork: useNetwork,
            onStatus: result => {
                if (generation === this._translationGeneration &&
                    result.status === TranslationStatus.LOADING)
                    this._indicator?.setTranslationState(result.status);
            },
        }).then(result => {
            if (!this._enabled || generation !== this._translationGeneration ||
                requestedTrackKey !== this._currentTrackKey ||
                requestedHash !== sourceLyricsHash(this._lyricsDocument))
                return;

            const translation = result.document ?? null;
            if (translation &&
                (translation.trackKey !== requestedTrackKey ||
                    translation.sourceLyricsHash !== requestedHash ||
                    translation.targetLanguage !== targetLanguage ||
                    translation.provider !== providerId))
                return;

            if (translation) {
                this._translationDocument = translation;
                this._indicator?.setTranslation(translation);
            }
            if (result.status !== TranslationStatus.CANCELED)
                this._indicator?.setTranslationState(result.status, result);
            if (![TranslationStatus.AVAILABLE,
                TranslationStatus.IDLE,
                TranslationStatus.SAME_LANGUAGE,
                TranslationStatus.SKIPPED,
                TranslationStatus.NOT_CONFIGURED].includes(result.status)) {
                console.warn(
                    `MPRIS Lyrics: translation status ${result.status}`);
            }
            this._updateIndicatorAndSchedule(true);
        }).catch(() => {
            if (generation !== this._translationGeneration)
                return;
            this._indicator?.setTranslationState(
                TranslationStatus.PROVIDER_ERROR);
            console.warn('MPRIS Lyrics: unexpected translation service failure');
        });
    }

    _stopLineTimer() {
        if (!this._lineTimerId)
            return;
        GLib.source_remove(this._lineTimerId);
        this._lineTimerId = 0;
    }

    _stopWordTimer() {
        if (!this._wordTimerId)
            return;
        GLib.source_remove(this._wordTimerId);
        this._wordTimerId = 0;
    }

    _stopProgressTimer() {
        if (!this._progressTimerId)
            return;
        GLib.source_remove(this._progressTimerId);
        this._progressTimerId = 0;
    }

    _startProgressTimer() {
        this._updateProgress();
        if (this._progressTimerId)
            return;

        this._progressTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PROGRESS_UPDATE_INTERVAL_MS,
            () => {
                if (!this._enabled || !this._indicator?.isPopupOpen()) {
                    this._progressTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._updateProgress();
                return GLib.SOURCE_CONTINUE;
            });
        GLib.Source.set_name_by_id(
            this._progressTimerId, '[mpris-lyrics] popup progress');
    }

    _updateProgress() {
        if (!this._state || !this._indicator || !this._mprisManager)
            return;
        this._indicator.setProgress(
            this._mprisManager.getPositionUs(),
            this._state.metadata.durationUs,
            {playing: this._state.playbackStatus === 'Playing'});
    }

    _effectivePositionMs() {
        return this._mprisManager.getPositionUs() / 1000 +
            this._globalOffsetMs + this._trackOffsetMs;
    }

    _updateIndicatorAndSchedule(forceText = false) {
        this._stopLineTimer();

        if (!this._state || !this._indicator)
            return;

        const fallbackEnabled = this._settings.get_boolean(
            'fallback-track-info');
        let panelContent = fallbackEnabled
            ? trackInfo(this._state.metadata)
            : null;
        let panelContentIsLyric = false;
        let panelContentKey = null;
        let currentLine = null;
        let nextLineStartMs = null;
        let lineEndMs = null;
        const document = this._lyricsDocument;
        const effectivePositionMs = this._effectivePositionMs();

        if (document?.instrumental) {
            panelContent = 'Instrumental';
            this._currentLyricIndex = -1;
            this._indicator.setCurrentLyricIndex(-1);
        } else if (document && document.syncLevel !== SyncLevel.NONE) {
            const index = LyricsSynchronizer.currentLineIndex(
                document, effectivePositionMs);
            currentLine = index >= 0 ? document.lines[index] : null;
            const translated = currentLine &&
                this._panelLyricsLanguage === 'translated'
                ? this._translationDocument?.lines?.find(line =>
                    line.lineId === currentLine.lineId)?.text
                : null;
            const line = translated || currentLine?.text || null;
            if (line) {
                panelContent = line;
                panelContentIsLyric = true;
                panelContentKey = currentLine.lineId;
            }

            if (forceText || index !== this._currentLyricIndex) {
                this._currentLyricIndex = index;
                this._indicator.setCurrentLyricIndex(index, {
                    reposition: forceText,
                });
            }
            nextLineStartMs = LyricsSynchronizer.nextLineStartMs(
                document, index);
            lineEndMs = nextLineStartMs ?? explicitLineEndMs(currentLine);
            if (lineEndMs === null && currentLine) {
                const durationMs = Number(
                    this._state.metadata.durationUs) / 1000;
                const effectiveTrackEndMs = durationMs +
                    this._globalOffsetMs + this._trackOffsetMs;
                if (Number.isFinite(effectiveTrackEndMs) &&
                    effectiveTrackEndMs > currentLine.startMs)
                    lineEndMs = effectiveTrackEndMs;
            }
        } else if (document?.lines?.length) {
            // Static lyrics still need an entry point to their popup. They do
            // not masquerade as synchronized text in the panel.
            panelContent = trackInfo(this._state.metadata);
            this._currentLyricIndex = -1;
            this._indicator.setCurrentLyricIndex(-1);
        } else {
            this._currentLyricIndex = -1;
            this._indicator.setCurrentLyricIndex(-1);
        }

        if (panelContent) {
            let panelTimeline = null;
            if (panelContentIsLyric && currentLine &&
                Number.isFinite(lineEndMs) &&
                lineEndMs > currentLine.startMs) {
                let playbackRate = 1;
                const remainingLyricMs = lineEndMs - effectivePositionMs;
                if (this._state.playbackStatus === 'Playing' &&
                    remainingLyricMs > 0) {
                    const offsetMs = this._globalOffsetMs +
                        this._trackOffsetMs;
                    const wallRemainingMs = this._mprisManager
                        .getDelayUntilPositionUs(
                            (lineEndMs - offsetMs) * 1000);
                    if (Number.isFinite(wallRemainingMs) &&
                        wallRemainingMs > 0)
                        playbackRate = remainingLyricMs / wallRemainingMs;
                }
                panelTimeline = {
                    startMs: currentLine.startMs,
                    endMs: lineEndMs,
                    positionMs: effectivePositionMs,
                    playbackRate,
                };
            }
            this._indicator.setText(this._panelText(panelContent), {
                scrollable: panelContentIsLyric,
                timeline: panelTimeline,
                contentKey: panelContentKey,
            });
        }

        const hiddenWhilePaused =
            this._settings.get_boolean('hide-when-paused') &&
            this._state.playbackStatus === 'Paused';
        this._indicator.setVisible(Boolean(panelContent) && !hiddenWhilePaused);

        this._updateWordAndSchedule(effectivePositionMs);

        if (this._state.playbackStatus !== 'Playing' ||
            nextLineStartMs === null)
            return;

        const playbackTargetUs = (nextLineStartMs -
            this._globalOffsetMs - this._trackOffsetMs) * 1000;
        const delayMs = this._mprisManager
            .getDelayUntilPositionUs(playbackTargetUs);
        if (delayMs === null || !Number.isFinite(delayMs))
            return;

        this._lineTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(delayMs)),
            () => {
                this._lineTimerId = 0;
                if (this._enabled)
                    this._updateIndicatorAndSchedule();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(
            this._lineTimerId, '[mpris-lyrics] next lyric line');
    }

    _updateWordAndSchedule(effectivePositionMs = null) {
        this._stopWordTimer();
        if (!this._state || !this._indicator || !this._wordSyncEnabled ||
            !this._indicator.isPopupOpen() ||
            this._lyricsDocument?.syncLevel !== SyncLevel.WORD ||
            this._currentLyricIndex < 0 ||
            !this._indicator.isOriginalLineVisible(this._currentLyricIndex))
            return;

        const positionMs = effectivePositionMs ?? this._effectivePositionMs();
        const states = LyricsSynchronizer.wordStates(
            this._lyricsDocument, this._currentLyricIndex, positionMs);
        this._indicator.setCurrentWordStates(this._currentLyricIndex, states);

        if (this._state.playbackStatus !== 'Playing')
            return;
        const nextBoundaryMs = LyricsSynchronizer.nextWordBoundaryMs(
            this._lyricsDocument, this._currentLyricIndex, positionMs);
        if (nextBoundaryMs === null)
            return;

        const playbackTargetUs = (nextBoundaryMs -
            this._globalOffsetMs - this._trackOffsetMs) * 1000;
        const delayMs = this._mprisManager
            .getDelayUntilPositionUs(playbackTargetUs);
        if (delayMs === null || !Number.isFinite(delayMs))
            return;

        this._wordTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(delayMs)),
            () => {
                this._wordTimerId = 0;
                if (this._enabled)
                    this._updateWordAndSchedule();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(
            this._wordTimerId, '[mpris-lyrics] next lyric word boundary');
    }

    _panelText(content) {
        return content;
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
