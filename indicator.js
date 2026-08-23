import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtworkView} from './artwork-view.js';
import {
    comfortableScrollTarget,
    formatDuration,
    getLineVisualLevel,
    normalizePanelTimeline,
    panelPanState,
    panelTimelinesEqual,
    progressFraction,
} from './ui-utils.js';

const OFFSET_STEP_MS = 500;
const MIN_OFFSET_MS = -10_000;
const MAX_OFFSET_MS = 10_000;
const PANEL_PREFERRED_WIDTH = 320;
const PANEL_TEXT_OPACITY = 150;
const PANEL_TEXT_FADE_MS = 140;
const LYRIC_TRANSITION_MS = 160;
const SCROLL_TRANSITION_MS = 220;
const PROGRESS_TRANSITION_MS = 480;
const LINE_VISUAL_CLASS_NAMES = [
    'mpris-lyrics-line-static',
    'mpris-lyrics-line-far',
    'mpris-lyrics-line-mid',
    'mpris-lyrics-line-near',
    'mpris-lyrics-line-current',
];

function animationsEnabled() {
    return St.Settings.get().enable_animations;
}

function configureEllipsized(label) {
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    label.clutter_text.set_single_line_mode(true);
}

function createMetadataLabel(styleClass, {multiline = false} = {}) {
    const label = new St.Label({
        style_class: styleClass,
        text: '',
        x_expand: true,
        y_align: Clutter.ActorAlign.START,
    });
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    label.clutter_text.set_single_line_mode(!multiline);
    if (multiline) {
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
    }
    return label;
}

function musicIcon() {
    return Gio.ThemedIcon.new_from_names([
        'music-note-symbolic',
        'audio-x-generic-symbolic',
        'media-playback-start-symbolic',
    ]);
}

function setButtonEnabled(button, enabled) {
    button.reactive = enabled;
    button.can_focus = enabled;
    if (enabled)
        button.remove_style_pseudo_class('insensitive');
    else
        button.add_style_pseudo_class('insensitive');
}

class PanelLabelLayout extends Clutter.LayoutManager {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init();
        this._panLabel = null;
        this._panWidth = 0;
    }

    setPanLabel(label) {
        this._panLabel = label;
    }

    setPanWidth(width) {
        const nextWidth = Math.max(0, Number(width) || 0);
        if (Math.abs(this._panWidth - nextWidth) < 0.5)
            return;
        this._panWidth = nextWidth;
        this.layout_changed();
    }

    vfunc_get_preferred_width(container, forHeight) {
        let naturalWidth = 0;
        for (const child of container) {
            const [, childNaturalWidth] =
                child.get_preferred_width(forHeight);
            naturalWidth = Math.max(naturalWidth, childNaturalWidth);
        }
        return [0, naturalWidth];
    }

    vfunc_get_preferred_height(container, forWidth) {
        let minimumHeight = 0;
        let naturalHeight = 0;
        for (const child of container) {
            const childWidth = child === this._panLabel && this._panWidth > 0
                ? this._panWidth
                : forWidth;
            const [childMinimumHeight, childNaturalHeight] =
                child.get_preferred_height(childWidth);
            minimumHeight = Math.max(minimumHeight, childMinimumHeight);
            naturalHeight = Math.max(naturalHeight, childNaturalHeight);
        }
        return [minimumHeight, naturalHeight];
    }

    vfunc_allocate(container, box) {
        const viewportWidth = Math.max(0, box.get_width());
        const viewportHeight = Math.max(0, box.get_height());
        for (const child of container) {
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(0, 0);
            childBox.set_size(
                child === this._panLabel && this._panWidth > 0
                    ? Math.max(viewportWidth, this._panWidth)
                    : viewportWidth,
                viewportHeight);
            child.allocate(childBox);
        }
    }
}

