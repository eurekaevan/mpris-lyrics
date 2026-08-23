import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const LYRICS_CACHE_VERSION = 2;
const OFFSET_STORE_VERSION = 1;
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LYRICS_CACHE_ENTRIES = 500;
const MAX_OFFSET_ENTRIES = 500;
const MIN_OFFSET_MS = -10_000;
const MAX_OFFSET_MS = 10_000;

Gio._promisify(Gio.File.prototype,
    'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype,
    'replace_contents_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype,
    'make_directory_async', 'make_directory_finish');
Gio._promisify(Gio.File.prototype,
    'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype,
    'delete_async', 'delete_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'close_async', 'close_finish');

function isNotFound(error) {
    return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

function isExists(error) {
    return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS);
}

function clampOffset(offsetMs) {
    const value = Math.round(Number(offsetMs));
    return Math.min(
        MAX_OFFSET_MS,
        Math.max(MIN_OFFSET_MS, Number.isFinite(value) ? value : 0));
}

async function ensureDirectory(directory, cancellable = null) {
    const parent = directory.get_parent();
    if (parent)
        await ensureDirectory(parent, cancellable);

    try {
        await directory.make_directory_async(
            GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (!isExists(error))
            throw error;
    }
}

async function readJson(file, cancellable = null) {
    const [contents] = await file.load_contents_async(cancellable);
    return JSON.parse(new TextDecoder().decode(contents));
}

async function writeJson(file, value, cancellable = null) {
    await ensureDirectory(file.get_parent(), cancellable);
    const contents = new TextEncoder().encode(JSON.stringify(value));
    await file.replace_contents_async(
        contents,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        cancellable);
}

async function listChildren(directory, cancellable = null) {
    let enumerator;
    try {
        enumerator = await directory.enumerate_children_async(
            'standard::name,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            cancellable);
    } catch (error) {
        if (isNotFound(error))
            return [];
        throw error;
    }

    const children = [];
    try {
        while (true) {
            const batch = await enumerator.next_files_async(
                64, GLib.PRIORITY_DEFAULT, cancellable);
            if (batch.length === 0)
                break;
            children.push(...batch);
        }
    } finally {
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
    }
    return children;
}

export function trackKey(track) {
    return [
        track.title ?? '',
        track.artist ?? '',
        track.album ?? '',
        Math.max(0, Number(track.durationUs) || 0),
    ].join('\u0000');
}

export function trackHash(track) {
    return GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256, trackKey(track), -1);
}

export function defaultCacheRoot() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'mpris-lyrics']);
}

export function defaultConfigRoot() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'mpris-lyrics']);
}

export async function removeTree(file, cancellable = null) {
    for (let attempt = 0; attempt < 5; attempt++) {
        let children;
        try {
            children = await listChildren(file, cancellable);
        } catch (error) {
            if (isNotFound(error))
                return;
            throw error;
        }

        for (const info of children) {
            const child = file.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                await removeTree(child, cancellable);
            } else {
                try {
                    await child.delete_async(
                        GLib.PRIORITY_DEFAULT, cancellable);
                } catch (error) {
                    if (!isNotFound(error))
                        throw error;
                }
            }
        }

        try {
            await file.delete_async(GLib.PRIORITY_DEFAULT, cancellable);
            return;
        } catch (error) {
            if (isNotFound(error))
                return;
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_EMPTY))
                throw error;
        }
    }

    throw new Error(`cache directory remained busy: ${file.get_path()}`);
}

export async function clearLyricsCache(
    cacheRoot = defaultCacheRoot(), cancellable = null) {
    const lyricsDirectory = Gio.File.new_for_path(
        GLib.build_filenamev([cacheRoot, 'lyrics']));
    await removeTree(lyricsDirectory, cancellable);
}

export class LyricsDiskCache {
    constructor({
        cacheRoot = defaultCacheRoot(),
        positiveTtlMs = POSITIVE_TTL_MS,
        negativeTtlMs = NEGATIVE_TTL_MS,
        maxEntries = MAX_LYRICS_CACHE_ENTRIES,
        now = () => Date.now(),
    } = {}) {
        this._directory = Gio.File.new_for_path(
            GLib.build_filenamev([cacheRoot, 'lyrics']));
        this._positiveTtlMs = positiveTtlMs;
        this._negativeTtlMs = negativeTtlMs;
        this._maxEntries = Math.max(1, Math.floor(maxEntries));
        this._now = now;
        this._pendingWrites = new Set();
        this._cancellable = new Gio.Cancellable();
    }

