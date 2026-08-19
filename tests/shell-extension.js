import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

import {ArtworkView} from '../artwork-view.js';
import {sourceLyricsHash} from '../translation-document.js';

const UUID = 'mpris-lyrics@eureka';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function takeScreenshot(path) {
    const file = Gio.File.new_for_path(path);
    const stream = await new Promise((resolve, reject) => {
        file.replace_async(
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                try {
                    resolve(source.replace_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
    const screenshot = new Shell.Screenshot();
    try {
        await new Promise((resolve, reject) => {
            screenshot.screenshot(false, stream, (source, result) => {
                try {
                    source.screenshot_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    } finally {
        await new Promise(resolve => {
            stream.close_async(GLib.PRIORITY_DEFAULT, null, () => resolve());
        });
    }
}

export async function run() {
    await Scripting.sleep(1000);

    const screenshotStyle = GLib.getenv('MPRIS_LYRICS_SCREENSHOT_STYLE');
    if (['prefer-light', 'prefer-dark'].includes(screenshotStyle)) {
        const appearanceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        appearanceSettings.set_string('color-scheme', screenshotStyle);
        await Scripting.sleep(300);
    }

    const extension = Main.extensionManager.lookup(UUID);
    assert(extension, 'the extension was not discovered');

    const indicator = Main.panel.statusArea[UUID];
    assert(indicator, 'the extension did not create its panel indicator');
    assert(!indicator.visible,
        'the indicator should be hidden without an MPRIS player');
    assert(indicator.reactive,
        'the indicator should be clickable');

    const instance = extension.stateObj;
    const view = instance._indicator;
    assert(view?.actor === indicator,
        'the extension should own the registered panel indicator');
    const settings = instance._settings;
    assert(settings.get_boolean('show-icon') &&
        settings.get_int('max-panel-width') === 500 &&
        !settings.get_boolean('hide-when-paused') &&
        settings.get_boolean('fallback-track-info') &&
        settings.get_boolean('word-sync-enabled') &&
        !settings.get_boolean('translation-enabled') &&
        settings.get_boolean('auto-translate') &&
        settings.get_string('translation-target-language') === 'zh-CN' &&
        settings.get_string('translation-provider') === 'openai' &&
        settings.get_string('translation-display-mode') === 'bilingual' &&
        settings.get_string('panel-lyrics-language') === 'original' &&
        settings.get_int('global-offset-ms') === 0 &&
        settings.get_string('preferred-player') === 'auto',
    'the packaged GSettings schema should expose the Phase 5 defaults');
    assert(view._panelBox.get_style().includes('500px') &&
        view._label.get_style().includes('476px') && view._icon.visible,
        'the default maximum panel width should apply immediately');

    const localArtwork = Gio.File.new_for_path(
        '/usr/share/pixmaps/faces/guitar2.jpg');
    view.setTrack({
        title: 'A deliberately very long title used to exercise ellipsizing',
        artist: 'Test Artist',
        album: 'Test Album',
        artUrl: localArtwork.get_uri(),
        durationUs: 220_000_000,
    }, 'shell-track-a');
    const lines = Array.from({length: 30}, (_unused, index) => ({
        lineId: `line-${index}`,
        startMs: index * 1000,
        endMs: null,
        words: [],
        text: `Synchronized lyric line ${index + 1} with wrapping text`,
    }));
    const lineDocument = {
        source: 'test',
        sourceId: null,
        instrumental: false,
        metadata: {},
        syncLevel: 'line',
        lines,
    };
    view.setLyrics(lineDocument);
    const originalRows = [...view._lyricRows];
    view.setCurrentLyricIndex(20);
    view.setText('Synchronized lyric line 21 with wrapping text');
    view.setProgress(119_000_000, 220_000_000);
    view.setVisible(true);
    await Scripting.sleep(1800);

    assert(view._titleLabel.text.startsWith('A deliberately'),
        'the popup should show the track title');
    assert(view._artistLabel.text === 'Test Artist',
        'the popup should show the artist');
    assert(view._albumLabel.text === 'Test Album' && view._albumLabel.visible,
        'the popup should show a present album');
    assert(view._artworkView._displayedTrackKey === 'shell-track-a' &&
        !view._artworkView._fallback.visible,
    'file:// artwork should decode asynchronously and replace its placeholder');

    const raceLoader = {
        load(url) {
            return new Promise(resolve => {
                GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    url.endsWith('/a') ? 180 : 20,
                    () => {
                        resolve({file: localArtwork, remote: false});
                        return GLib.SOURCE_REMOVE;
                    });
            });
        },
        discard() {},
        destroy() {},
    };
    const raceArtwork = new ArtworkView({loader: raceLoader});
    Main.uiGroup.add_child(raceArtwork.actor);
    raceArtwork.setArtwork('file:///delayed/a', 'track-a');
    raceArtwork.setArtwork('file:///fast/b', 'track-b');
    await Scripting.sleep(300);
    assert(raceArtwork._displayedTrackKey === 'track-b',
        'late artwork from track A must never overwrite track B');
    raceArtwork.destroy();

    assert(view._progressView._currentLabel.text === '1:59' &&
        view._progressView._durationLabel.text === '3:40' &&
        view._progressView.actor.visible,
    'the popup should format and display current playback progress');
    view.setProgress(999_000_000, 220_000_000);
    assert(view._progressView._currentLabel.text === '3:40' &&
        view._progressView._fraction === 1,
    'progress should clamp safely at track end');
    view.setProgress(119_000_000, 220_000_000);

    view.updateMetadataDisplay({
        title: 'A second deliberately long title that must stay inside the media header',
        artist: 'An exceptionally long artist name that must ellipsize instead of widening the popup',
        album: '',
    });
    assert(view._artistLabel.clutter_text.get_single_line_mode() &&
        !view._albumLabel.visible &&
        view._lyricRows.every((row, index) => row === originalRows[index]),
    'long or missing display metadata must not widen or rebuild the lyrics view');
    view.updateMetadataDisplay({
        title: 'A deliberately very long title used to exercise ellipsizing',
        artist: 'Test Artist',
        album: 'Test Album',
    });
    assert(view._lyricRows.length === lines.length,
        'the popup should create one row per parsed lyric entry');
    assert(view._lyricRows[20].has_style_class_name(
        'mpris-lyrics-line-active'),
        'the current lyric row should have the active class');
    assert(view._lyricRows[20].has_style_pseudo_class('selected'),
        'the current lyric row should use the native selected state');
    assert(view._label.text.startsWith('Synchronized lyric'),
        'the top-bar lyric should still update');

    view.setTranslationEnabled(true);
    view.setTranslation({lines: [{
        lineId: lines[20].lineId,
        text: '<b>安全译文</b> & مرحبا',
    }]});
    view.setTranslationState('available');
    assert(view._translationLabels[20].visible &&
        view._translationLabels[20].clutter_text.get_text() ===
            '<b>安全译文</b> & مرحبا' &&
        view._translationLabels[19].visible === false,
    'bilingual rows should align by line ID and treat translation as plain text');
    assert(view._lyricRows.every((row, index) => row === originalRows[index]),
        'translation arrival must not rebuild lyric rows');
    view.setTranslationDisplayMode('translated');
    assert(!view._lyricLabels[20].visible &&
        view._translationLabels[20].visible &&
        view._lyricLabels[19].visible,
    'translated-only mode should fall back to original for a missing line');
    view.setTranslationDisplayMode('bilingual');

    indicator.menu.open();
    await Scripting.sleep(500);
    assert(indicator.menu.isOpen,
        'the native PanelMenu popup should open');
    assert(instance._progressTimerId !== 0,
        'an open popup should run one low-frequency progress timer');
    assert(view._scrollView.vadjustment.value > 0,
        'opening the popup should scroll a later current row into view');
    const screenshotPath = GLib.getenv('MPRIS_LYRICS_SCREENSHOT_PATH');
    if (screenshotPath)
        await takeScreenshot(screenshotPath);

    view.setCurrentLyricIndex(21);
    await Scripting.sleep(100);
    assert(view._lyricRows.every((row, index) => row === originalRows[index]),
        'a lyric change must reuse the existing row objects');
    assert(!view._lyricRows[20].has_style_class_name(
        'mpris-lyrics-line-active'),
        'the previous row should lose the active class');
    assert(view._lyricRows[21].has_style_class_name(
        'mpris-lyrics-line-active'),
        'the new row should gain the active class');

    const markupText = '<b>safe</b> & שלום 世界!';
    const wordDocument = {
        source: 'test',
        sourceId: null,
        instrumental: false,
        metadata: {},
        syncLevel: 'word',
        lines: [{
            lineId: 'word-line-0',
            text: markupText,
            startMs: 0,
            endMs: 3000,
            words: [
                {text: '<b>safe</b> ', startMs: 0, endMs: 1000},
                {text: '& ', startMs: 1000, endMs: 1500},
                {text: 'שלום ', startMs: 1500, endMs: 2200},
                {text: '世界!', startMs: 2200, endMs: 3000},
            ],
        }],
    };
    view.setLyrics(wordDocument);
    view.setTranslation({lines: [{
        lineId: 'word-line-0',
        text: '逐词同步的行级译文',
    }]});
    view.setCurrentLyricIndex(0);
    view.setCurrentWordStates(0, ['past', 'current', 'future', 'future']);
    assert(view._lyricLabels[0].clutter_text.get_text() === markupText,
        'word highlighting must escape lyric text instead of injecting markup');
    const wordLabel = view._lyricLabels[0];
    const translatedWordLabel = view._translationLabels[0];
    view.setCurrentWordStates(0, ['past', 'past', 'current', 'future']);
    assert(view._lyricLabels[0] === wordLabel &&
        view._translationLabels[0] === translatedWordLabel &&
        translatedWordLabel.text === '逐词同步的行级译文',
    'a word change should update only the original current-line label');
    view.setTranslationDisplayMode('translated');
    assert(!view.isOriginalLineVisible(0),
        'translated-only mode should expose that original karaoke is hidden');
    view.setTranslationDisplayMode('bilingual');

    const longDocument = {
        ...lineDocument,
        syncLevel: 'none',
        lines: Array.from({length: 350}, (_unused, index) => ({
            lineId: `long-${index}`,
            text: `Static long-lyrics line ${index + 1}`,
            startMs: null,
            endMs: null,
            words: [],
        })),
    };
    const longLyricsStartUs = GLib.get_monotonic_time();
    view.setLyrics(longDocument);
    const longLyricsBuildMs =
        (GLib.get_monotonic_time() - longLyricsStartUs) / 1000;
    assert(view._lyricRows.length === 350 && longLyricsBuildMs < 1500,
        '350 static lines should build without an obvious Shell stall');
    print(`longLyricsBuildMs=${longLyricsBuildMs.toFixed(1)}`);

    const realMprisManager = instance._mprisManager;
    const realOffsetStore = instance._offsetStore;
    const realLyricsProvider = instance._lyricsProvider;
    const realTranslationService = instance._translationService;
    let runtimeCacheClears = 0;
    let lyricFetches = 0;
    instance._lyricsProvider = {
        clearCaches: async () => runtimeCacheClears++,
        cancelPending() {},
        fetch(_metadata, callback) {
            lyricFetches++;
            callback(lineDocument);
        },
    };
    let translationRequests = 0;
    let translationCacheClears = 0;
    instance._translationService = {
        cancelAll() {},
        clearCache: async () => translationCacheClears++,
        translate(document, request) {
            translationRequests++;
            request.onStatus?.({status: 'loading'});
            return Promise.resolve({
                status: 'available',
                fromCache: translationRequests > 1,
                document: {
                    version: 1,
                    trackKey: request.trackKey,
                    sourceLyricsHash: sourceLyricsHash(document),
                    sourceLanguage: 'en',
                    targetLanguage: request.targetLanguage,
                    provider: request.providerId,
                    model: 'mock-v1',
                    createdAt: new Date().toISOString(),
                    lines: document.lines
                        .filter(line => line.text)
                        .map(line => ({
                            lineId: line.lineId,
                            text: `[zh-CN] ${line.text}`,
                        })),
                },
            });
        },
        destroy() {},
    };
    const storedOffsets = new Map();
    instance._offsetStore = {
        get: metadata => storedOffsets.get(metadata.title) ?? 0,
        set: (metadata, value) => {
            if (value === 0)
                storedOffsets.delete(metadata.title);
            else
                storedOffsets.set(metadata.title, value);
            return value;
        },
        destroy() {},
    };
    const availablePlayers = [
        {
            stableId: 'desktop:firefox',
            displayName: 'Firefox',
            selected: true,
        },
        {
            stableId: 'desktop:vlc',
            displayName: 'VLC media player',
            selected: false,
        },
    ];
    let appliedPreference = 'auto';
    let fakePositionUs = 1_750_000;
    instance._mprisManager = {
        getPositionUs: () => fakePositionUs,
        getDelayUntilPositionUs: targetUs =>
            Math.max(1, (targetUs - fakePositionUs) / 1000),
        getPlayers: () => availablePlayers,
        setPreferredPlayer: value => (appliedPreference = value),
    };

    const stableMetadata = {
        trackId: '/org/mpris/MediaPlayer2/track/1',
        title: 'Stable Track',
        artist: 'Stable Artist',
        album: 'Stable Album',
        artUrl: '',
        durationUs: 220_000_000,
    };
    instance._onPlayerStateChanged({
        busName: 'org.mpris.MediaPlayer2.test',
        playbackStatus: 'Paused',
        positionUs: 0,
        metadata: stableMetadata,
    });
    const stableRows = [...view._lyricRows];
    instance._onPlayerStateChanged({
        busName: 'org.mpris.MediaPlayer2.test',
        playbackStatus: 'Paused',
        positionUs: 0,
        metadata: {...stableMetadata, artUrl: localArtwork.get_uri()},
    });
    instance._onPlayerStateChanged({
        busName: 'org.mpris.MediaPlayer2.test',
        playbackStatus: 'Paused',
        positionUs: 0,
        metadata: {...stableMetadata, album: 'Corrected Album',
            artUrl: localArtwork.get_uri()},
    });
    assert(lyricFetches === 1 &&
        view._lyricRows.every((row, index) => row === stableRows[index]) &&
        view._albumLabel.text === 'Corrected Album',
    'artUrl and display-only metadata changes must not refetch or rebuild lyrics');

    const offsetMetadata = {
        title: 'Offset Test',
        artist: 'Paused Artist',
        album: 'Synchronization',
        durationUs: 180_000_000,
    };
    const offsetLines = [
        {lineId: 'offset-0', startMs: 1000, endMs: null, words: [], text: 'First'},
        {lineId: 'offset-1', startMs: 2000, endMs: null, words: [], text: 'Second'},
        {lineId: 'offset-2', startMs: 3000, endMs: null, words: [], text: 'Third'},
    ];
    const offsetDocument = {
        source: 'test',
        sourceId: null,
        instrumental: false,
        metadata: {},
        syncLevel: 'line',
        lines: offsetLines,
    };
    instance._state = {
        playbackStatus: 'Paused',
        metadata: offsetMetadata,
    };
    instance._lyricsDocument = offsetDocument;
    instance._currentTrackKey = 'offset-test-key';
    instance._lyricsLoaded = true;
    instance._trackOffsetMs = 0;
    instance._currentLyricIndex = -1;

    instance._state = {
        playbackStatus: 'Playing',
        metadata: offsetMetadata,
    };
    instance._lyricsDocument = wordDocument;
    view.setTrack(offsetMetadata);
    view.setLyrics(wordDocument);
    instance._updateIndicatorAndSchedule(true);
    assert(instance._wordTimerId !== 0 && view._label.text === markupText,
        'an open popup should arm one next-boundary word timer');
    fakePositionUs = 2_250_000;
    instance._updateWordAndSchedule();
    assert(view._label.text === markupText,
        'word changes must not update the top-bar label');
    indicator.menu.close();
    assert(instance._wordTimerId === 0 && instance._progressTimerId === 0,
        'closing the popup should stop word and progress timers immediately');
    indicator.menu.open();
    assert(instance._wordTimerId !== 0 && instance._progressTimerId !== 0,
        'opening the popup should re-arm word and progress updates');

    fakePositionUs = 1_750_000;
    view.setTrack(offsetMetadata);
    view.setLyrics(offsetDocument);
    instance._state = {
        playbackStatus: 'Paused',
        metadata: offsetMetadata,
    };
    instance._lyricsDocument = offsetDocument;
    instance._updateIndicatorAndSchedule(true);
    assert(instance._wordTimerId === 0,
        'pause should cancel the word timer');
    const offsetRows = [...view._lyricRows];
    instance._updateIndicatorAndSchedule(true);
    assert(instance._currentLyricIndex === 0,
        'the paused position should select the first lyric');
    view._increaseButton.emit('clicked', 1);
    assert(instance._trackOffsetMs === 500 &&
        view._offsetLabel.text === '+0.5 s',
        'popup buttons should adjust the current track offset');
    assert(instance._currentLyricIndex === 1 &&
        view._label.text === 'Second',
        'a positive track offset should immediately advance the paused lyric');
    instance._setTrackOffsetMs(-1000);
    assert(instance._currentLyricIndex === -1,
        'a negative offset should immediately move before the first lyric');
    instance._setTrackOffsetMs(100_000);
    assert(instance._trackOffsetMs === 10_000,
        'a track offset should clamp to +10 seconds');
    view._resetButton.emit('clicked', 1);
    assert(instance._currentLyricIndex === 0 &&
        view._lyricRows.every((row, index) => row === offsetRows[index]),
        'offset recalculation should keep and reuse the lyric row objects');

    instance._setTrackOffsetMs(1000);
    const secondMetadata = {...offsetMetadata, title: 'Offset Test B'};
    instance._state.metadata = secondMetadata;
    instance._trackOffsetMs = instance._offsetStore.get(secondMetadata);
    assert(instance._trackOffsetMs === 0,
        'track B should keep an independent zero offset');
    instance._state.metadata = offsetMetadata;
    instance._trackOffsetMs = instance._offsetStore.get(offsetMetadata);
    assert(instance._trackOffsetMs === 1000,
        'returning to track A should restore its offset');
    instance._setTrackOffsetMs(0);

    settings.set_int('global-offset-ms', 500);
    assert(instance._globalOffsetMs === 500 &&
        instance._currentLyricIndex === 1 &&
        view._effectiveOffsetLabel.text.includes('Effective +0.5 s'),
    'a GSettings global offset change should immediately resynchronize');
    settings.set_int('global-offset-ms', 0);

    settings.set_boolean('show-icon', false);
    assert(view._label.text === 'First' && !view._icon.visible &&
        view._label.get_style().includes('500px'),
    'show-icon should hide only the symbolic icon and release its width');
    settings.set_boolean('show-icon', true);
    assert(view._label.text === 'First' && view._icon.visible &&
        view._label.get_style().includes('476px'),
    'show-icon should restore the symbolic icon without changing lyric text');

    settings.set_boolean('word-sync-enabled', false);
    assert(!instance._wordSyncEnabled && instance._wordTimerId === 0,
        'disabling word sync should immediately stop its boundary timer');
    settings.set_boolean('word-sync-enabled', true);

    view.setLyrics(offsetDocument);
    instance._lyricsDocument = offsetDocument;
    instance._currentTrackKey = 'offset-test-key';
    settings.set_boolean('translation-enabled', true);
    await Scripting.sleep(50);
    assert(translationRequests === 1 &&
        view._translationLabels[0].text === '[zh-CN] First' &&
        view._translationLabels[0].visible,
    'enabling translation should apply line-aligned bilingual text without rebuilding rows');
    settings.set_string('panel-lyrics-language', 'translated');
    assert(view._label.text === '[zh-CN] First',
        'the panel should use a loaded translation when requested');
    settings.set_string('translation-display-mode', 'translated');
    assert(!view._lyricLabels[0].visible &&
        instance._wordTimerId === 0,
    'translated-only popup mode should not run original word updates');
    settings.set_string('translation-display-mode', 'bilingual');
    view._translationActionButton.emit('clicked', 1);
    await Scripting.sleep(50);
    assert(translationRequests === 2,
        'the popup Refresh action should issue one forced translation request');
    settings.set_int('translation-cache-clear-generation', 1);
    await Scripting.sleep(50);
    assert(translationCacheClears === 1 && translationRequests === 3,
        'translation cache clearing should remain separate and reload automatically');
    settings.set_string('panel-lyrics-language', 'original');
    settings.set_boolean('translation-enabled', false);
    assert(!view._translationItem.visible && view._label.text === 'First',
        'disabling translation should restore exact Phase 4 panel behavior');

    settings.set_int('max-panel-width', 640);
    assert(view._panelBox.get_style().includes('640px') &&
        view._label.get_style().includes('616px'),
        'maximum panel width should update without extension restart');
    settings.set_int('max-panel-width', 500);

    settings.set_boolean('hide-when-paused', true);
    assert(!indicator.visible,
        'hide-when-paused should immediately hide a paused track');
    settings.set_boolean('hide-when-paused', false);
    assert(indicator.visible,
        'disabling hide-when-paused should immediately restore the item');

    view.setPlayers(availablePlayers, 'auto');
    assert(view._playerMenu.menu.numMenuItems === 3 &&
        view._playerMenu.label.text === 'Player: Firefox',
    'the popup should list Auto and only currently available stable players');
    view._playerMenu.menu._getMenuItems()[1].activate(null);
    assert(settings.get_string('preferred-player') === 'desktop:firefox' &&
        appliedPreference === 'desktop:firefox',
    'selecting a popup player should update GSettings and backend policy');
    settings.set_string('preferred-player', 'auto');

    settings.set_int('cache-clear-generation', 1);
    await Scripting.sleep(50);
    assert(runtimeCacheClears === 1,
        'cache generation changes should clear the running L1/L2 instance');

    instance._lyricsDocument = null;
    instance._lyricsLoaded = true;
    view.setLyrics(null);
    instance._updateIndicatorAndSchedule(true);
    assert(indicator.visible && view._label.text === 'Offset Test — Paused Artist',
        'fallback track information should remain visible by default');
    settings.set_boolean('fallback-track-info', false);
    assert(!indicator.visible,
        'disabling fallback information should hide a no-lyrics indicator');
    settings.set_boolean('fallback-track-info', true);
    assert(indicator.visible,
        're-enabling fallback information should restore the indicator');

    const plainDocument = {
        source: 'test-plain',
        sourceId: null,
        instrumental: false,
        metadata: {},
        syncLevel: 'none',
        lines: [{
            lineId: 'plain-0',
            text: 'Static lyrics',
            startMs: null,
            endMs: null,
            words: [],
        }],
    };
    instance._lyricsDocument = plainDocument;
    view.setLyrics(plainDocument);
    settings.set_boolean('fallback-track-info', false);
    assert(indicator.visible && instance._currentLyricIndex === -1 &&
        view._label.text === 'Offset Test — Paused Artist',
    'plain lyrics should keep a static popup entry without pretending to sync');
    settings.set_boolean('fallback-track-info', true);
    instance._lyricsDocument = null;

    view.setTrack({
        title: 'No Lyrics Track',
        artist: 'Another Artist',
        album: '',
        artUrl: 'invalid://artwork',
        durationUs: 0,
    }, 'no-artwork-track');
    view.setLyrics(null);
    assert(view._lyricRows.length === 0 &&
        view._messageLabel.text === 'No lyrics found',
        'the popup should show the no-lyrics result');
    assert(!view._albumLabel.visible,
        'an absent album should not leave an empty metadata row');
    assert(view._artworkView._fallback.visible,
        'invalid artwork should retain the symbolic fallback');
    view.setArtwork(Gio.File.new_for_path('/etc/hostname').get_uri(),
        'invalid-image-track');
    await Scripting.sleep(3200);
    assert(view._artworkView._fallback.visible &&
        !view._artworkView._textureActor,
    'a decode failure should time out to fallback without a broken image');
    assert(view._titleLabel.text === 'No Lyrics Track' &&
        view._artistLabel.text === 'Another Artist',
        'the no-lyrics state should retain title and artist');

    instance._state = null;
    instance._lyricsDocument = null;
    instance._mprisManager = realMprisManager;
    instance._offsetStore = realOffsetStore;
    instance._lyricsProvider = realLyricsProvider;
    instance._translationService = realTranslationService;

    indicator.menu.close();

    assert(Main.extensionManager.disableExtension(UUID),
        'the extension could not be disabled');

    await Scripting.sleep(500);
    assert(!Main.panel.statusArea[UUID],
        'disable() did not destroy the panel indicator');
    assert(instance._settings === null &&
        instance._settingsSignalIds.length === 0 &&
        instance._lineTimerId === 0 && instance._wordTimerId === 0 &&
        instance._progressTimerId === 0 &&
        instance._translationService === null,
    'disable() should disconnect settings and destroy timers/translation service');

    assert(Main.extensionManager.enableExtension(UUID),
        'the extension could not be re-enabled after cleanup');
    await Scripting.sleep(500);
    assert(Main.panel.statusArea[UUID],
        're-enable should recreate the panel indicator');
    assert(Main.extensionManager.disableExtension(UUID),
        'the re-enabled extension could not be disabled cleanly');
}

export function finish() {
    print('GNOME Shell bilingual popup, settings, timers and lifecycle test passed');
}
