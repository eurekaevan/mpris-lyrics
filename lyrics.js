import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {rankLyricsCandidates} from './lyrics-matcher.js';
import {normalizeLyricsPayload} from './lyrics-normalizer.js';
import {LyricsDiskCache, trackKey} from './storage.js';

export {LrcParser} from './lyrics-parser.js';
export {scoreLyricsCandidate} from './lyrics-matcher.js';
export {normalizeLyricsPayload} from './lyrics-normalizer.js';

const API_URL = 'https://lrclib.net/api/get';
const SEARCH_API_URL = 'https://lrclib.net/api/search';
const USER_AGENT = 'MPRIS Lyrics/0.9.0 (mpris-lyrics@eureka)';
const REQUEST_SPACING_MS = 300;
const MAX_CACHE_ENTRIES = 100;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

Gio._promisify(Gio.InputStream.prototype,
    'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype,
    'close_async', 'close_finish');
Gio._promisify(Soup.Session.prototype,
    'send_async', 'send_finish');

class ResponseTooLargeError extends Error {}

async function readResponse(session, message, limit, cancellable) {
    const stream = await session.send_async(
        message, GLib.PRIORITY_DEFAULT, cancellable);
    try {
        if (message.status_code !== 200)
            return GLib.Bytes.new(new Uint8Array());

        const contentLength = message.get_response_headers()
            .get_content_length();
        if (contentLength > limit)
            throw new ResponseTooLargeError();

        const chunks = [];
        let total = 0;
        while (true) {
            const bytes = await stream.read_bytes_async(
                READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, cancellable);
            const size = bytes.get_size();
            if (size === 0)
                break;
            total += size;
            if (total > limit)
                throw new ResponseTooLargeError();
            chunks.push(bytes.get_data());
        }

        const contents = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            contents.set(chunk, offset);
            offset += chunk.length;
        }
        return GLib.Bytes.new(contents);
    } finally {
        try {
            await stream.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch {
            // The request error is more useful than a stream-close error.
        }
    }
}

function requestParameters(track) {
    const parameters = [
        ['track_name', track.title],
        ['artist_name', track.artist],
    ];
    if (track.album)
        parameters.push(['album_name', track.album]);
    return parameters;
}

function appendQuery(url, parameters) {
    const query = parameters
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('&');
    return `${url}?${query}`;
}

function buildGetUri(track, apiUrl) {
    const parameters = requestParameters(track);
    const duration = Math.round(track.durationUs / 1_000_000);
    if (duration > 0)
        parameters.push(['duration', String(duration)]);
    return appendQuery(apiUrl, parameters);
}

function buildSearchUri(track, searchUrl) {
    return appendQuery(searchUrl, requestParameters(track));
}

function defaultSearchUrl(apiUrl) {
    return apiUrl === API_URL
        ? SEARCH_API_URL
        : apiUrl.replace(/\/api\/get\/?$/, '/api/search');
}

export function retryAfterDelayMs(value, now = Date.now()) {
    if (typeof value !== 'string' || !value.trim())
        return 5000;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.max(1000, Math.ceil(seconds * 1000));

    const date = Date.parse(value);
    if (Number.isFinite(date))
        return Math.max(1000, date - now);
    return 5000;
}