    async get(track, cancellable = null) {
        const hash = trackHash(track);
        const file = this._directory.get_child(`${hash}.json`);
        let record;
        try {
            record = await readJson(file, cancellable);
        } catch (error) {
            if (!isNotFound(error) &&
                !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`MPRIS Lyrics: ignoring lyrics cache entry: ${error.message}`);
            return {hit: false};
        }

        const decoded = this._decodeRecord(record, hash);
        if (!decoded.valid)
            return {hit: false};

        const ttl = record.negative
            ? this._negativeTtlMs
            : this._positiveTtlMs;
        if (this._now() - record.fetchedAt > ttl) {
            file.delete_async(
                GLib.PRIORITY_DEFAULT, this._cancellable).catch(() => {});
            return {hit: false};
        }

        record.lastAccessed = this._now();
        this._trackWrite(writeJson(
            file, record, this._cancellable)).catch(error => {
            console.debug(`MPRIS Lyrics: could not refresh lyrics cache entry: ${error.message}`);
        });
        return {hit: true, payload: decoded.payload, record};
    }

    put(track, payload = null) {
        return this._trackWrite(this._put(
            track, payload, this._cancellable));
    }

    async _put(track, payload, cancellable) {
        const hash = trackHash(track);
        const now = this._now();
        const raw = this._sanitizePayload(payload);
        const negative = !raw.instrumental &&
            ![raw.plainLyrics, raw.syncedLyrics, raw.lyricsfile]
                .some(value => typeof value === 'string' && value.trim());
        const record = {
            version: LYRICS_CACHE_VERSION,
            trackHash: hash,
            title: track.title ?? '',
            artist: track.artist ?? '',
            album: track.album ?? '',
            durationUs: Math.max(0, Number(track.durationUs) || 0),
            id: raw.id,
            instrumental: raw.instrumental,
            plainLyrics: raw.plainLyrics,
            syncedLyrics: raw.syncedLyrics,
            lyricsfile: raw.lyricsfile,
            negative,
            fetchedAt: now,
            lastAccessed: now,
        };
        const file = this._directory.get_child(`${hash}.json`);
        await writeJson(file, record, cancellable);
        await this._evictOldest(cancellable);
    }

    async clear() {
        await Promise.allSettled([...this._pendingWrites]);
        await removeTree(this._directory, this._cancellable);
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
    }

    _trackWrite(promise) {
        this._pendingWrites.add(promise);
        promise.then(
            () => this._pendingWrites.delete(promise),
            () => this._pendingWrites.delete(promise));
        return promise;
    }

    _sanitizePayload(payload) {
        return {
            id: Number.isInteger(payload?.id) ? payload.id : null,
            instrumental: payload?.instrumental === true,
            plainLyrics: typeof payload?.plainLyrics === 'string'
                ? payload.plainLyrics
                : null,
            syncedLyrics: typeof payload?.syncedLyrics === 'string'
                ? payload.syncedLyrics
                : null,
            lyricsfile: typeof payload?.lyricsfile === 'string'
                ? payload.lyricsfile
                : null,
        };
    }

    _decodeRecord(record, hash) {
        const commonValid = record?.trackHash === hash &&
            typeof record.title === 'string' &&
            typeof record.artist === 'string' &&
            typeof record.album === 'string' &&
            Number.isFinite(record.durationUs) &&
            Number.isFinite(record.fetchedAt) &&
            typeof record.negative === 'boolean';
        if (!commonValid)
            return {valid: false};

        if (record.version === 1) {
            if (!record.negative && typeof record.syncedLyrics !== 'string')
                return {valid: false};
            return {
                valid: true,
                payload: record.negative
                    ? null
                    : {
                        id: Number.isInteger(record.resultId)
                            ? record.resultId
                            : null,
                        instrumental: false,
                        plainLyrics: null,
                        syncedLyrics: record.syncedLyrics,
                        lyricsfile: null,
                        trackName: record.title,
                        artistName: record.artist,
                        albumName: record.album,
                        duration: record.durationUs / 1_000_000,
                    },
            };
        }

        if (record.version !== LYRICS_CACHE_VERSION)
            return {valid: false};
        if (typeof record.instrumental !== 'boolean' ||
            !['plainLyrics', 'syncedLyrics', 'lyricsfile'].every(field =>
                record[field] === null || typeof record[field] === 'string'))
            return {valid: false};
        if (record.negative)
            return {valid: true, payload: null};

        return {
            valid: true,
            payload: {
                id: Number.isInteger(record.id) ? record.id : null,
                instrumental: record.instrumental,
                plainLyrics: record.plainLyrics,
                syncedLyrics: record.syncedLyrics,
                lyricsfile: record.lyricsfile,
                trackName: record.title,
                artistName: record.artist,
                albumName: record.album,
                duration: record.durationUs / 1_000_000,
            },
        };
    }

