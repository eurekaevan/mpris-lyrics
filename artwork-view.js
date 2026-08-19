import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {ArtworkLoader} from './artwork-loader.js';

const ARTWORK_SIZE = 96;
const DECODE_TIMEOUT_MS = 3000;

function fallbackIcon() {
    return Gio.ThemedIcon.new_from_names([
        'music-note-symbolic',
        'audio-x-generic-symbolic',
        'media-playback-start-symbolic',
    ]);
}

export class ArtworkView {
    constructor({loader = new ArtworkLoader()} = {}) {
        this._loader = loader;
        this._generation = 0;
        this._trackKey = null;
        this._artUrl = '';
        this._cancellable = null;
        this._textureActor = null;
        this._displayedTrackKey = null;
        this._displayedFile = null;
        this._contentSignalId = 0;
        this._decodeTimeoutId = 0;
        this._destroyed = false;

        this.actor = new St.Widget({
            style_class: 'mpris-lyrics-artwork',
            layout_manager: new Clutter.BinLayout(),
            width: ARTWORK_SIZE,
            height: ARTWORK_SIZE,
            clip_to_allocation: true,
            reactive: false,
            can_focus: false,
        });
        this._fallback = new St.Bin({
            style_class: 'mpris-lyrics-artwork-fallback',
            x_expand: true,
            y_expand: true,
            child: new St.Icon({
                style_class: 'mpris-lyrics-artwork-fallback-icon',
                gicon: fallbackIcon(),
                icon_size: 36,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        this.actor.add_child(this._fallback);
    }

    setArtwork(artUrl, trackKey) {
        const nextUrl = typeof artUrl === 'string' ? artUrl.trim() : '';
        if (nextUrl === this._artUrl && trackKey === this._trackKey)
            return;

        const generation = ++this._generation;
        this._artUrl = nextUrl;
        this._trackKey = trackKey;
        this._resetRequest();
        this._showFallback();
        if (!nextUrl || !trackKey || this._destroyed)
            return;

        const requestTrackKey = trackKey;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._loader.load(nextUrl, cancellable).then(result => {
            if (!this._isCurrent(generation, requestTrackKey, cancellable))
                return;
            this._cancellable = null;
            this._loadTexture(result.file, result.remote,
                generation, requestTrackKey);
        }).catch(error => {
            if (this._cancellable === cancellable)
                this._cancellable = null;
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) &&
                this._isCurrent(generation, requestTrackKey, cancellable))
                console.debug(`MPRIS Lyrics: artwork unavailable: ${error.message}`);
        });
    }

    clear() {
        this.setArtwork('', null);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._generation++;
        this._resetRequest();
        this._loader?.destroy();
        this._loader = null;
        this.actor?.destroy();
        this.actor = null;
    }

    _loadTexture(file, remote, generation, requestTrackKey) {
        let resourceScale = 1;
        try {
            const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
            resourceScale = Math.max(1, Math.ceil(
                scaleFactor * (this.actor.get_resource_scale?.() ?? 1)));
        } catch {
            // A not-yet-mapped actor uses the logical 1x fallback.
        }

        const texture = St.TextureCache.get_default().load_file_async(
            file, ARTWORK_SIZE, ARTWORK_SIZE, 1, resourceScale);
        texture.set_x_align(Clutter.ActorAlign.CENTER);
        texture.set_y_align(Clutter.ActorAlign.CENTER);
        this._textureActor = texture;
        this.actor.add_child(texture);

        const apply = () => {
            if (!texture.content ||
                generation !== this._generation ||
                requestTrackKey !== this._trackKey ||
                texture !== this._textureActor)
                return;
            this._cancelDecodeWait();
            this._fallback.hide();
            texture.show();
            this._displayedTrackKey = requestTrackKey;
            this._displayedFile = file;
        };

        if (texture.content) {
            apply();
            return;
        }

        this._contentSignalId = texture.connect('notify::content', apply);
        this._decodeTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DECODE_TIMEOUT_MS,
            () => {
                this._decodeTimeoutId = 0;
                if (generation === this._generation &&
                    requestTrackKey === this._trackKey &&
                    texture === this._textureActor) {
                    this._discardTexture();
                    if (remote)
                        this._loader?.discard(file);
                }
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(
            this._decodeTimeoutId, '[mpris-lyrics] artwork decode timeout');
    }

    _isCurrent(generation, trackKey, cancellable) {
        return !this._destroyed && generation === this._generation &&
            trackKey === this._trackKey && !cancellable.is_cancelled();
    }

    _showFallback() {
        this._fallback?.show();
    }

    _resetRequest() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._discardTexture();
    }

    _discardTexture() {
        this._cancelDecodeWait();
        this._textureActor?.destroy();
        this._textureActor = null;
        this._displayedTrackKey = null;
        this._displayedFile = null;
        this._showFallback();
    }

    _cancelDecodeWait() {
        if (this._contentSignalId && this._textureActor) {
            this._textureActor.disconnect(this._contentSignalId);
            this._contentSignalId = 0;
        }
        if (this._decodeTimeoutId) {
            GLib.source_remove(this._decodeTimeoutId);
            this._decodeTimeoutId = 0;
        }
    }
}
