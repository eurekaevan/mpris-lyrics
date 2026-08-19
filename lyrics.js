import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {LrcParser} from './lyrics-parser.js';
import {LyricsDiskCache, trackKey} from './storage.js';

export {LrcParser} from './lyrics-parser.js';

const API_URL = 'https://lrclib.net/api/get';
const USER_AGENT = 'MPRIS Lyrics/1.0 (mpris-lyrics@eureka)';
const REQUEST_SPACING_MS = 300;
const MAX_CACHE_ENTRIES = 100;

function buildRequestUri(track, apiUrl = API_URL) {
    const parameters = [
        ['track_name', track.title],
        ['artist_name', track.artist],
    ];

    if (track.album)
        parameters.push(['album_name', track.album]);

    const duration = Math.round(track.durationUs / 1_000_000);
    if (duration > 0)
        parameters.push(['duration', String(duration)]);

    const query = parameters
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('&');
    return `${apiUrl}?${query}`;
}

export class LyricsProvider {
    constructor({
        apiUrl = API_URL,
        requestSpacingMs = REQUEST_SPACING_MS,
        timeoutSeconds = 15,
        maxCacheEntries = MAX_CACHE_ENTRIES,
        persistentCache = true,
        cacheRoot = undefined,
        diskCacheOptions = {},
    } = {}) {
        this._session = new Soup.Session({
            timeout: timeoutSeconds,
            'idle-timeout': timeoutSeconds,
            'user-agent': USER_AGENT,
        });
        this._apiUrl = apiUrl;
        this._requestSpacingMs = requestSpacingMs;
        const cacheLimit = Math.floor(maxCacheEntries);
        this._maxCacheEntries = Number.isFinite(cacheLimit)
            ? Math.max(1, cacheLimit)
            : MAX_CACHE_ENTRIES;
        this._cache = new Map();
        this._diskCache = persistentCache
            ? new LyricsDiskCache({
                ...diskCacheOptions,
                ...(cacheRoot === undefined ? {} : {cacheRoot}),
            })
            : null;
        this._cancellable = null;
        this._delayTimerId = 0;
        this._requestSerial = 0;
        this._lastRequestUs = 0;
        this._destroyed = false;
    }

    fetch(track, callback) {
        this.cancelPending();

        if (this._destroyed || !track.title || !track.artist) {
            callback(null);
            return;
        }

        const key = trackKey(track);
        if (this._cache.has(key)) {
            const cached = this._cache.get(key);
            // Refresh insertion order so the first entry remains the least
            // recently used one.
            this._cache.delete(key);
            this._cache.set(key, cached);
            // Run through the main loop so cached and network requests have the
            // same callback lifetime semantics.
            this._delayTimerId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._delayTimerId = 0;
                if (!this._destroyed)
                    callback(cached);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (this._diskCache) {
            const cancellable = new Gio.Cancellable();
            this._cancellable = cancellable;
            const serial = this._requestSerial;
            this._readDiskCache(track, key, callback, serial, cancellable);
            return;
        }

        const serial = this._requestSerial;
        const elapsedMs = (GLib.get_monotonic_time() - this._lastRequestUs) / 1000;
        const delayMs = Math.max(0, this._requestSpacingMs - elapsedMs);
        this._scheduleRequest(track, key, callback, serial, delayMs, 0);
    }

    clearMemoryCache() {
        this._cache.clear();
    }

    async clearCaches() {
        this.cancelPending();
        this.clearMemoryCache();
        await this._diskCache?.clear();
    }

    cancelPending() {
        this._requestSerial++;
        this._cancellable?.cancel();
        this._cancellable = null;

        if (this._delayTimerId) {
            GLib.source_remove(this._delayTimerId);
            this._delayTimerId = 0;
        }
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this.cancelPending();
        this._session.abort();
        this._session = null;
        this._cache.clear();
        this._diskCache = null;
    }

    async _readDiskCache(track, key, callback, serial, cancellable) {
        let result = {hit: false};
        try {
            result = await this._diskCache.get(track, cancellable);
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`MPRIS Lyrics: lyrics disk cache read failed: ${error.message}`);
        } finally {
            if (this._cancellable === cancellable)
                this._cancellable = null;
        }

        if (serial !== this._requestSerial || this._destroyed)
            return;

        if (result.hit) {
            this._remember(key, result.lines);
            callback(result.lines);
            return;
        }

        const elapsedMs = (GLib.get_monotonic_time() - this._lastRequestUs) / 1000;
        const delayMs = Math.max(0, this._requestSpacingMs - elapsedMs);
        this._scheduleRequest(track, key, callback, serial, delayMs, 0);
    }