    async _evictOldest(cancellable) {
        const children = (await listChildren(this._directory, cancellable))
            .filter(info => info.get_file_type() === Gio.FileType.REGULAR &&
                info.get_name().endsWith('.json'));
        if (children.length <= this._maxEntries)
            return;

        const ages = [];
        for (const info of children) {
            let lastAccessed = 0;
            try {
                const record = await readJson(
                    this._directory.get_child(info.get_name()), cancellable);
                lastAccessed = Number(record.lastAccessed) ||
                    Number(record.fetchedAt) || 0;
            } catch {
                // Corrupt entries are the first eviction candidates.
            }
            ages.push({info, lastAccessed});
        }
        ages.sort((a, b) => a.lastAccessed - b.lastAccessed);
        for (const {info} of ages.slice(0, ages.length - this._maxEntries)) {
            try {
                await this._directory.get_child(info.get_name())
                    .delete_async(GLib.PRIORITY_DEFAULT, cancellable);
            } catch (error) {
                if (!isNotFound(error))
                    throw error;
            }
        }
    }
}

export class OffsetStore {
    constructor({
        configRoot = defaultConfigRoot(),
        maxEntries = MAX_OFFSET_ENTRIES,
        onLoaded = null,
        now = () => Date.now(),
    } = {}) {
        this._file = Gio.File.new_for_path(
            GLib.build_filenamev([configRoot, 'offsets.json']));
        this._maxEntries = Math.max(1, Math.floor(maxEntries));
        this._onLoaded = onLoaded;
        this._now = now;
        this._entries = new Map();
        this._dirty = false;
        this._saving = false;
        this._savePromise = null;
        this._cancellable = new Gio.Cancellable();
        this._loadedPromise = this._load();
    }

    get(track) {
        const hash = trackHash(track);
        const entry = this._entries.get(hash);
        if (!entry)
            return 0;

        entry.lastAccessed = this._now();
        this._markDirty();
        return entry.offsetMs;
    }

    set(track, offsetMs) {
        const hash = trackHash(track);
        const value = clampOffset(offsetMs);
        if (value === 0) {
            this._entries.delete(hash);
        } else {
            this._entries.set(hash, {
                offsetMs: value,
                lastAccessed: this._now(),
            });
        }
        this._evictOldest();
        this._markDirty();
        return value;
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
        this._onLoaded = null;
        this._entries.clear();
    }

    async ready() {
        await this._loadedPromise;
    }

    async flush() {
        await this._loadedPromise;
        if (this._dirty && !this._saving)
            this._savePromise = this._saveLoop();
        await this._savePromise;
    }

    async _load() {
        const cancellable = this._cancellable;
        let data = null;
        try {
            data = await readJson(this._file, cancellable);
        } catch (error) {
            if (!isNotFound(error) &&
                !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`MPRIS Lyrics: ignoring offset store: ${error.message}`);
        }

        if (cancellable.is_cancelled())
            return;

        if (data?.version === OFFSET_STORE_VERSION && data.entries &&
            typeof data.entries === 'object') {
            const loaded = new Map();
            for (const [hash, entry] of Object.entries(data.entries)) {
                if (!/^[0-9a-f]{64}$/.test(hash) ||
                    !Number.isFinite(entry?.offsetMs) ||
                    !Number.isFinite(entry?.lastAccessed))
                    continue;
                const offsetMs = clampOffset(entry.offsetMs);
                if (offsetMs !== 0)
                    loaded.set(hash, {offsetMs, lastAccessed: entry.lastAccessed});
            }

            // Adjustments made before the asynchronous load completed win.
            for (const [hash, entry] of this._entries)
                loaded.set(hash, entry);
            this._entries = loaded;
            this._evictOldest();
        }

        this._onLoaded?.();
    }

    _evictOldest() {
        if (this._entries.size <= this._maxEntries)
            return;

        const oldest = [...this._entries.entries()]
            .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
            .slice(0, this._entries.size - this._maxEntries);
        for (const [hash] of oldest)
            this._entries.delete(hash);
    }

    _markDirty() {
        this._dirty = true;
        if (!this._saving)
            this._savePromise = this._saveLoop();
    }

    async _saveLoop() {
        const cancellable = this._cancellable;
        this._saving = true;
        await this._loadedPromise;
        while (this._dirty && !cancellable.is_cancelled()) {
            this._dirty = false;
            const entries = Object.fromEntries(this._entries);
            try {
                await writeJson(this._file, {
                    version: OFFSET_STORE_VERSION,
                    entries,
                }, cancellable);
            } catch (error) {
                if (!error.matches?.(
                    Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    console.warn(`MPRIS Lyrics: could not save track offsets: ${error.message}`);
                }
            }
        }
        this._saving = false;
    }
}
