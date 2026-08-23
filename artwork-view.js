import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {ArtworkLoader} from './artwork-loader.js';

const ARTWORK_SIZE = 80;
const DECODE_TIMEOUT_MS = 3000;
const ARTWORK_CROSSFADE_MS = 220;

function animationsEnabled() {
    return St.Settings.get().enable_animations;
}

function fallbackIcon() {
    return Gio.ThemedIcon.new_from_names([
        'music-note-symbolic',
        'audio-x-generic-symbolic',
        'media-playback-start-symbolic',
    ]);
}

export class ArtworkView {
    constructor({
        loader = new ArtworkLoader(),
        animationsEnabled: animationPreference = animationsEnabled,
    } = {}) {
        this._loader = loader;
        this._animationsEnabled = animationPreference;
        this._generation = 0;
        this._trackKey = null;
        this._artUrl = '';
        this._cancellable = null;
        this._textureActor = null;
        this._pendingTextureActor = null;
        this._outgoingTextureActor = null;
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
            style_class: 'mpris-lyrics-artwork-placeholder',
            x_expand: true,
            y_expand: true,
            child: new St.Icon({
                style_class: 'mpris-lyrics-artwork-fallback-icon',
                gicon: fallbackIcon(),
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
        if (!nextUrl || !trackKey || this._destroyed) {
            this._discardDisplayedTexture();
            this._showFallback();
            return;
        }

        if (this._textureActor)
            this._fallback.hide();
        else
            this._showFallback();

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
            const current = this._isCurrent(
                generation, requestTrackKey, cancellable);
            if (this._cancellable === cancellable)
                this._cancellable = null;
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) &&
                current) {
                console.debug(`MPRIS Lyrics: artwork unavailable: ${error.message}`);
                this._showArtworkFailure();
            }
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
        this._discardDisplayedTexture();
        this._loader?.destroy();
        this._loader = null;
        this._animationsEnabled = null;
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
        texture.opacity = this._textureActor ? 0 : 255;
        this._pendingTextureActor = texture;
        this.actor.add_child(texture);

        const apply = () => {
            if (!texture.content ||
                generation !== this._generation ||
                requestTrackKey !== this._trackKey ||
                texture !== this._pendingTextureActor)
                return;
            this._cancelDecodeWait();
            this._promoteTexture(texture, file, requestTrackKey);
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
                    texture === this._pendingTextureActor) {
                    this._discardPendingTexture();
                    if (remote)
                        this._loader?.discard(file);
                    this._showArtworkFailure();
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
        this._discardPendingTexture();
        this._cancelCrossfade();
    }

    _promoteTexture(texture, file, trackKey) {
        this._pendingTextureActor = null;
        const previous = this._textureActor;
        this._textureActor = texture;
        this._displayedTrackKey = trackKey;
        this._displayedFile = file;
        this._fallback.hide();
        texture.show();

        if (!previous) {
            texture.opacity = 255;
            return;
        }

        this._outgoingTextureActor = previous;
        if (!this._animationsEnabled()) {
            texture.opacity = 255;
            previous.destroy();
            this._outgoingTextureActor = null;
            return;
        }

        previous.remove_all_transitions();
        texture.remove_all_transitions();
        texture.opacity = 0;
        texture.ease({
            opacity: 255,
            duration: ARTWORK_CROSSFADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        previous.ease({
            opacity: 0,
            duration: ARTWORK_CROSSFADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._outgoingTextureActor !== previous)
                    return;
                previous.destroy();
                this._outgoingTextureActor = null;
            },
        });
    }

    _showArtworkFailure() {
        this._discardDisplayedTexture();
        this._showFallback();
    }

    _discardPendingTexture() {
        this._cancelDecodeWait();
        this._pendingTextureActor?.destroy();
        this._pendingTextureActor = null;
    }

    _discardDisplayedTexture() {
        this._cancelCrossfade();
        this._textureActor?.destroy();
        this._textureActor = null;
        this._displayedTrackKey = null;
        this._displayedFile = null;
    }

    _cancelCrossfade() {
        this._outgoingTextureActor?.remove_all_transitions();
        this._outgoingTextureActor?.destroy();
        this._outgoingTextureActor = null;
        this._textureActor?.remove_all_transitions();
        if (this._textureActor)
            this._textureActor.opacity = 255;
    }

    _cancelDecodeWait() {
        if (this._contentSignalId && this._pendingTextureActor) {
            this._pendingTextureActor.disconnect(this._contentSignalId);
            this._contentSignalId = 0;
        }
        if (this._decodeTimeoutId) {
            GLib.source_remove(this._decodeTimeoutId);
            this._decodeTimeoutId = 0;
        }
    }
}