    _scheduleRequest(track, key, callback, serial, delayMs, attempt) {
        if (serial !== this._requestSerial || this._destroyed)
            return;

        if (delayMs <= 0) {
            this._sendRequest(track, key, callback, serial, attempt);
            return;
        }

        this._delayTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(delayMs)),
            () => {
                this._delayTimerId = 0;
                if (serial === this._requestSerial && !this._destroyed)
                    this._sendRequest(track, key, callback, serial, attempt);
                return GLib.SOURCE_REMOVE;
            });
    }

    _sendRequest(track, key, callback, serial, attempt) {
        if (serial !== this._requestSerial || this._destroyed)
            return;

        let message;
        try {
            message = Soup.Message.new(
                'GET', buildRequestUri(track, this._apiUrl));
            if (!message)
                throw new Error('Soup rejected the request URI');
        } catch (error) {
            console.warn(`MPRIS Lyrics: invalid LRCLIB request: ${error.message}`);
            callback(null);
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._lastRequestUs = GLib.get_monotonic_time();

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                if (this._cancellable === cancellable)
                    this._cancellable = null;

                let bytes;
                try {
                    bytes = session.send_and_read_finish(result);
                } catch (error) {
                    if (serial === this._requestSerial && !this._destroyed &&
                        !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        console.warn(`MPRIS Lyrics: LRCLIB request failed: ${error.message}`);
                        callback(null);
                    }
                    return;
                }

                if (serial !== this._requestSerial || this._destroyed)
                    return;

                const status = message.get_status();
                if (status === 429 && attempt === 0) {
                    const retryValue = message.get_response_headers()
                        .get_one('Retry-After');
                    const retrySeconds = Math.max(1, Number(retryValue) || 5);
                    this._scheduleRequest(
                        track, key, callback, serial, retrySeconds * 1000, attempt + 1);
                    return;
                }

                if (status === 404) {
                    this._remember(key, null);
                    this._persist(track, null, null);
                    callback(null);
                    return;
                }

                if (status !== 200) {
                    console.warn(`MPRIS Lyrics: LRCLIB returned HTTP ${status}`);
                    callback(null);
                    return;
                }

                try {
                    const json = JSON.parse(
                        new TextDecoder().decode(bytes.get_data()));
                    const lines = LrcParser.parse(json.syncedLyrics);
                    const value = lines.length > 0 ? lines : null;
                    this._remember(key, value);
                    this._persist(
                        track,
                        json.id ?? null,
                        value ? json.syncedLyrics : null);
                    callback(value);
                } catch (error) {
                    console.warn(`MPRIS Lyrics: invalid LRCLIB response: ${error.message}`);
                    callback(null);
                }
            });
    }

    _remember(key, value) {
        if (this._cache.has(key))
            this._cache.delete(key);
        this._cache.set(key, value);

        if (this._cache.size > this._maxCacheEntries) {
            const oldest = this._cache.keys().next().value;
            this._cache.delete(oldest);
        }
    }

    _persist(track, resultId, syncedLyrics) {
        this._diskCache?.put(track, {resultId, syncedLyrics}).catch(error => {
            console.warn(`MPRIS Lyrics: could not write lyrics cache: ${error.message}`);
        });
    }
}
