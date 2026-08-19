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
    } = {}) {
        this._onOffsetAdjust = onOffsetAdjust ?? null;
        this._onOffsetReset = onOffsetReset ?? null;
        this._onPlayerSelected = onPlayerSelected ?? null;
        this._lyricRows = [];
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
        this.actor.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._scheduleScrollToActive();
            else
                this._cancelScheduledScroll();
        });

        this.setOffsets(0, 0);
        this.setPlayers([], 'auto');
        this._showLyricsMessage('No synchronized lyrics found');
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
        this._showLyricsMessage('Loading synchronized lyrics…');
    }

    clearTrack() {
        this._titleLabel.text = '';
        this._artistLabel.text = '';
        this._albumLabel.text = '';
        this._albumLabel.hide();
        this._clearLyricsRows();
    }

    setLyrics(lines) {
        if (!lines?.length) {
            this._showLyricsMessage('No synchronized lyrics found');
            return;
        }

        this._clearLyricsRows();
        for (const line of lines) {
            const row = new PopupMenu.PopupBaseMenuItem({
                style_class: 'mpris-lyrics-line',
                reactive: false,
                can_focus: false,
            });
            const label = new St.Label({
                text: line.text,
                x_expand: true,
            });
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            label.clutter_text.set_line_wrap(true);
            label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            row.add_child(label);
            this._lyricsBox.add_child(row);
            this._lyricRows.push(row);
        }
    }

    setCurrentLyricIndex(index) {
        if (index === this._activeLyricIndex)
            return;

        const previous = this._lyricRows[this._activeLyricIndex];
        previous?.remove_style_class_name('mpris-lyrics-line-active');
        previous?.remove_style_pseudo_class('selected');

        this._activeLyricIndex = index;
        const current = this._lyricRows[index];
        current?.add_style_class_name('mpris-lyrics-line-active');
        current?.add_style_pseudo_class('selected');

        if (current && this.actor.menu.isOpen)
            this._scheduleScrollToActive();
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
    }

    _clearLyricsRows() {
        this._cancelScheduledScroll();
        this._lyricsBox.destroy_all_children();
        this._lyricRows = [];
        this._activeLyricIndex = -1;
        this._messageLabel = null;
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
        this._offsetLabel = null;
        this._effectiveOffsetLabel = null;
        this._decreaseButton = null;
        this._increaseButton = null;
        this._resetButton = null;
        this._playerMenu = null;
    }
}
