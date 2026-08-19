import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const OFFSET_STEP_MS = 500;
const MIN_OFFSET_MS = -10_000;
const MAX_OFFSET_MS = 10_000;

function configureEllipsized(label) {
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    label.clutter_text.set_single_line_mode(true);
}

function createMetadataLabel(styleClass) {
    const label = new St.Label({
        style_class: styleClass,
        text: '',
        x_expand: true,
    });
    configureEllipsized(label);
    return label;
}

function setButtonEnabled(button, enabled) {
    button.reactive = enabled;
    button.can_focus = enabled;
    if (enabled)
        button.remove_style_pseudo_class('insensitive');
    else
        button.add_style_pseudo_class('insensitive');
}

export class LyricsIndicator {
    constructor(accessibleName, {
        onOffsetAdjust,
        onOffsetReset,
        onPlayerSelected,
        onPopupOpenChanged,
        onTranslationAction,
    } = {}) {
        this._onOffsetAdjust = onOffsetAdjust ?? null;
        this._onOffsetReset = onOffsetReset ?? null;
        this._onPlayerSelected = onPlayerSelected ?? null;
        this._onPopupOpenChanged = onPopupOpenChanged ?? null;
        this._onTranslationAction = onTranslationAction ?? null;
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
        this._laters = global.compositor.get_laters();

        this.actor = new PanelMenu.Button(0.5, accessibleName);

        this._label = new St.Label({
            style_class: 'mpris-lyrics-label',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        configureEllipsized(this._label);
        this.actor.add_child(this._label);

        this._buildMenu();
        this.actor.hide();
    }

    _buildMenu() {
        this.actor.menu.box.add_style_class_name('mpris-lyrics-menu');

        const metadataItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'mpris-lyrics-metadata',
            reactive: false,
            can_focus: false,
        });
        const metadataBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._titleLabel = createMetadataLabel('mpris-lyrics-track-title');
        this._artistLabel = createMetadataLabel('mpris-lyrics-track-artist');
        this._albumLabel = createMetadataLabel('mpris-lyrics-track-album');
        metadataBox.add_child(this._titleLabel);
        metadataBox.add_child(this._artistLabel);
        metadataBox.add_child(this._albumLabel);
        metadataItem.add_child(metadataBox);
        this.actor.menu.addMenuItem(metadataItem);

        this.actor.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const lyricsItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'mpris-lyrics-scroll-item',
            reactive: false,
            can_focus: false,
        });
        this._lyricsBox = new St.BoxLayout({
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

        this.actor.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._translationItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'mpris-lyrics-translation-status',
            reactive: false,
            can_focus: false,
        });
        const translationControls = new St.BoxLayout({
            x_expand: true,
        });
        this._translationStatusLabel = new St.Label({
            text: 'Translation available on request',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._translationActionButton = new St.Button({
            style_class: 'button flat mpris-lyrics-translation-button',
            label: 'Translate',
            can_focus: true,
        });
        translationControls.add_child(this._translationStatusLabel);
        translationControls.add_child(this._translationActionButton);
        this._translationItem.add_child(translationControls);
        this.actor.menu.addMenuItem(this._translationItem);

        this.actor.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const offsetItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'mpris-lyrics-offset',
            reactive: false,
            can_focus: false,
        });
        const offsetBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const controls = new St.BoxLayout({
            style_class: 'mpris-lyrics-offset-controls',
            x_expand: true,
        });
        this._decreaseButton = new St.Button({
            style_class: 'button mpris-lyrics-offset-button',
            label: '-0.5s',
            can_focus: true,
        });
        this._offsetLabel = new St.Label({
            style_class: 'mpris-lyrics-offset-label',
            text: 'Track Offset +0.0s',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._increaseButton = new St.Button({
            style_class: 'button mpris-lyrics-offset-button',
            label: '+0.5s',
            can_focus: true,
        });
        controls.add_child(this._decreaseButton);
        controls.add_child(this._offsetLabel);
        controls.add_child(this._increaseButton);

        this._resetButton = new St.Button({
            style_class: 'button flat mpris-lyrics-reset-button',
            label: 'Reset',
            x_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        offsetBox.add_child(controls);
        this._effectiveOffsetLabel = new St.Label({
            style_class: 'mpris-lyrics-effective-offset',
            text: 'Global +0.0s  •  Effective +0.0s',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        offsetBox.add_child(this._effectiveOffsetLabel);
        offsetBox.add_child(this._resetButton);
        offsetItem.add_child(offsetBox);
        this.actor.menu.addMenuItem(offsetItem);

        this.actor.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._playerMenu = new PopupMenu.PopupSubMenuMenuItem('Player', false);
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
                this._scheduleScrollToActive();
            else
                this._cancelScheduledScroll();
            this._onPopupOpenChanged?.(open);
        });

        this.setOffsets(0, 0);
        this.setPlayers([], 'auto');
        this.setTranslationEnabled(false);
        this._showLyricsMessage('No lyrics found');
    }

    setText(text) {
        if (this._label && this._label.text !== text)
            this._label.text = text;
    }

    setTrack(metadata) {
        this._titleLabel.text = metadata.title;
        this._artistLabel.text = metadata.artist;
        this._albumLabel.text = metadata.album;
        this._albumLabel.visible = Boolean(metadata.album);
        this._document = null;
        this._translationDocument = null;
        this.setTranslationState('idle');
        this._showLyricsMessage('Loading lyrics…');
    }

    clearTrack() {
        this._titleLabel.text = '';
        this._artistLabel.text = '';
        this._albumLabel.text = '';
        this._albumLabel.hide();
        this._document = null;
        this._translationDocument = null;
        this._clearLyricsRows();
        this._updateTranslationControlVisibility();
    }

    setLyrics(document) {
        this._document = document ?? null;
        this._translationDocument = null;
        if (document?.instrumental) {
            this._showLyricsMessage('Instrumental track');
            return;
        }
        if (!document?.lines?.length) {
            this._showLyricsMessage('No lyrics found');
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
            idle: ['Translation available on request', 'Translate', true],
            loading: ['Loading translation…', 'Loading…', false],
            available: [
                fromCache ? 'Translation loaded from cache' : 'Translation available',
                'Refresh',
                true,
            ],
            not_configured: ['Translation API key is not configured', '', false],
            provider_unavailable: ['Translation provider unavailable', 'Retry', true],
            network_error: ['Translation network error', 'Retry', true],
            provider_error: ['Translation provider error', 'Retry', true],
            authentication_error: ['Translation API key was rejected', 'Retry', true],
            rate_limited: ['Translation rate limited', 'Retry', true],
            invalid_response: ['Translation response was invalid', 'Retry', true],
            canceled: ['Translation canceled', 'Retry', true],
            same_language: ['Original language matches target language', '', false],
            skipped: ['', '', false],
        };
        const [text, action, enabled] = states[status] ?? states.provider_error;
        this._translationStatusLabel.text = text;
        this._translationActionButton.label = action;
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

    setCurrentLyricIndex(index) {
        if (index === this._activeLyricIndex)
            return;

        const previous = this._lyricRows[this._activeLyricIndex];
        previous?.remove_style_class_name('mpris-lyrics-line-active');
        previous?.remove_style_pseudo_class('selected');
        if (this._activeLyricIndex >= 0)
            this._resetLineText(this._activeLyricIndex);

        this._activeLyricIndex = index;
        this._wordStateSignature = '';
        const current = this._lyricRows[index];
        current?.add_style_class_name('mpris-lyrics-line-active');
        current?.add_style_pseudo_class('selected');

        if (current && this.actor.menu.isOpen)
            this._scheduleScrollToActive();
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
                return `<span alpha="85%">${text}</span>`;
            case 'current':
                return `<span weight="bold" underline="single">${text}</span>`;
            default:
                return `<span alpha="55%">${text}</span>`;
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
            return `${seconds >= 0 ? '+' : ''}${seconds.toFixed(1)}s`;
        };
        this._offsetLabel.text = `Track Offset ${format(trackOffsetMs)}`;
        this._effectiveOffsetLabel.text =
            `Global ${format(globalOffsetMs)}  •  ` +
            `Effective ${format(trackOffsetMs + globalOffsetMs)}`;
        setButtonEnabled(
            this._decreaseButton, trackOffsetMs > MIN_OFFSET_MS);
        setButtonEnabled(
            this._increaseButton, trackOffsetMs < MAX_OFFSET_MS);
        setButtonEnabled(this._resetButton, trackOffsetMs !== 0);
    }

    setMaxPanelWidth(width) {
        const pixels = Math.clamp(Math.round(width), 150, 1000);
        this._label.set_style(`max-width: ${pixels}px;`);
    }

    setPlayers(players, preferredPlayer) {
        this._playerMenu.menu.removeAll();
        const autoItem = this._playerMenu.menu.addAction('Auto', () => {
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
        this._playerMenu.label.text = selected
            ? `Player: ${selected.displayName}`
            : 'Player';
    }

    setVisible(visible) {
        if (!this.actor)
            return;

        if (visible) {
            this.actor.container.show();
            this.actor.show();
        } else {
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

    _clearLyricsRows() {
        this._cancelScheduledScroll();
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

    _scheduleScrollToActive() {
        if (this._scrollLaterId || !this.actor.menu.isOpen ||
            !this._lyricRows[this._activeLyricIndex])
            return;

        this._scrollLaterId = this._laters.add(
            Meta.LaterType.IDLE,
            () => {
                this._scrollLaterId = 0;
                this._scrollToActive();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelScheduledScroll() {
        if (!this._scrollLaterId)
            return;

        this._laters.remove(this._scrollLaterId);
        this._scrollLaterId = 0;
    }

    _scrollToActive() {
        if (!this.actor.menu.isOpen)
            return;

        const row = this._lyricRows[this._activeLyricIndex];
        if (!row)
            return;

        const adjustment = this._scrollView.vadjustment;
        const [, lower, upper, , , pageSize] = adjustment.get_values();
        if (pageSize <= 0)
            return;

        let box = row.get_allocation_box();
        let y1 = box.y1;
        let y2 = box.y2;
        let parent = row.get_parent();
        while (parent !== this._scrollView) {
            if (!parent)
                return;

            box = parent.get_allocation_box();
            y1 += box.y1;
            y2 += box.y1;
            parent = parent.get_parent();
        }

        const maximum = Math.max(lower, upper - pageSize);
        const centered = (y1 + y2 - pageSize) / 2;
        adjustment.set_value(Math.clamp(centered, lower, maximum));
    }

    destroy() {
        this._cancelScheduledScroll();
        this._onOffsetAdjust = null;
        this._onOffsetReset = null;
        this._onPlayerSelected = null;
        this._onPopupOpenChanged = null;
        this._onTranslationAction = null;
        this.actor?.destroy();
        this.actor = null;
        this._label = null;
        this._titleLabel = null;
        this._artistLabel = null;
        this._albumLabel = null;
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
