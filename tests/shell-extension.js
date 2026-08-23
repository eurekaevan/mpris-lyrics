import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

import {ArtworkView} from '../artwork-view.js';
import {sourceLyricsHash} from '../translation-document.js';

const UUID = 'mpris-lyrics@eureka';
const EFFECTIVE_LOCALE = GLib.getenv('LC_ALL') ??
    GLib.getenv('LANGUAGE') ?? GLib.getenv('LANG') ?? '';
const SIMPLIFIED_CHINESE = EFFECTIVE_LOCALE.startsWith('zh_CN');
const uiText = (english, chinese) => SIMPLIFIED_CHINESE ? chinese : english;

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
    assert(extension.metadata.url ===
        'https://github.com/eurekaevan/mpris-lyrics' &&
        extension.metadata['gettext-domain'] === UUID &&
        !Object.hasOwn(extension.metadata, 'version'),
    'the packaged metadata should expose URL/gettext and omit deprecated version');

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
        settings.get_string('panel-position') === 'center' &&
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
    assert(view._panelBox.natural_width === 320 &&
        view._panelBox.natural_width_set &&
        !view._panelBox.get_style().includes('width: 320px') &&
        view._panelBox.get_style().includes('max-width: 500px') &&
        view._labelViewport.get_style().includes('298px') &&
        view._labelViewport.clip_to_allocation && view._icon.visible &&
        Main.panel._centerBox.contains(indicator.container),
        'the default preferred and maximum panel widths should apply immediately');

    const assertPanelPosition = (value, panelBox, expectedIndex) => {
        settings.set_string('panel-position', value);
        assert(indicator.container.get_parent() === panelBox &&
            panelBox.get_child_at_index(expectedIndex(panelBox)) ===
                indicator.container,
        `panel-position ${value} should move the existing indicator container`);
    };
    assertPanelPosition('far-left', Main.panel._leftBox, () => 0);
    assertPanelPosition('left', Main.panel._leftBox,
        box => box.get_n_children() - 1);
    assertPanelPosition('right', Main.panel._rightBox, () => 0);
    assertPanelPosition('far-right', Main.panel._rightBox,
        box => box.get_n_children() - 1);
    assertPanelPosition('center', Main.panel._centerBox, () => 0);

    const localArtwork = Gio.File.new_for_path(
        '/usr/share/pixmaps/faces/guitar2.jpg');
    view.setTrack({
        title: 'A deliberately very long title used to exercise ellipsizing',
        artist: 'Test Artist',
        album: 'Test Album',
        artUrl: localArtwork.get_uri(),
        durationUs: 220_000_000,
    }, 'shell-track-a');
    assert(view._messageLabel.text ===
        uiText('Loading lyrics…', '正在加载歌词…'),
        'a track change should show the restrained loading state');
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
    let originalRows = [...view._lyricRows];
    view.setCurrentLyricIndex(20);
    view.setText('Synchronized lyric line 21 with wrapping text');
    view.setProgress(119_000_000, 220_000_000);
    view.setVisible(true);
    await Scripting.sleep(1800);

    const panelMetrics = async text => {
        view.setText(text);
        await Scripting.sleep(180);
        const [x] = view._panelBox.get_transformed_position();
        const [iconX] = view._icon.get_transformed_position();
        return {
            width: view._panelBox.width,
            center: x + view._panelBox.width / 2,
            iconX,
        };
    };
    const shortPanel = await panelMetrics('Hello');
    const longPanel = await panelMetrics(
        'This is an extremely long synchronized lyric line that must ellipsize');
    const finalShortPanel = await panelMetrics('I know');
    print(`panelWidths=${shortPanel.width.toFixed(1)},` +
        `${longPanel.width.toFixed(1)},${finalShortPanel.width.toFixed(1)}`);
    print(`panelCenterDelta=${(longPanel.center - shortPanel.center).toFixed(1)},` +
        `iconDelta=${(longPanel.iconX - shortPanel.iconX).toFixed(1)}`);
    assert(shortPanel.width === 320 && longPanel.width === shortPanel.width &&
        Math.abs(finalShortPanel.width - shortPanel.width) < 1 &&
        Math.abs(finalShortPanel.center - shortPanel.center) < 1 &&
        Math.abs(longPanel.iconX - shortPanel.iconX) < 1,
    'short and long panel lyrics should keep a stable width, center, and icon');

    settings.set_string('panel-position', 'far-left');
    const centerConstraint = new St.Widget({
        width: Math.round(Main.layoutManager.primaryMonitor.width * 0.65),
    });
    Main.panel._centerBox.add_child(centerConstraint);
    view.setText(
        'A long lyric must yield before it reaches the centered date control');
    await Scripting.sleep(300);
    const [panelX] = view._panelBox.get_transformed_position();
    const [centerX] = Main.panel._centerBox.get_transformed_position();
    print(`constrainedLeftPanel=${view._panelBox.width.toFixed(1)},` +
        `gap=${(centerX - panelX - view._panelBox.width).toFixed(1)}`);
    assert(view._panelBox.width < shortPanel.width &&
        panelX + view._panelBox.width <= centerX + 0.5,
    'a side-positioned lyric should shrink before the centered panel area');

    settings.set_string('panel-position', 'far-right');
    await Scripting.sleep(300);
    const [rightPanelX] = view._panelBox.get_transformed_position();
    const [rightCenterX] = Main.panel._centerBox.get_transformed_position();
    const centerRight = rightCenterX + Main.panel._centerBox.width;
    print(`constrainedRightPanel=${view._panelBox.width.toFixed(1)},` +
        `gap=${(rightPanelX - centerRight).toFixed(1)}`);
    assert(view._panelBox.width < shortPanel.width &&
        rightPanelX >= centerRight - 0.5,
    'a right-positioned lyric should shrink after the centered panel area');

    centerConstraint.destroy();
    settings.set_string('panel-position', 'center');
    view.setText('Synchronized lyric line 21 with wrapping text');
    await Scripting.sleep(300);

    const panningText =
        'This synchronized lyric is deliberately long enough to pan from its beginning all the way to its ending';
    const panelTimeline = (endMs, positionMs = 0, playbackRate = 1) => ({
        startMs: 0,
        endMs,
        positionMs,
        playbackRate,
    });
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(5000),
    });
    view.setProgress(119_000_000, 220_000_000, {
        playing: true,
        immediate: true,
    });
    await Scripting.sleep(950);
    const firstPanX = view._panelPanLabel.translation_x;
    const [, panNaturalWidth] =
        view._panelPanLabel.get_preferred_width(-1);
    print(`panelPanWidths=natural:${panNaturalWidth.toFixed(1)},` +
        `actor:${view._panelPanLabel.width.toFixed(1)},` +
        `viewport:${view._labelViewport.width.toFixed(1)}`);
    assert(view._panelPanLabel.visible && !view._label.visible &&
        firstPanX < 0 &&
        Math.abs(view._panelPanLabel.width - panNaturalWidth) < 0.5 &&
        view._panelPanLabel.width > view._labelViewport.width &&
        view._panelPanLabel.get_transition('translation-x'),
    'an overflowing synchronized lyric should pan at full width inside its clipped viewport');
    view._pausePanelPan();
    await Scripting.sleep(180);
    const pausedPanX = view._panelPanLabel.translation_x;
    assert(Math.abs(pausedPanX - firstPanX) < 0.5,
        'hover-style pause should freeze the panel lyric pan in place');
    view._resumePanelPan();
    await Scripting.sleep(180);
    assert(view._panelPanLabel.translation_x < pausedPanX,
        'leaving hover should resume the panel lyric pan');
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(5000),
        contentKey: 'repeated-line-2',
    });
    assert(view._panelPanLabel.translation_x === 0 &&
        !view._panelPanLabel.visible && view._label.visible,
    'a repeated lyric with a new line ID should still reset the old panel pan');
    view.setText('The next line', {
        scrollable: true,
        timeline: panelTimeline(3000),
    });
    assert(view._panelPanLabel.translation_x === 0 &&
        !view._panelPanLabel.visible && view._label.visible,
    'a line change should cancel the old panel pan and reset to the new start');
    view.setText(panningText, {scrollable: false});
    await Scripting.sleep(120);
    assert(!view._panelPanLabel.visible && view._label.visible,
        'fallback track information should remain ellipsized without panning');
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(1800),
        contentKey: 'full-ending',
    });
    await Scripting.sleep(1520);
    const [panEndX] = view._panelPanLabel.get_transformed_position();
    const [viewportEndX] = view._labelViewport.get_transformed_position();
    const panRight = panEndX + view._panelPanLabel.width;
    const viewportRight = viewportEndX + view._labelViewport.width;
    print(`panelPanEndDelta=${(panRight - viewportRight).toFixed(1)}`);
    assert(view._panelPanLabel.clutter_text.get_text() === panningText &&
        Math.abs(panRight - viewportRight) <= 1.5,
    'the completed panel pan should reveal the exact full lyric ending');

    view.setProgress(119_000_000, 220_000_000, {playing: false});
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(5000, 3000),
        contentKey: 'seek-position',
    });
    await Scripting.sleep(100);
    const seekOverflow = panNaturalWidth - view._labelViewport.width;
    const expectedSeekX = -seekOverflow * ((3000 - 600) / 3400);
    print(`panelPanSeekDelta=${(
        view._panelPanLabel.translation_x - expectedSeekX).toFixed(1)}`);
    assert(view._panelPanLabel.visible &&
        !view._panelPanLabel.get_transition('translation-x') &&
        Math.abs(view._panelPanLabel.translation_x - expectedSeekX) <= 1.5,
    'a paused seek should immediately anchor the panel pan to lyric time');

    view.setProgress(119_000_000, 220_000_000, {playing: false});
    view.setText('Synchronized lyric line 21 with wrapping text');

    assert(view._titleLabel.text.startsWith('A deliberately'),
        'the popup should show the track title');
    assert(view._artistLabel.text === 'Test Artist',
        'the popup should show the artist');
    assert(view._albumLabel.text === 'Test Album' && view._albumLabel.visible,
        'the popup should show a present album');
    assert(view._artworkView._displayedTrackKey === 'shell-track-a' &&
        view._artworkView.actor.width === 80 &&
        view._artworkView.actor.height === 80 &&
        !view._artworkView._fallback.visible,
    'the compact file:// artwork should decode and replace its matching placeholder');

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
    await Scripting.sleep(80);
    assert(raceArtwork._displayedTrackKey === 'track-b',
        'late artwork from track A must never overwrite track B');
    const oldArtworkActor = raceArtwork._textureActor;
    raceArtwork.setArtwork('file:///delayed/a', 'track-c');
    await Scripting.sleep(60);
    assert(raceArtwork._textureActor === oldArtworkActor &&
        !raceArtwork._fallback.visible,
    'a delayed replacement should retain old artwork instead of flashing fallback');
    await Scripting.sleep(150);
    assert(raceArtwork._displayedTrackKey === 'track-c' &&
        raceArtwork._textureActor !== oldArtworkActor &&
        raceArtwork._outgoingTextureActor === oldArtworkActor,
    'decoded artwork should crossfade from the retained texture');
    await Scripting.sleep(250);
    assert(!raceArtwork._outgoingTextureActor,
        'a completed artwork crossfade should release the old texture');
    raceArtwork.destroy();

    const reducedArtwork = new ArtworkView({
        loader: raceLoader,
        animationsEnabled: () => false,
    });
    Main.uiGroup.add_child(reducedArtwork.actor);
    reducedArtwork.setArtwork('file:///fast/b', 'reduced-a');
    await Scripting.sleep(80);
    reducedArtwork.setArtwork('file:///fast/b', 'reduced-b');
    await Scripting.sleep(80);
    assert(reducedArtwork._displayedTrackKey === 'reduced-b' &&
        !reducedArtwork._outgoingTextureActor,
    'reduced motion should replace ready artwork without crossfade');
    reducedArtwork.destroy();

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
        !view._albumLabel.visible && view._albumLabel.text === '' &&
        view._lyricRows.every((row, index) => row === originalRows[index]),
    'long or missing metadata must hide the empty album without rebuilding lyrics');
    view.updateMetadataDisplay({
        title: 'A deliberately very long title used to exercise ellipsizing',
        artist: 'Test Artist',
        album: 'Test Album',
    });
    assert(view._lyricRows.length === lines.length,
        'the popup should create one row per parsed lyric entry');
    assert(view._lyricRows[20].has_style_class_name(
        'mpris-lyrics-line-current') && view._lyricRows[20].opacity === 255 &&
        view._lyricRows[19].has_style_class_name('mpris-lyrics-line-near') &&
        view._lyricRows[18].has_style_class_name('mpris-lyrics-line-mid') &&
        view._lyricRows[17].has_style_class_name('mpris-lyrics-line-far'),
    'the current lyric should drive centralized distance-based visual levels');
    assert(!view._lyricRows[20].has_style_pseudo_class('selected'),
        'lyric focus must not depend on a card-like selected background');
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
    view.setTranslationState('network_error');
    assert(view._translationStatusLabel.text ===
        uiText('Translation network error', '翻译网络错误'),
        'translation failure should remain a compact secondary state');
    view.setTranslationState('available');
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
    const [trackX] = view._progressView._track.get_transformed_position();
    const [fillX] = view._progressView._fill.get_transformed_position();
    assert(Math.abs(fillX - trackX) < 0.5,
        'playback progress fill should stay anchored to the start of the track');
    assert(instance._progressTimerId !== 0,
        'an open popup should run one low-frequency progress timer');
    assert(view._scrollView.vadjustment.value > 0,
        'opening the popup should scroll a later current row into view');
    const anchorRow = view._lyricRows[20];
    const [, anchorY] = anchorRow.get_transformed_position();
    view.setTranslation({
        lines: lines.map((line, index) => ({
            lineId: line.lineId,
            text: index === 20
                ? '第 21 行安全译文 · مرحبا'
                : `第 ${index + 1} 行译文`,
        })),
    });
    await Scripting.sleep(120);
    const [, anchoredY] = anchorRow.get_transformed_position();
    print(`translationAnchorDelta=${(anchoredY - anchorY).toFixed(1)}`);
    assert(view._lyricRows.every((row, index) => row === originalRows[index]) &&
        Math.abs(anchoredY - anchorY) < 1.5,
    'late translation should update existing rows and preserve the current line position');

    const popupWidth = view.actor.menu.box.width;
    const headerHeight = view._artworkView.actor.get_parent().height;
    print(`mediaHeader=${headerHeight.toFixed(1)},` +
        `artwork=${view._artworkView.actor.width.toFixed(1)}x` +
        `${view._artworkView.actor.height.toFixed(1)}`);
    view.updateMetadataDisplay({title: 'Short', artist: 'Artist', album: ''});
    await Scripting.sleep(80);
    view.updateMetadataDisplay({
        title: 'An extremely long title that deliberately wraps across the full two-line title allowance',
        artist: 'An artist name long enough to require ellipsizing',
        album: 'An album name long enough to require ellipsizing',
    });
    await Scripting.sleep(80);
    assert(headerHeight === 80 && view.actor.menu.box.width === popupWidth &&
        view._artworkView.actor.get_parent().height === headerHeight,
    'short, long, and missing metadata should keep popup/header geometry stable');
    view.updateMetadataDisplay({
        title: 'A deliberately very long title used to exercise ellipsizing',
        artist: 'Test Artist',
        album: 'Test Album',
    });

    view.setProgress(60_000_000, 220_000_000, {
        playing: true,
        immediate: true,
    });
    await Scripting.sleep(520);
    view.setProgress(60_500_000, 220_000_000, {playing: true});
    assert(view._progressView._animateFill,
        'normal playing progress should interpolate between 500ms updates');
    view.setProgress(150_000_000, 220_000_000, {playing: true});
    assert(!view._progressView._animateFill,
        'a seek-sized progress jump should cancel interpolation and reposition');
    view.setProgress(150_000_000, 220_000_000, {playing: false});
    assert(!view._progressView._animateFill,
        'paused progress should remain fixed without an active interpolation');
    view.setProgress(119_000_000, 220_000_000, {immediate: true});
    await Scripting.sleep(80);
    assert(Math.abs(view._progressView._fill.scale_x - 119 / 220) < 0.0001 &&
        Math.abs(view._progressView._fill.width -
            view._progressView._track.width) < 0.5,
        'an immediate progress update should cancel old fraction transitions');

    view.setPlayers([{
        stableId: 'desktop:firefox',
        displayName: 'Mozilla Firefox',
        selected: true,
    }], 'auto');
    assert(view._playerMenu.label.clutter_text.get_text() ===
        uiText('Player   Mozilla Firefox', '播放器   Mozilla Firefox'),
    'the native player submenu row should separate its secondary label and value');

    const screenshotPath = GLib.getenv('MPRIS_LYRICS_SCREENSHOT_PATH');
    const screenshotKind = GLib.getenv('MPRIS_LYRICS_SCREENSHOT_KIND') ??
        'bilingual';
    const screenshotPanelText = GLib.getenv(
        'MPRIS_LYRICS_SCREENSHOT_PANEL_TEXT');
    const screenshotPanelPosition = GLib.getenv(
        'MPRIS_LYRICS_SCREENSHOT_PANEL_POSITION');
    if (screenshotPanelPosition)
        settings.set_string('panel-position', screenshotPanelPosition);
    if (screenshotPanelText) {
        view.setText(screenshotPanelText);
        await Scripting.sleep(180);
    }
    if (screenshotKind === 'panel') {
        indicator.menu.close();
        await Scripting.sleep(250);
    } else if (screenshotKind === 'popup') {
        view.setTranslationDisplayMode('original');
    } else if (screenshotKind === 'word') {
        view.setLyrics({
            source: 'test',
            sourceId: null,
            instrumental: false,
            metadata: {},
            syncLevel: 'word',
            lines: [{
                lineId: 'screenshot-word-line',
                text: 'Safe multilingual word sync · שלום 世界',
                startMs: 0,
                endMs: 3000,
                words: [
                    {text: 'Safe ', startMs: 0, endMs: 800},
                    {text: 'multilingual ', startMs: 800, endMs: 1600},
                    {text: 'word sync · שלום ', startMs: 1600, endMs: 2400},
                    {text: '世界', startMs: 2400, endMs: 3000},
                ],
            }],
        });
        view.setTranslation({lines: [{
            lineId: 'screenshot-word-line',
            text: '安全的多语言逐字同步',
        }]});
        view.setCurrentLyricIndex(0, {reposition: true});
        view.setCurrentWordStates(0,
            ['past', 'past', 'current', 'future']);
        view._scrollView.vadjustment.value = 0;
        await Scripting.sleep(250);
    }
    if (screenshotPath)
        await takeScreenshot(screenshotPath);
    if (screenshotKind === 'panel') {
        indicator.menu.open();
        await Scripting.sleep(250);
    } else if (screenshotKind === 'popup') {
        view.setTranslationDisplayMode('bilingual');
        view.setCurrentLyricIndex(20, {reposition: true});
        await Scripting.sleep(250);
    } else if (screenshotKind === 'word') {
        view.setLyrics(lineDocument);
        view.setTranslation({
            lines: lines.map((line, index) => ({
                lineId: line.lineId,
                text: index === 20
                    ? '第 21 行安全译文 · مرحبا'
                    : `第 ${index + 1} 行译文`,
            })),
        });
        view.setCurrentLyricIndex(20, {reposition: true});
        await Scripting.sleep(250);
        originalRows = [...view._lyricRows];
    }
    if (screenshotPanelText)
        view.setText('Synchronized lyric line 21 with wrapping text');
    if (screenshotPanelPosition)
        settings.set_string('panel-position', 'center');

    const comfortableValue = view._scrollView.vadjustment.value;
    const comfortablePage = view._scrollView.vadjustment.page_size;
    const currentBounds = view._rowVerticalBounds(view._lyricRows[20]);
    const nextBounds = view._rowVerticalBounds(view._lyricRows[21]);
    const distantBounds = view._rowVerticalBounds(view._lyricRows[23]);
    print(`lyricLayout=viewport:${comfortablePage.toFixed(1)},` +
        `current:${(currentBounds.y2 - currentBounds.y1).toFixed(1)},` +
        `near:${(nextBounds.y2 - nextBounds.y1).toFixed(1)},` +
        `far:${(distantBounds.y2 - distantBounds.y1).toFixed(1)}`);
    assert(comfortablePage <= 300 &&
        currentBounds.y2 - currentBounds.y1 >
        nextBounds.y2 - nextBounds.y1 &&
        nextBounds.y2 - nextBounds.y1 >
        distantBounds.y2 - distantBounds.y1,
    'the compact viewport should retain progressive lyric breathing room');
    print(`comfortableFractions=${(((currentBounds.y1 + currentBounds.y2) / 2 -
        comfortableValue) / comfortablePage).toFixed(2)},${(((nextBounds.y1 +
        nextBounds.y2) / 2 - comfortableValue) / comfortablePage).toFixed(2)}`);
    view.setCurrentLyricIndex(21);
    await Scripting.sleep(260);
    print(`comfortableScrollDelta=${(view._scrollView.vadjustment.value -
        comfortableValue).toFixed(1)}`);
    assert(view._lyricRows.every((row, index) => row === originalRows[index]),
        'a lyric change must reuse the existing row objects');
    assert(!view._lyricRows[20].has_style_class_name(
        'mpris-lyrics-line-current'),
        'the previous row should lose the current class');
    assert(view._lyricRows[21].has_style_class_name(
        'mpris-lyrics-line-current'),
        'the new row should gain the current class');
    assert(Math.abs(view._scrollView.vadjustment.value - comfortableValue) < 1,
        'an adjacent line inside the comfortable zone should not scroll');
    view.setCurrentLyricIndex(29, {reposition: true});
    await Scripting.sleep(60);
    assert(view._scrollView.vadjustment.value > comfortableValue,
        'a seek should immediately reposition to the latest distant line');

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
    view.setCurrentLyricIndex(0, {reposition: true});
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

    instance._onPlayerStateChanged({
        busName: 'org.mpris.MediaPlayer2.test',
        playbackStatus: 'Playing',
        positionUs: 0,
        metadata: {
            ...stableMetadata,
            title: 'Replacement Track',
            artist: 'Replacement Artist',
            album: 'Replacement Album',
            durationUs: 205_000_000,
        },
    });
    assert(lyricFetches === 2 &&
        view._titleLabel.text === 'Replacement Track' &&
        view._artistLabel.text === 'Replacement Artist' &&
        view._lyricRows.some((row, index) => row !== stableRows[index]),
    'changed track metadata must refetch lyrics when Firefox reuses TrackId');

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
    assert(instance._wordTimerId !== 0 && view._label.text === markupText &&
        view._panelPanScrollable &&
        view._panelPanTimeline?.startMs === 0 &&
        view._panelPanTimeline?.endMs === 3000 &&
        view._panelPanTimeline?.positionMs === 1750 &&
        view._panelPanTimeline?.playbackRate === 1,
        'a synchronized line should arm its word timer and panel timeline');
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
    assert(instance._wordTimerId === 0 &&
        view._panelPanTimeline?.startMs === 1000 &&
        view._panelPanTimeline?.endMs === 2000 &&
        view._panelPanTimeline?.positionMs === 1750,
        'pause should cancel the word timer and preserve the lyric-time anchor');
    const offsetRows = [...view._lyricRows];
    instance._updateIndicatorAndSchedule(true);
    assert(instance._currentLyricIndex === 0,
        'the paused position should select the first lyric');
    view._increaseButton.emit('clicked', 1);
    assert(instance._trackOffsetMs === 500 &&
        view._offsetLabel.text === uiText('+0.5 s', '+0.5 秒') &&
        view._resetButton.visible,
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
        view._resetButton.visible && !view._resetButton.reactive &&
        view._lyricRows.every((row, index) => row === offsetRows[index]),
        'offset reset should dim in place and reuse the lyric row objects');

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
        view._effectiveOffsetLabel.text.includes(
            uiText('Effective +0.5 s', '实际 +0.5 秒')),
    'a GSettings global offset change should immediately resynchronize');
    settings.set_int('global-offset-ms', 0);

    settings.set_boolean('show-icon', false);
    assert(view._label.text === 'First' && !view._icon.visible &&
        view._labelViewport.get_style().includes('320px'),
    'show-icon should hide only the symbolic icon and release its width');
    settings.set_boolean('show-icon', true);
    assert(view._label.text === 'First' && view._icon.visible &&
        view._labelViewport.get_style().includes('298px'),
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
        view._panelBox.natural_width === 320 &&
        view._labelViewport.get_style().includes('298px'),
        'maximum panel width should update without extension restart');
    settings.set_int('max-panel-width', 200);
    assert(view._panelBox.get_style().includes('200px') &&
        view._panelBox.natural_width === 200 &&
        view._labelViewport.get_style().includes('178px'),
        'a configured maximum below the preferred width should cap both widths');
    settings.set_int('max-panel-width', 500);

    const viewAnimationPreference = view._animationsEnabled;
    const progressAnimationPreference = view._progressView._animationsEnabled;
    view._animationsEnabled = () => false;
    view._progressView._animationsEnabled = () => false;
    view.setText('Reduced motion');
    view.setProgress(10_000_000, 220_000_000, {
        playing: true,
        immediate: true,
    });
    view.setProgress(10_010_000, 220_000_000, {playing: true});
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(5000),
    });
    await Scripting.sleep(80);
    assert(view._label.opacity === 255 && !view._progressView._animateFill &&
        view._label.visible && !view._panelPanLabel.visible &&
        !view._panelPanLabel.get_transition('translation-x'),
    'disabled Shell animations should keep text, panel pan, and progress direct');
    view._animationsEnabled = viewAnimationPreference;
    view._progressView._animationsEnabled = progressAnimationPreference;
    view.setText('First');

    settings.set_boolean('hide-when-paused', true);
    assert(!indicator.visible,
        'hide-when-paused should immediately hide a paused track');
    settings.set_boolean('hide-when-paused', false);
    assert(indicator.visible,
        'disabling hide-when-paused should immediately restore the item');

    view.setPlayers(availablePlayers, 'auto');
    assert(view._playerMenu.menu.numMenuItems === 3 &&
        view._playerMenu.label.clutter_text.get_text() ===
            uiText('Player   Firefox', '播放器   Firefox'),
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
        view._label.text === 'Offset Test — Paused Artist' &&
        !view._panelPanScrollable,
    'plain lyrics should keep a static popup entry without pretending to sync');
    settings.set_boolean('fallback-track-info', true);
    instance._lyricsDocument = null;

    view.setLyrics({
        source: 'test-instrumental',
        sourceId: null,
        instrumental: true,
        metadata: {},
        syncLevel: 'none',
        lines: [],
    });
    assert(view._messageLabel.text === uiText('Instrumental', '纯音乐'),
        'instrumental should use one restrained centered line');

    view.setTrack({
        title: 'No Lyrics Track',
        artist: 'Another Artist',
        album: '',
        artUrl: 'invalid://artwork',
        durationUs: 0,
    }, 'no-artwork-track');
    view.setLyrics(null);
    assert(view._lyricRows.length === 0 &&
        view._messageLabel.text === uiText('No lyrics found', '未找到歌词'),
        'the popup should show the no-lyrics result');
    assert(!view._albumLabel.visible && view._albumLabel.text === '',
        'an absent album should stay hidden without artificial fallback text');
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

    for (let cycle = 1; cycle <= 3; cycle++) {
        assert(Main.extensionManager.enableExtension(UUID),
            `enable cycle ${cycle} failed after cleanup`);
        await Scripting.sleep(300);
        const cycleIndicator = Main.panel.statusArea[UUID];
        assert(cycleIndicator &&
            Main.panel.statusArea[UUID] === cycleIndicator,
        `enable cycle ${cycle} should create exactly one registered indicator`);
        assert(Main.extensionManager.disableExtension(UUID),
            `disable cycle ${cycle} failed`);
        await Scripting.sleep(200);
        assert(!Main.panel.statusArea[UUID],
            `disable cycle ${cycle} left a stale indicator`);
    }
}

export function finish() {
    print('GNOME Shell bilingual popup, settings, timers and lifecycle test passed');
}