export class LyricsProvider {
    constructor({
        apiUrl = API_URL,
        searchUrl = undefined,
        requestSpacingMs = REQUEST_SPACING_MS,
        timeoutSeconds = 15,
        maxCacheEntries = MAX_CACHE_ENTRIES,
        maxResponseBytes = MAX_RESPONSE_BYTES,
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
        this._searchUrl = searchUrl ?? defaultSearchUrl(apiUrl);
        this._requestSpacingMs = requestSpacingMs;
        this._maxResponseBytes = Math.max(1, Math.floor(maxResponseBytes));
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
        this._pendingKey = null;
        this._pendingCallbacks = [];
    }

    fetch(track, callback) {
        if (!track.title || !track.artist) {
            this.cancelPending();
            callback(null);
            return;
        }

        const key = trackKey(track);
        if (key === this._pendingKey) {
            this._pendingCallbacks.push(callback);
            return;
        }

        this.cancelPending();
        this._pendingKey = key;
        this._pendingCallbacks = [callback];
        const serial = this._requestSerial;

        if (this._cache.has(key)) {
            const cached = this._cache.get(key);
            this._cache.delete(key);
            this._cache.set(key, cached);
            this._delayTimerId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._delayTimerId = 0;
                this._complete(serial, cached);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (this._diskCache) {
            const cancellable = new Gio.Cancellable();
            this._cancellable = cancellable;
            this._readDiskCache(track, key, serial, cancellable);
            return;
        }

        this._scheduleStage(track, key, serial, 'get',
            this._spacingDelayMs(), 0);
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
        this._pendingKey = null;
        this._pendingCallbacks = [];

        if (this._delayTimerId) {
            GLib.source_remove(this._delayTimerId);
            this._delayTimerId = 0;
        }
    }

    destroy() {
        this.cancelPending();
        this._session.abort();
        this._session = null;
        this._cache.clear();
        this._diskCache?.destroy();
        this._diskCache = null;
    }

    _spacingDelayMs() {
        const elapsedMs = (GLib.get_monotonic_time() - this._lastRequestUs) / 1000;
        return Math.max(0, this._requestSpacingMs - elapsedMs);
    }

    _normalize(payload) {
        return normalizeLyricsPayload(payload, {
            onLyricsfileError: error => {
                console.debug(`MPRIS Lyrics: Lyricsfile fallback: ${error.message}`);
            },
        });
    }

    async _readDiskCache(track, key, serial, cancellable) {
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

        if (serial !== this._requestSerial)
            return;

        if (result.hit && result.payload === null) {
            this._remember(key, null);
            this._complete(serial, null);
            return;
        }
        if (result.hit) {
            const document = this._normalize(result.payload);
            if (document) {
                this._remember(key, document);
                this._complete(serial, document);
                return;
            }
        }

        this._scheduleStage(track, key, serial, 'get',
            this._spacingDelayMs(), 0);
    }

    _scheduleStage(track, key, serial, stage, delayMs, attempt) {
        if (serial !== this._requestSerial)
            return;

        if (delayMs <= 0) {
            this._sendRequest(track, key, serial, stage, attempt);
            return;
        }

        this._delayTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(delayMs)),
            () => {
                this._delayTimerId = 0;
                if (serial === this._requestSerial)
                    this._sendRequest(track, key, serial, stage, attempt);
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(
            this._delayTimerId, `[mpris-lyrics] LRCLIB ${stage} delay`);
    }

    _sendRequest(track, key, serial, stage, attempt) {
        if (serial !== this._requestSerial)
            return;

        let message;
        try {
            const uri = stage === 'get'
                ? buildGetUri(track, this._apiUrl)
                : buildSearchUri(track, this._searchUrl);
            message = Soup.Message.new('GET', uri);
            if (!message)
                throw new Error('Soup rejected the request URI');
        } catch (error) {
            console.warn(`MPRIS Lyrics: invalid LRCLIB request: ${error.message}`);
            this._complete(serial, null);
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._lastRequestUs = GLib.get_monotonic_time();

        readResponse(this._session, message,
            this._maxResponseBytes, cancellable).then(bytes => {
                if (this._cancellable === cancellable)
                    this._cancellable = null;

                if (serial !== this._requestSerial)
                    return;

                // Soup.Status in the Fedora typelib predates HTTP 429. Reading
                // the enum-returning get_status() throws for that valid code;
                // the numeric property remains forward-compatible.
                const status = message.status_code;
                if (status === 429 && attempt === 0) {
                    const retryValue = message.get_response_headers()
                        .get_one('Retry-After');
                    this._scheduleStage(track, key, serial, stage,
                        retryAfterDelayMs(retryValue), attempt + 1);
                    return;
                }

                if (status === 404 && stage === 'get') {
                    this._scheduleStage(track, key, serial, 'search',
                        this._spacingDelayMs(), 0);
                    return;
                }

                if (status === 404) {
                    this._cacheNegative(track, key, serial);
                    return;
                }

                if (status !== 200) {
                    console.warn(`MPRIS Lyrics: LRCLIB returned HTTP ${status}`);
                    this._complete(serial, null);
                    return;
                }

                let json;
                try {
                    json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                } catch (error) {
                    console.warn(`MPRIS Lyrics: invalid LRCLIB response: ${error.message}`);
                    this._complete(serial, null);
                    return;
                }

                if (stage === 'search') {
                    const best = rankLyricsCandidates(track, json)
                        .find(item => item.accepted);
                    if (!best) {
                        this._cacheNegative(track, key, serial);
                        return;
                    }

                    this._remember(key, best.document);
                    this._persist(track, best.candidate);
                    this._complete(serial, best.document);
                    return;
                }

                const document = this._normalize(json);
                if (!document) {
                    // Preserve the provider payload even when today's parser
                    // cannot render it. A future parser can retry from disk
                    // without discarding the original Lyricsfile.
                    this._remember(key, null);
                    this._persist(track, json);
                    this._complete(serial, null);
                    return;
                }

                this._remember(key, document);
                this._persist(track, json);
                this._complete(serial, document);
            }).catch(error => {
                if (this._cancellable === cancellable)
                    this._cancellable = null;
                if (serial !== this._requestSerial ||
                    error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                if (error instanceof ResponseTooLargeError) {
                    console.warn('MPRIS Lyrics: LRCLIB response exceeded the size limit');
                } else {
                    console.warn(`MPRIS Lyrics: LRCLIB request failed: ${error.message}`);
                }
                this._complete(serial, null);
            });
    }

    _cacheNegative(track, key, serial) {
        this._remember(key, null);
        this._persist(track, null);
        this._complete(serial, null);
    }

    _complete(serial, value) {
        if (serial !== this._requestSerial)
            return;

        const callbacks = this._pendingCallbacks;
        this._pendingCallbacks = [];
        this._pendingKey = null;
        for (const callback of callbacks) {
            try {
                callback(value);
            } catch (error) {
                logError(error, 'MPRIS Lyrics callback failed');
            }
        }
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

    _persist(track, payload) {
        this._diskCache?.put(track, payload).catch(error => {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`MPRIS Lyrics: could not write lyrics cache: ${error.message}`);
        });
    }
}