class PlaybackProgressView {
    constructor({animationPreference = animationsEnabled} = {}) {
        this._animationsEnabled = animationPreference;
        this._fraction = 0;
        this._lastPositionUs = 0;
        this._lastDurationUs = 0;
        this._lastUpdateUs = 0;
        this._lastPlaying = false;
        this._animateFill = false;
        this.actor = new St.BoxLayout({
            style_class: 'mpris-lyrics-progress',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._track = new St.Widget({
            style_class: 'mpris-lyrics-progress-track',
            x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({
            style_class: 'mpris-lyrics-progress-fill',
            x_align: Clutter.ActorAlign.FILL,
            x_expand: true,
            y_expand: true,
        });
        this._fill.set_pivot_point(0, 0.5);
        this._fill.scale_x = 0;
        this._track.add_child(this._fill);
        this.actor.add_child(this._track);

        const timeRow = new St.BoxLayout({
            style_class: 'mpris-lyrics-progress-time',
            x_expand: true,
        });
        this._currentLabel = new St.Label({text: '0:00', x_expand: true});
        this._durationLabel = new St.Label({text: '0:00'});
        timeRow.add_child(this._currentLabel);
        timeRow.add_child(this._durationLabel);
        this.actor.add_child(timeRow);

        this.actor.hide();
    }

    setProgress(positionUs, durationUs, {
        playing = false,
        immediate = false,
    } = {}) {
        const duration = Number(durationUs);
        const hasDuration = Number.isFinite(duration) && duration > 0;
        this.actor.visible = hasDuration;
        if (!hasDuration) {
            this._fraction = 0;
            this._lastPositionUs = 0;
            this._lastDurationUs = 0;
            this._lastUpdateUs = 0;
            this._lastPlaying = false;
            this._animateFill = false;
            this._currentLabel.text = '0:00';
            this._durationLabel.text = '0:00';
            this._updateFillScale(false);
            return;
        }

        const position = Math.min(Math.max(
            0, Number(positionUs) || 0), duration);
        const nowUs = GLib.get_monotonic_time();
        const elapsedUs = this._lastUpdateUs > 0
            ? Math.max(0, nowUs - this._lastUpdateUs)
            : 0;
        const expectedDeltaUs = this._lastPlaying ? elapsedUs : 0;
        const actualDeltaUs = position - this._lastPositionUs;
        const discontinuity = this._lastDurationUs !== duration ||
            actualDeltaUs < -250_000 ||
            Math.abs(actualDeltaUs - expectedDeltaUs) > 1_500_000;

        this._fraction = progressFraction(position, duration);
        this._animateFill = Boolean(playing) && !immediate &&
            !discontinuity && this._animationsEnabled();
        const currentText = formatDuration(
            position / 1_000_000);
        const durationText = formatDuration(duration / 1_000_000);
        if (this._currentLabel.text !== currentText)
            this._currentLabel.text = currentText;
        if (this._durationLabel.text !== durationText)
            this._durationLabel.text = durationText;
        this._updateFillScale(this._animateFill);

        this._lastPositionUs = position;
        this._lastDurationUs = duration;
        this._lastUpdateUs = nowUs;
        this._lastPlaying = Boolean(playing);
    }

    _updateFillScale(animate) {
        const fillScale = this._fraction;
        this._fill.visible = fillScale > 0;
        this._fill.remove_all_transitions();
        if (Math.abs(this._fill.scale_x - fillScale) < 0.0001)
            return;

        if (animate) {
            this._fill.ease({
                scale_x: fillScale,
                duration: PROGRESS_TRANSITION_MS,
                mode: Clutter.AnimationMode.LINEAR,
            });
        } else {
            this._fill.scale_x = fillScale;
        }
    }

    destroy() {
        this._fill?.remove_all_transitions();
        this.actor = null;
        this._track = null;
        this._fill = null;
        this._currentLabel = null;
        this._durationLabel = null;
        this._animationsEnabled = null;
    }
}

export class LyricsIndicator {
    constructor(accessibleName, {
        onOffsetAdjust,
        onOffsetReset,
        onPlayerSelected,
        onPopupOpenChanged,
        onTranslationAction,
        animationsEnabled: animationPreference = animationsEnabled,
    } = {}) {
        this._onOffsetAdjust = onOffsetAdjust ?? null;
        this._onOffsetReset = onOffsetReset ?? null;
        this._onPlayerSelected = onPlayerSelected ?? null;
        this._onPopupOpenChanged = onPopupOpenChanged ?? null;
        this._onTranslationAction = onTranslationAction ?? null;
        this._animationsEnabled = animationPreference;
        this._lyricRows = [];
        this._lyricLabels = [];
        this._translationLabels = [];
        this._document = null;
        this._translationDocument = null;
        this._translationEnabled = false;
        this._translationDisplayMode = 'bilingual';
        this._translationStatus = 'idle';
        this._wordSyncEnabled = true;
        this._wordStateSignature = '';
        this._activeLyricIndex = -1;
        this._scrollLaterId = 0;
        this._scrollRequest = null;
        this._layoutAnchorSignalId = 0;
        this._layoutAnchorAdjustment = null;
        this._panelPanLaterId = 0;
        this._panelPanScrollable = false;
        this._panelPanTimeline = null;
        this._panelPanTimelineAnchorUs = 0;
        this._panelTextKey = null;
        this._panelPanTargetX = 0;
        this._panelPanPaused = false;
        this._panelPlaying = false;
        this._panelHovered = false;
        this._panelViewportWidth = 0;
        this._maxPanelWidth = 500;
        this._showIcon = true;
        this._laters = global.compositor.get_laters();

        this.actor = new PanelMenu.Button(0.5, accessibleName);
        this.actor.add_style_class_name('mpris-lyrics-indicator');
        this._panelBox = new St.BoxLayout({
            style_class: 'mpris-lyrics-panel',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._icon = new St.Icon({
            style_class: 'mpris-lyrics-panel-icon',
            gicon: musicIcon(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'mpris-lyrics-panel-label',
            text: '',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        configureEllipsized(this._label);
        this._panelPanLabel = new St.Label({
            style_class: 'mpris-lyrics-panel-label',
            text: '',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            visible: false,
        });
        this._panelPanLabel.clutter_text.set_ellipsize(
            Pango.EllipsizeMode.NONE);
        this._panelPanLabel.clutter_text.set_single_line_mode(true);
        this._panelLabelLayout = new PanelLabelLayout();
        this._panelLabelLayout.setPanLabel(this._panelPanLabel);
        this._labelViewport = new St.Widget({
            style_class: 'mpris-lyrics-panel-label-viewport',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            clip_to_allocation: true,
            layout_manager: this._panelLabelLayout,
        });
        this._labelViewport.add_child(this._label);
        this._labelViewport.add_child(this._panelPanLabel);
        this._labelViewport.connect('notify::allocation', () => {
            const width = Math.round(this._labelViewport.width);
            if (width === this._panelViewportWidth)
                return;
            this._panelViewportWidth = width;
            this._schedulePanelPan();
        });
        this.actor.connect('enter-event', () => {
            this._panelHovered = true;
            this._pausePanelPan();
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('leave-event', () => {
            this._panelHovered = false;
            this._resumePanelPan();
            return Clutter.EVENT_PROPAGATE;
        });
        this._panelBox.add_child(this._icon);
        this._panelBox.add_child(this._labelViewport);
        this.actor.add_child(this._panelBox);

        this._buildMenu();
        this.actor.hide();
    }

    _buildMenu() {
        this.actor.menu.box.add_style_class_name('mpris-lyrics-menu');

        const mediaItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'mpris-lyrics-media-section',
            reactive: false,
            can_focus: false,
        });
        const mediaBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const mediaHeader = new St.BoxLayout({
            style_class: 'mpris-lyrics-media-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._artworkView = new ArtworkView({
            animationsEnabled: this._animationsEnabled,
        });
        mediaHeader.add_child(this._artworkView.actor);
        const metadataBox = new St.BoxLayout({
            style_class: 'mpris-lyrics-metadata',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel = createMetadataLabel('mpris-lyrics-title', {
            multiline: true,
        });
        this._artistLabel = createMetadataLabel('mpris-lyrics-artist');
        this._albumLabel = createMetadataLabel('mpris-lyrics-album');
        metadataBox.add_child(this._titleLabel);
        metadataBox.add_child(this._artistLabel);
        metadataBox.add_child(this._albumLabel);
        mediaHeader.add_child(metadataBox);
        mediaBox.add_child(mediaHeader);
        this._progressView = new PlaybackProgressView({
            animationPreference: this._animationsEnabled,
        });
        mediaBox.add_child(this._progressView.actor);
        mediaItem.add_child(mediaBox);
        this.actor.menu.addMenuItem(mediaItem);

        const lyricsItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'mpris-lyrics-scroll-item',
            reactive: false,
            can_focus: false,
        });
        this._lyricsBox = new St.BoxLayout({
            style_class: 'mpris-lyrics-lines',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scrollView = new St.ScrollView({
            style_class: 'mpris-lyrics-scroll',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._lyricsBox,
        });
        lyricsItem.add_child(this._scrollView);
        this.actor.menu.addMenuItem(lyricsItem);

        this._translationItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'mpris-lyrics-translation-status',
            reactive: false,
            can_focus: false,
        });
        const translationControls = new St.BoxLayout({
            x_expand: true,
        });
        this._translationStatusLabel = new St.Label({
            text: _('Translation available on request'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._translationActionButton = new St.Button({
            style_class: 'button flat mpris-lyrics-translation-button',
            label: _('Translate'),
            can_focus: true,
        });
        translationControls.add_child(this._translationStatusLabel);
        translationControls.add_child(this._translationActionButton);
        this._translationItem.add_child(translationControls);
        this.actor.menu.addMenuItem(this._translationItem);

        const offsetItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'mpris-lyrics-offset',
            reactive: false,
            can_focus: false,
        });
        const offsetBox = new St.BoxLayout({
            style_class: 'mpris-lyrics-footer',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const titleRow = new St.BoxLayout({
            style_class: 'mpris-lyrics-offset-heading',
            x_expand: true,
        });
        const offsetTitle = new St.Label({
            style_class: 'mpris-lyrics-offset-title',
            text: _('Lyrics timing'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleRow.add_child(offsetTitle);
        this._resetButton = new St.Button({
            style_class: 'button flat mpris-lyrics-reset-button',
            label: _('Reset'),
            can_focus: true,
            accessible_name: _('Reset lyrics offset'),
        });
        titleRow.add_child(this._resetButton);
        offsetBox.add_child(titleRow);

        const controls = new St.BoxLayout({
            style_class: 'mpris-lyrics-offset-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._decreaseButton = new St.Button({
            style_class: 'button flat mpris-lyrics-offset-button',
            label: '−0.5 s',
            can_focus: true,
            accessible_name: _('Decrease lyrics offset by 0.5 seconds'),
        });
        this._offsetLabel = new St.Label({
            style_class: 'mpris-lyrics-offset-label',
            text: '+0.0 s',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._increaseButton = new St.Button({
            style_class: 'button flat mpris-lyrics-offset-button',
            label: '+0.5 s',
            can_focus: true,
            accessible_name: _('Increase lyrics offset by 0.5 seconds'),
        });
        controls.add_child(this._decreaseButton);
        controls.add_child(this._offsetLabel);
        controls.add_child(this._increaseButton);
        offsetBox.add_child(controls);
        this._effectiveOffsetLabel = new St.Label({
            style_class: 'mpris-lyrics-effective-offset',
            text: _('Global +0.0 s  ·  Effective +0.0 s'),
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        offsetBox.add_child(this._effectiveOffsetLabel);
        offsetItem.add_child(offsetBox);
        this.actor.menu.addMenuItem(offsetItem);

        this.actor.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._playerMenu = new PopupMenu.PopupSubMenuMenuItem(_('Player'), false);
        this._playerMenu.add_style_class_name('mpris-lyrics-player');
        this._playerMenu.label.add_style_class_name(
            'mpris-lyrics-player-label');
        configureEllipsized(this._playerMenu.label);
        this.actor.menu.addMenuItem(this._playerMenu);

        this._decreaseButton.connect('clicked', () => {
            this._onOffsetAdjust?.(-OFFSET_STEP_MS);
        });
        this._increaseButton.connect('clicked', () => {
            this._onOffsetAdjust?.(OFFSET_STEP_MS);
        });
        this._resetButton.connect('clicked', () => {
            this._onOffsetReset?.();
        });
        this._translationActionButton.connect('clicked', () => {
            this._onTranslationAction?.({
                forceRefresh: this._translationStatus === 'available',
            });
        });
        this.actor.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._scheduleScrollToActive({force: true, immediate: true});
            else
                this._cancelScheduledScroll();
            this._onPopupOpenChanged?.(open);
        });

        this.setOffsets(0, 0);
        this.setPlayers([], 'auto');
        this.setTranslationEnabled(false);
        this._showLyricsMessage(_('No lyrics found'));
    }

    setText(text, {
        scrollable = false,
        timeline = null,
        contentKey = null,
    } = {}) {
        const canScroll = Boolean(scrollable);
        const normalizedTimeline = normalizePanelTimeline(timeline);
        const timelineChanged = !panelTimelinesEqual(
            this._panelPanTimeline, normalizedTimeline);
        this._panelPanTimeline = normalizedTimeline;
        this._panelPanTimelineAnchorUs = GLib.get_monotonic_time();
        if (!this._label ||
            (this._label.text === text &&
                this._panelPanScrollable === canScroll &&
                this._panelTextKey === contentKey)) {
            if (this._label && timelineChanged)
                this._schedulePanelPan();
            return;
        }

        this._cancelPanelPan();
        this._panelPanScrollable = canScroll;
        this._panelTextKey = contentKey;
        this._label.remove_all_transitions();
        this._label.text = text;
        this._panelPanLabel.text = text;
        if (!this._label.mapped || !this._animationsEnabled()) {
            this._label.opacity = 255;
            return;
        }

        this._label.opacity = PANEL_TEXT_OPACITY;
        this._label.ease({
            opacity: 255,
            duration: PANEL_TEXT_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._schedulePanelPan();
    }

    setTrack(metadata, trackKey) {
        this.updateTrackMetadata(metadata, trackKey);
        this.setProgress(0, metadata.durationUs, {immediate: true});
        this._document = null;
        this._translationDocument = null;
        this.setTranslationState('idle');
        this._showLyricsMessage(_('Loading lyrics…'));
    }

    updateTrackMetadata(metadata, trackKey) {
        this.updateMetadataDisplay(metadata);
        this.setArtwork(metadata.artUrl, trackKey);
    }

    updateMetadataDisplay(metadata) {
        this._titleLabel.text = metadata.title ?? '';
        this._artistLabel.text = metadata.artist ?? '';
        const album = metadata.album ?? '';
        this._albumLabel.text = album;
        this._artistLabel.show();
        this._albumLabel.visible = Boolean(album);
    }

    setArtwork(artUrl, trackKey) {
        this._artworkView.setArtwork(artUrl, trackKey);
    }

    setProgress(positionUs, durationUs, options = {}) {
        this._progressView?.setProgress(positionUs, durationUs, options);
        this._setPanelPlaying(Boolean(options.playing));
    }

    clearTrack() {
        this._panelPanScrollable = false;
        this._panelPanTimeline = null;
        this._panelPanTimelineAnchorUs = 0;
        this._panelTextKey = null;
        this._setPanelPlaying(false);
        this._titleLabel.text = '';
        this._artistLabel.text = '';
        this._albumLabel.text = '';
        this._artworkView.clear();
        this.setProgress(0, 0, {immediate: true});
        this._document = null;
        this._translationDocument = null;
        this._clearLyricsRows();
        this._updateTranslationControlVisibility();
    }

    setLyrics(document) {
        this._document = document ?? null;
        this._translationDocument = null;
        if (document?.instrumental) {
            this._showLyricsMessage(_('Instrumental'));
            return;
        }
        if (!document?.lines?.length) {
            this._showLyricsMessage(_('No lyrics found'));
            return;
        }

        this._clearLyricsRows();
        for (const line of document.lines) {
            const row = new PopupMenu.PopupBaseMenuItem({
                style_class: 'mpris-lyrics-line',
                reactive: false,
                can_focus: false,
            });
            const lineBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            const label = new St.Label({
                style_class: 'mpris-lyrics-original',
                text: line.text,
                x_expand: true,
            });
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            label.clutter_text.set_line_wrap(true);
            label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            const translatedLabel = new St.Label({
                style_class: 'mpris-lyrics-translation',
                text: '',
                x_expand: true,
                visible: false,
            });
            translatedLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            translatedLabel.clutter_text.set_line_wrap(true);
            translatedLabel.clutter_text.set_line_wrap_mode(
                Pango.WrapMode.WORD_CHAR);
            lineBox.add_child(label);
            lineBox.add_child(translatedLabel);
            row.add_child(lineBox);
            this._lyricsBox.add_child(row);
            this._lyricRows.push(row);
            this._lyricLabels.push(label);
            this._translationLabels.push(translatedLabel);
        }
        this._applyLineVisualLevels(-1, -1, false);
        this._applyTranslationToRows();
        this._updateTranslationControlVisibility();
    }

    setTranslation(translation) {
        this._translationDocument = translation ?? null;
        this._applyTranslationToRows();
    }

    setTranslationEnabled(enabled) {
        this._translationEnabled = Boolean(enabled);
        this._updateTranslationControlVisibility();
        this._applyTranslationToRows();
    }

    setTranslationDisplayMode(mode) {
        this._translationDisplayMode = [
            'bilingual', 'original', 'translated',
        ].includes(mode) ? mode : 'bilingual';
        this._applyTranslationToRows();
    }

    setTranslationState(status, {fromCache = false} = {}) {
        this._translationStatus = status;
        const states = {
            idle: [_('Translation available on request'), _('Translate'), true],
            loading: [_('Loading translation…'), _('Loading…'), false],
            available: [
                fromCache
                    ? _('Translation loaded from cache')
                    : _('Translation available'),
                _('Refresh'),
                true,
            ],
            not_configured: [_('Translation API key is not configured'), '', false],
            provider_unavailable: [_('Translation provider unavailable'), _('Retry'), true],
            network_error: [_('Translation network error'), _('Retry'), true],
            provider_error: [_('Translation provider error'), _('Retry'), true],
            authentication_error: [_('Translation API key was rejected'), _('Retry'), true],
            rate_limited: [_('Translation rate limited'), _('Retry'), true],
            invalid_response: [_('Translation response was invalid'), _('Retry'), true],
            canceled: [_('Translation canceled'), _('Retry'), true],
            same_language: [_('Original language matches target language'), '', false],
            skipped: ['', '', false],
        };
        const [text, action, enabled] = states[status] ?? states.provider_error;
        this._translationStatusLabel.text = text;
        this._translationActionButton.label = action;
        this._translationActionButton.accessible_name = action
            ? _('Lyrics translation action: %s').format(action)
            : _('Lyrics translation');
        this._translationActionButton.visible = Boolean(action);
        setButtonEnabled(this._translationActionButton, enabled);
        this._updateTranslationControlVisibility();
    }

    translatedTextForLine(lineId) {
        return this._translationDocument?.lines
            ?.find(line => line.lineId === lineId)?.text ?? null;
    }

    isOriginalLineVisible(index) {
        return Boolean(this._lyricLabels[index]?.visible);
    }

    setCurrentLyricIndex(index, {reposition = false} = {}) {
        const nextIndex = this._lyricRows[index] ? index : -1;
        if (nextIndex === this._activeLyricIndex)
            return;

        const previousIndex = this._activeLyricIndex;
        if (previousIndex >= 0)
            this._resetLineText(previousIndex);

        this._activeLyricIndex = nextIndex;
        this._wordStateSignature = '';
        const current = this._lyricRows[nextIndex];
        this._applyLineVisualLevels(
            previousIndex,
            nextIndex,
            Boolean(current) && this.actor.menu.isOpen && !reposition &&
                this._animationsEnabled());

        if (current && this.actor.menu.isOpen)
            this._scheduleScrollToActive({
                force: reposition,
                immediate: reposition,
            });
    }

    setWordSyncEnabled(enabled) {
        this._wordSyncEnabled = Boolean(enabled);
        this._wordStateSignature = '';
        if (!this._wordSyncEnabled && this._activeLyricIndex >= 0)
            this._resetLineText(this._activeLyricIndex);
    }

    setCurrentWordStates(index, states) {
        if (!this._wordSyncEnabled || index !== this._activeLyricIndex ||
            this._document?.syncLevel !== 'word')
            return;

        const line = this._document.lines[index];
        const label = this._lyricLabels[index];
        if (!line?.words?.length || !label || states.length !== line.words.length)
            return;

        const signature = `${index}:${states.join(',')}`;
        if (signature === this._wordStateSignature)
            return;
        this._wordStateSignature = signature;

        const markup = line.words.map((word, wordIndex) => {
            const text = GLib.markup_escape_text(word.text, -1);
            switch (states[wordIndex]) {
            case 'past':
                return `<span alpha="72%">${text}</span>`;
            case 'current':
                return `<span weight="semibold">${text}</span>`;
            default:
                return `<span alpha="48%">${text}</span>`;
            }
        }).join('');
        label.clutter_text.set_markup(markup);
    }

    isPopupOpen() {
        return Boolean(this.actor?.menu?.isOpen);
    }

    setOffsets(trackOffsetMs, globalOffsetMs) {
        const format = offsetMs => {
            const seconds = offsetMs / 1000;
            const value = `${seconds >= 0 ? '+' : ''}${seconds.toFixed(1)}`;
            return _('%s s').format(value);
        };
        this._offsetLabel.text = format(trackOffsetMs);
        this._effectiveOffsetLabel.text = _('Global %s  ·  Effective %s')
            .format(
                format(globalOffsetMs),
                format(trackOffsetMs + globalOffsetMs));
        this._effectiveOffsetLabel.visible = globalOffsetMs !== 0;
        setButtonEnabled(
            this._decreaseButton, trackOffsetMs > MIN_OFFSET_MS);
        setButtonEnabled(
            this._increaseButton, trackOffsetMs < MAX_OFFSET_MS);
        setButtonEnabled(this._resetButton, trackOffsetMs !== 0);
    }

    setMaxPanelWidth(width) {
        this._maxPanelWidth = Math.clamp(Math.round(width), 150, 1000);
        this._applyPanelWidth();
    }

    setShowIcon(visible) {
        this._showIcon = Boolean(visible);
        this._icon.visible = this._showIcon;
        this._applyPanelWidth();
    }

    setPlayers(players, preferredPlayer) {
        this._playerMenu.menu.removeAll();
        const autoItem = this._playerMenu.menu.addAction(_('Auto'), () => {
            this._onPlayerSelected?.('auto');
        });
        autoItem.setOrnament(preferredPlayer === 'auto'
            ? PopupMenu.Ornament.CHECK
            : PopupMenu.Ornament.NONE);

        const seen = new Set();
        for (const player of players) {
            if (seen.has(player.stableId))
                continue;
            seen.add(player.stableId);
            const item = this._playerMenu.menu.addAction(
                player.displayName, () => {
                    this._onPlayerSelected?.(player.stableId);
                });
            item.setOrnament(player.stableId === preferredPlayer
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }

        const selected = players.find(player => player.selected);
        const playerLabel = GLib.markup_escape_text(_('Player'), -1);
        if (selected) {
            const displayName = GLib.markup_escape_text(
                selected.displayName, -1);
            this._playerMenu.label.clutter_text.set_markup(
                `<span size="smaller" alpha="58%">${playerLabel}</span>` +
                `   ${displayName}`);
            this._playerMenu.accessible_name = _('Player: %s')
                .format(selected.displayName);
        } else {
            this._playerMenu.label.clutter_text.set_markup(
                `<span size="smaller" alpha="58%">${playerLabel}</span>`);
            this._playerMenu.accessible_name = _('Player');
        }
    }

    setVisible(visible) {
        if (!this.actor)
            return;

        if (visible) {
            const wasVisible = this.actor.visible;
            this.actor.container.show();
            this.actor.show();
            if (!wasVisible)
                this._schedulePanelPan();
        } else {
            this._cancelPanelPan();
            this.actor.hide();
            this.actor.container.hide();
        }
    }

    _showLyricsMessage(text) {
        this._clearLyricsRows();
        const message = new St.Label({
            style_class: 'mpris-lyrics-message',
            text,
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        message.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        message.clutter_text.set_line_wrap(true);
        message.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._lyricsBox.add_child(message);
        this._messageLabel = message;
        this._updateTranslationControlVisibility();
    }

    _applyLineVisualLevels(previousIndex, currentIndex, animate) {
        for (let index = 0; index < this._lyricRows.length; index++) {
            const row = this._lyricRows[index];
            const level = getLineVisualLevel(index, currentIndex);
            for (const className of LINE_VISUAL_CLASS_NAMES)
                row.remove_style_class_name(className);
            row.add_style_class_name(`mpris-lyrics-line-${level.name}`);

            row.remove_all_transitions();
            if (animate && (index === previousIndex || index === currentIndex)) {
                row.ease({
                    opacity: level.opacity,
                    duration: LYRIC_TRANSITION_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                row.opacity = level.opacity;
            }
        }
    }

    _applyPanelWidth() {
        if (!this._labelViewport || !this._panelBox)
            return;
        const reservedForIcon = this._showIcon ? 22 : 0;
        const preferredWidth = Math.min(
            PANEL_PREFERRED_WIDTH, this._maxPanelWidth);
        const labelWidth = Math.max(1,
            preferredWidth - reservedForIcon);
        this._panelBox.natural_width = preferredWidth;
        this._panelBox.set_style(`max-width: ${this._maxPanelWidth}px;`);
        this._labelViewport.set_style(`max-width: ${labelWidth}px;`);
        this._schedulePanelPan();
    }

    _setPanelPlaying(playing) {
        if (this._panelPlaying === playing)
            return;
        const nowUs = GLib.get_monotonic_time();
        if (this._panelPanTimeline) {
            this._panelPanTimeline = {
                ...this._panelPanTimeline,
                positionMs: this._panelPanPositionAt(nowUs),
            };
            this._panelPanTimelineAnchorUs = nowUs;
        }
        this._panelPlaying = playing;
        this._schedulePanelPan();
    }

    _schedulePanelPan() {
        this._cancelPanelPan();
        if (!this._panelPanScrollable || !this._panelPanTimeline ||
            !this._animationsEnabled() || !this._labelViewport?.mapped)
            return;

        this._panelPanLaterId = this._laters.add(
            Meta.LaterType.IDLE,
            () => {
                this._panelPanLaterId = 0;
                this._startPanelPan();
                return GLib.SOURCE_REMOVE;
            });
    }

    _startPanelPan() {
        if (!this._panelPanScrollable || !this._panelPanTimeline ||
            !this._animationsEnabled() || !this._labelViewport?.mapped)
            return;

        const [, naturalWidth] =
            this._panelPanLabel.get_preferred_width(-1);
        const viewportWidth = this._labelViewport.width;
        const overflow = Math.ceil(naturalWidth - viewportWidth);
        if (!(viewportWidth > 0) || overflow <= 1)
            return;

        const panState = panelPanState(
            this._panelPanTimeline, this._panelPanPositionAt(), overflow);
        if (!panState)
            return;

        this._panelLabelLayout.setPanWidth(naturalWidth);
        this._panelPanLabel.translation_x = panState.initialX;
        this._panelPanLabel.show();
        this._label.hide();
        this._panelPanTargetX = panState.targetX;
        const shouldAnimate = this._panelPlaying && panState.shouldAnimate;
        if (shouldAnimate) {
            this._panelPanLabel.ease({
                translation_x: this._panelPanTargetX,
                delay: panState.delayMs,
                duration: panState.durationMs,
                mode: Clutter.AnimationMode.LINEAR,
            });
        }
        if (this._panelHovered && shouldAnimate)
            this._pausePanelPan();
    }

    _panelPanPositionAt(nowUs = GLib.get_monotonic_time()) {
        const timeline = this._panelPanTimeline;
        if (!timeline)
            return 0;
        const elapsedMs = this._panelPlaying &&
            this._panelPanTimelineAnchorUs > 0
            ? Math.max(0, nowUs - this._panelPanTimelineAnchorUs) / 1000 *
                timeline.playbackRate
            : 0;
        return Math.min(timeline.endMs, timeline.positionMs + elapsedMs);
    }

    _cancelPanelPan() {
        if (this._panelPanLaterId && this._laters) {
            this._laters.remove(this._panelPanLaterId);
            this._panelPanLaterId = 0;
        }
        this._panelPanLabel?.remove_all_transitions();
        if (this._panelPanLabel) {
            this._panelPanLabel.translation_x = 0;
            this._panelPanLabel.hide();
        }
        this._panelLabelLayout?.setPanWidth(0);
        this._panelPanTargetX = 0;
        this._panelPanPaused = false;
        this._label?.show();
    }

    _pausePanelPan() {
        const transition =
            this._panelPanLabel?.get_transition('translation-x');
        if (!transition)
            return;
        const currentX = this._panelPanLabel.translation_x;
        this._panelPanLabel.remove_transition('translation-x');
        this._panelPanLabel.translation_x = currentX;
        this._panelPanPaused =
            currentX > this._panelPanTargetX + 0.5;
    }

    _resumePanelPan() {
        if (!this._panelPanPaused || !this._panelPlaying ||
            !this._panelPanLabel?.visible)
            return;
        this._panelPanPaused = false;
        this._schedulePanelPan();
    }

    _clearLyricsRows() {
        this._cancelScheduledScroll();
        this._cancelLayoutAnchor();
        this._lyricsBox.destroy_all_children();
        this._lyricRows = [];
        this._lyricLabels = [];
        this._translationLabels = [];
        this._activeLyricIndex = -1;
        this._wordStateSignature = '';
        this._messageLabel = null;
    }

    _applyTranslationToRows() {
        if (!this._document?.lines?.length)
            return;
        const anchor = this._captureActiveRowAnchor();
        const translations = new Map(
            this._translationDocument?.lines?.map(line =>
                [line.lineId, line.text]) ?? []);
        for (let index = 0; index < this._document.lines.length; index++) {
            const original = this._lyricLabels[index];
            const translated = this._translationLabels[index];
            if (!original || !translated)
                continue;
            const text = translations.get(this._document.lines[index].lineId);
            const hasTranslation = this._translationEnabled &&
                typeof text === 'string' && Boolean(text);
            if (hasTranslation && translated.text !== text)
                translated.text = text;

            translated.remove_style_class_name(
                'mpris-lyrics-translation-only');
            switch (this._translationDisplayMode) {
            case 'original':
                original.show();
                translated.hide();
                break;
            case 'translated':
                original.visible = !hasTranslation;
                translated.visible = hasTranslation;
                if (hasTranslation)
                    translated.add_style_class_name(
                        'mpris-lyrics-translation-only');
                break;
            default:
                original.show();
                translated.visible = hasTranslation;
                break;
            }
        }
        this._queueActiveRowAnchor(anchor);
    }

    _updateTranslationControlVisibility() {
        if (!this._translationItem)
            return;
        this._translationItem.visible = this._translationEnabled &&
            Boolean(this._document?.lines?.length) &&
            !this._document?.instrumental &&
            this._translationStatus !== 'skipped';
    }

    _resetLineText(index) {
        const label = this._lyricLabels[index];
        const line = this._document?.lines?.[index];
        if (label && line)
            label.clutter_text.set_text(line.text);
    }

    _scheduleScrollToActive({force = false, immediate = false} = {}) {
        if (!this.actor.menu.isOpen ||
            !this._lyricRows[this._activeLyricIndex])
            return;

        this._scrollView.vadjustment.remove_transition('value');
        this._scrollRequest = {force, immediate};
        if (this._scrollLaterId)
            return;

        this._scrollLaterId = this._laters.add(
            Meta.LaterType.IDLE,
            () => {
                this._scrollLaterId = 0;
                const request = this._scrollRequest;
                this._scrollRequest = null;
                this._scrollToActive(request);
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelScheduledScroll() {
        if (this._scrollLaterId) {
            this._laters.remove(this._scrollLaterId);
            this._scrollLaterId = 0;
        }
        this._scrollRequest = null;
        this._scrollView?.vadjustment?.remove_transition('value');
    }

    _scrollToActive({force = false, immediate = false} = {}) {
        if (!this.actor.menu.isOpen)
            return;

        const row = this._lyricRows[this._activeLyricIndex];
        if (!row)
            return;

        const adjustment = this._scrollView.vadjustment;
        const [value, lower, upper, , , pageSize] = adjustment.get_values();
        if (pageSize <= 0)
            return;

        const bounds = this._rowVerticalBounds(row);
        if (!bounds)
            return;
        const target = comfortableScrollTarget({
            rowTop: bounds.y1,
            rowBottom: bounds.y2,
            value,
            lower,
            upper,
            pageSize,
            force,
        });
        if (target === null || Math.abs(target - value) < 0.5)
            return;

        adjustment.remove_transition('value');
        if (immediate || !this._animationsEnabled()) {
            adjustment.set_value(target);
        } else {
            adjustment.ease(target, {
                duration: SCROLL_TRANSITION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _rowVerticalBounds(row) {
        let box = row.get_allocation_box();
        let y1 = box.y1;
        let y2 = box.y2;
        let parent = row.get_parent();
        while (parent !== this._scrollView) {
            if (!parent)
                return null;

            box = parent.get_allocation_box();
            y1 += box.y1;
            y2 += box.y1;
            parent = parent.get_parent();
        }
        return {y1, y2};
    }

    _captureActiveRowAnchor() {
        if (!this.actor.menu.isOpen)
            return null;
        const row = this._lyricRows[this._activeLyricIndex];
        if (!row)
            return null;
        const [, stageY] = row.get_transformed_position();
        return {row, stageY};
    }

    _queueActiveRowAnchor(anchor) {
        if (!anchor)
            return;
        this._cancelLayoutAnchor();
        const adjustment = this._scrollView.vadjustment;
        this._layoutAnchorAdjustment = adjustment;
        this._layoutAnchorSignalId = adjustment.connect(
            'notify::upper', () => {
                this._cancelLayoutAnchor();
                if (!this.actor.menu.isOpen ||
                    anchor.row !== this._lyricRows[this._activeLyricIndex])
                    return;

                const [, stageY] = anchor.row.get_transformed_position();
                const delta = stageY - anchor.stageY;
                if (Math.abs(delta) < 0.5)
                    return;

                const [, lower, upper, , , pageSize] = adjustment.get_values();
                const maximum = Math.max(lower, upper - pageSize);
                adjustment.remove_transition('value');
                adjustment.set_value(Math.min(maximum, Math.max(
                    lower, adjustment.value + delta)));
            });
    }

    _cancelLayoutAnchor() {
        if (this._layoutAnchorSignalId && this._layoutAnchorAdjustment)
            this._layoutAnchorAdjustment.disconnect(this._layoutAnchorSignalId);
        this._layoutAnchorSignalId = 0;
        this._layoutAnchorAdjustment = null;
    }

    destroy() {
        this._cancelPanelPan();
        this._cancelScheduledScroll();
        this._cancelLayoutAnchor();
        this._label?.remove_all_transitions();
        this._onOffsetAdjust = null;
        this._onOffsetReset = null;
        this._onPlayerSelected = null;
        this._onPopupOpenChanged = null;
        this._onTranslationAction = null;
        this._animationsEnabled = null;
        this._artworkView?.destroy();
        this._progressView?.destroy();
        this.actor?.destroy();
        this.actor = null;
        this._panelBox = null;
        this._icon = null;
        this._label = null;
        this._panelPanLabel = null;
        this._panelLabelLayout = null;
        this._labelViewport = null;
        this._panelPanTimeline = null;
        this._titleLabel = null;
        this._artistLabel = null;
        this._albumLabel = null;
        this._artworkView = null;
        this._progressView = null;
        this._lyricsBox = null;
        this._scrollView = null;
        this._laters = null;
        this._lyricRows = [];
        this._lyricLabels = [];
        this._translationLabels = [];
        this._document = null;
        this._translationDocument = null;
        this._offsetLabel = null;
        this._effectiveOffsetLabel = null;
        this._decreaseButton = null;
        this._increaseButton = null;
        this._resetButton = null;
        this._playerMenu = null;
        this._translationItem = null;
        this._translationStatusLabel = null;
        this._translationActionButton = null;
    }
}
