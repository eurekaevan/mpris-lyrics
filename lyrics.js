import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const API_URL = 'https://lrclib.net/api/get';
const USER_AGENT = 'MPRIS Lyrics/1.0 (mpris-lyrics@eureka)';
const REQUEST_SPACING_MS = 300;
const MAX_CACHE_ENTRIES = 64;

export class LrcParser {
    static parse(lrc) {
        if (typeof lrc !== 'string' || !lrc.trim())
            return [];

        const offsetMatch = lrc.match(/^\s*\[offset:([+-]?\d+)\]\s*$/im);
        const offsetUs = offsetMatch ? Number(offsetMatch[1]) * 1000 : 0;
        const entries = [];

        for (const sourceLine of lrc.split(/\r?\n/)) {
            const timestamp = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;
            const times = [];
            let match;

            while ((match = timestamp.exec(sourceLine)) !== null) {
                const minutes = Number(match[1]);
                const seconds = Number(match[2]);
                const timeUs = Math.max(0,
                    Math.round((minutes * 60 + seconds) * 1_000_000) + offsetUs);
                times.push(timeUs);
            }

            if (times.length === 0)
                continue;

            const text = sourceLine.replace(timestamp, '').trim();
            for (const timeUs of times)
                entries.push({timeUs, text});
        }

        entries.sort((a, b) => a.timeUs - b.timeUs);

        // The last value wins for duplicate timestamps.
        const deduplicated = [];
        for (const entry of entries) {
            const previous = deduplicated.at(-1);
            if (previous?.timeUs === entry.timeUs)
                previous.text = entry.text;
            else
                deduplicated.push(entry);
        }

        return deduplicated;
    }

    static currentLine(lines, positionUs) {
        const index = this.currentIndex(lines, positionUs);
        return index >= 0 ? lines[index].text : null;
    }

    static currentIndex(lines, positionUs) {
        if (!Array.isArray(lines) || lines.length === 0)
            return -1;

        let low = 0;
        let high = lines.length - 1;
        let found = -1;

        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (lines[middle].timeUs <= positionUs) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        return found;
    }
}

function requestKey(track) {
    return [track.title, track.artist, track.album, track.durationUs].join('\u0000');
}

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
    } = {}) {
        this._session = new Soup.Session({
            timeout: timeoutSeconds,
            'idle-timeout': timeoutSeconds,
            'user-agent': USER_AGENT,
        });
        this._apiUrl = apiUrl;
        this._requestSpacingMs = requestSpacingMs;
        this._cache = new Map();
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

        const key = requestKey(track);
        if (this._cache.has(key)) {
            const cached = this._cache.get(key);
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

        const serial = this._requestSerial;
        const elapsedMs = (GLib.get_monotonic_time() - this._lastRequestUs) / 1000;
        const delayMs = Math.max(0, this._requestSpacingMs - elapsedMs);
        this._scheduleRequest(track, key, callback, serial, delayMs, 0);
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

        if (this._cache.size > MAX_CACHE_ENTRIES) {
            const oldest = this._cache.keys().next().value;
            this._cache.delete(oldest);
        }
    }
}
