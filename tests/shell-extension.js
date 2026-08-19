import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'mpris-lyrics@eureka';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

export async function run() {
    await Scripting.sleep(1000);

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
        settings.get_int('global-offset-ms') === 0 &&
        settings.get_string('preferred-player') === 'auto',
    'the packaged GSettings schema should expose the Phase 3 defaults');
    assert(view._label.get_style().includes('500px'),
        'the default maximum panel width should apply immediately');

    view.setTrack({
        title: 'A deliberately very long title used to exercise ellipsizing',
        artist: 'Test Artist',
        album: 'Test Album',
    });
    const lines = Array.from({length: 30}, (_unused, index) => ({
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
    view.setText('♪ Synchronized lyric line 21 with wrapping text');
    view.setVisible(true);

    assert(view._titleLabel.text.startsWith('A deliberately'),
        'the popup should show the track title');
    assert(view._artistLabel.text === 'Test Artist',
        'the popup should show the artist');
    assert(view._albumLabel.text === 'Test Album' && view._albumLabel.visible,
        'the popup should show a present album');
    assert(view._lyricRows.length === lines.length,
        'the popup should create one row per parsed lyric entry');
    assert(view._lyricRows[20].has_style_class_name(
        'mpris-lyrics-line-active'),
        'the current lyric row should have the active class');
    assert(view._lyricRows[20].has_style_pseudo_class('selected'),
        'the current lyric row should use the native selected state');
    assert(view._label.text.startsWith('♪ Synchronized lyric'),
        'the top-bar lyric should still update');

    indicator.menu.open();
    await Scripting.sleep(500);
    assert(indicator.menu.isOpen,
        'the native PanelMenu popup should open');
    assert(view._scrollView.vadjustment.value > 0,
        'opening the popup should scroll a later current row into view');

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
    view.setCurrentLyricIndex(0);
    view.setCurrentWordStates(0, ['past', 'current', 'future', 'future']);
    assert(view._lyricLabels[0].clutter_text.get_text() === markupText,
        'word highlighting must escape lyric text instead of injecting markup');
    const wordLabel = view._lyricLabels[0];
    view.setCurrentWordStates(0, ['past', 'past', 'current', 'future']);
    assert(view._lyricLabels[0] === wordLabel,
        'a word change should update only the current line label');

    const longDocument = {
        ...lineDocument,
        syncLevel: 'none',
        lines: Array.from({length: 350}, (_unused, index) => ({
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
    let runtimeCacheClears = 0;
    instance._lyricsProvider = {
        clearCaches: async () => runtimeCacheClears++,
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
    const offsetMetadata = {
        title: 'Offset Test',
        artist: 'Paused Artist',
        album: 'Synchronization',
        durationUs: 180_000_000,
    };
    const offsetLines = [
        {startMs: 1000, endMs: null, words: [], text: 'First'},
        {startMs: 2000, endMs: null, words: [], text: 'Second'},
        {startMs: 3000, endMs: null, words: [], text: 'Third'},
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
    assert(instance._wordTimerId !== 0 && view._label.text === `♪ ${markupText}`,
        'an open popup should arm one next-boundary word timer');
    fakePositionUs = 2_250_000;
    instance._updateWordAndSchedule();
    assert(view._label.text === `♪ ${markupText}`,
        'word changes must not update the top-bar label');
    indicator.menu.close();
    assert(instance._wordTimerId === 0,
        'closing the popup should stop the word timer immediately');
    indicator.menu.open();
    assert(instance._wordTimerId !== 0,
        'opening the popup should recompute and re-arm the current word');

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
        view._offsetLabel.text === 'Track Offset +0.5s',
        'popup buttons should adjust the current track offset');
    assert(instance._currentLyricIndex === 1 &&
        view._label.text === '♪ Second',
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
        view._effectiveOffsetLabel.text.includes('Effective +0.5s'),
    'a GSettings global offset change should immediately resynchronize');
    settings.set_int('global-offset-ms', 0);

    settings.set_boolean('show-icon', false);
    assert(view._label.text === 'First',
        'show-icon should immediately remove only the music note');
    settings.set_boolean('show-icon', true);
    assert(view._label.text === '♪ First',
        'show-icon should immediately restore the music note');

    settings.set_boolean('word-sync-enabled', false);
    assert(!instance._wordSyncEnabled && instance._wordTimerId === 0,
        'disabling word sync should immediately stop its boundary timer');
    settings.set_boolean('word-sync-enabled', true);

    settings.set_int('max-panel-width', 640);
    assert(view._label.get_style().includes('640px'),
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
    assert(indicator.visible && view._label.text === '♪ Offset Test — Paused Artist',
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
        lines: [{text: 'Static lyrics', startMs: null, endMs: null, words: []}],
    };
    instance._lyricsDocument = plainDocument;
    view.setLyrics(plainDocument);
    settings.set_boolean('fallback-track-info', false);
    assert(indicator.visible && instance._currentLyricIndex === -1 &&
        view._label.text === '♪ Offset Test — Paused Artist',
    'plain lyrics should keep a static popup entry without pretending to sync');
    settings.set_boolean('fallback-track-info', true);
    instance._lyricsDocument = null;

    view.setTrack({title: 'No Lyrics Track', artist: 'Another Artist', album: ''});
    view.setLyrics(null);
    assert(view._lyricRows.length === 0 &&
        view._messageLabel.text === 'No lyrics found',
        'the popup should show the no-lyrics result');
    assert(!view._albumLabel.visible,
        'an absent album should not leave an empty metadata row');
    assert(view._titleLabel.text === 'No Lyrics Track' &&
        view._artistLabel.text === 'Another Artist',
        'the no-lyrics state should retain title and artist');

    instance._state = null;
    instance._lyricsDocument = null;
    instance._mprisManager = realMprisManager;
    instance._offsetStore = realOffsetStore;
    instance._lyricsProvider = realLyricsProvider;

    indicator.menu.close();

    assert(Main.extensionManager.disableExtension(UUID),
        'the extension could not be disabled');

    await Scripting.sleep(500);
    assert(!Main.panel.statusArea[UUID],
        'disable() did not destroy the panel indicator');
    assert(instance._settings === null &&
        instance._settingsSignalIds.length === 0 &&
        instance._lineTimerId === 0 && instance._wordTimerId === 0,
    'disable() should disconnect settings and remove line/word timers');
}

export function finish() {
    print('GNOME Shell settings, popup, players, offsets and lifecycle test passed');
}
