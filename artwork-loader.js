import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LOCAL_FILE_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

Gio._promisify(Gio.File.prototype,
    'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype,
    'replace_contents_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype,
    'make_directory_async', 'make_directory_finish');
Gio._promisify(Gio.File.prototype,
    'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype,
    'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype,
    'set_attributes_async', 'set_attributes_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'close_async', 'close_finish');
Gio._promisify(Gio.InputStream.prototype,
    'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype,
    'close_async', 'close_finish');
Gio._promisify(Soup.Session.prototype,
    'send_async', 'send_finish');

function isIoError(error, code) {
    return error.matches?.(Gio.IOErrorEnum, code);
}

function urlScheme(url) {
    const match = /^([A-Za-z][A-Za-z\d+.-]*):/.exec(url);
    return match?.[1]?.toLowerCase() ?? '';
}

function cacheHash(url) {
    return GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256, url, -1);
}

async function ensureDirectory(directory, cancellable = null) {
    const parent = directory.get_parent();
    if (parent)
        await ensureDirectory(parent, cancellable);

    try {
        await directory.make_directory_async(
            GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (!isIoError(error, Gio.IOErrorEnum.EXISTS))
            throw error;
    }
}

async function closeStream(stream) {
    try {
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    } catch {
        // The original request/decode error is more useful than close errors.
    }
}

export function defaultArtworkCacheDirectory() {
    return GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        'mpris-lyrics',
        'artwork',
    ]);
}

export class ArtworkLoader {
    constructor({
        cacheDirectory = defaultArtworkCacheDirectory(),
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
        maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
        timeoutSeconds = 12,
    } = {}) {
        this._cacheDirectory = Gio.File.new_for_path(cacheDirectory);
        this._maxEntries = Math.max(1, Math.floor(maxEntries));
        this._maxTotalBytes = Math.max(1, Math.floor(maxTotalBytes));
        this._maxResponseBytes = Math.max(1, Math.floor(maxResponseBytes));
        this._session = new Soup.Session({
            timeout: timeoutSeconds,
            'idle-timeout': timeoutSeconds,
            'user-agent': 'MPRIS Lyrics/0.9.0 (mpris-lyrics@eureka)',
        });
        this._maintenanceCancellable = new Gio.Cancellable();
    }

    async load(artUrl, cancellable = null) {
        const url = typeof artUrl === 'string' ? artUrl.trim() : '';
        const scheme = urlScheme(url);
        switch (scheme) {
        case 'file':
            return {
                file: await this._loadLocalFile(url, cancellable),
                fromCache: false,
                remote: false,
            };
        case 'http':
        case 'https':
            return this._loadRemoteFile(url, cancellable);
        default:
            throw new Error(`unsupported artwork URI scheme: ${scheme || 'none'}`);
        }
    }

    discard(file) {
        if (!file || !this._isCacheFile(file))
            return;
        file.delete_async(
            GLib.PRIORITY_DEFAULT, this._maintenanceCancellable).catch(() => {});
    }

    destroy() {
        this._session.abort();
        this._session = null;
        this._maintenanceCancellable.cancel();
        this._maintenanceCancellable = null;
    }

    async _loadLocalFile(url, cancellable) {
        const file = Gio.File.new_for_uri(url);
        const info = await file.query_info_async(
            'standard::type,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable);
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            throw new Error('artwork URI is not a regular file');
        const size = info.get_size();
        if (size <= 0 || size > MAX_LOCAL_FILE_BYTES)
            throw new Error(`local artwork size is invalid: ${size}`);
        return file;
    }

    async _loadRemoteFile(url, cancellable) {
        const cacheFile = this._cacheDirectory.get_child(
            `${cacheHash(url)}.image`);
        if (await this._isUsableCacheFile(cacheFile, cancellable)) {
            try {
                await this._touch(cacheFile, cancellable);
            } catch {
                // A usable cached image should survive timestamp failures.
            }
            return {file: cacheFile, fromCache: true, remote: true};
        }

        let message;
        try {
            message = Soup.Message.new('GET', url);
        } catch (error) {
            throw new Error(`invalid artwork URL: ${error.message}`);
        }
        if (!message)
            throw new Error('Soup rejected the artwork URL');

        const stream = await this._session.send_async(
            message, GLib.PRIORITY_DEFAULT, cancellable);
        try {
            if (message.status_code < 200 || message.status_code >= 300)
                throw new Error(`artwork HTTP status ${message.status_code}`);

            const headers = message.get_response_headers();
            const contentLength = headers.get_content_length();
            if (contentLength > this._maxResponseBytes)
                throw new Error('artwork response exceeds the size limit');
            const contentType = headers.get_one('Content-Type') ?? '';
            if (contentType && !contentType.toLowerCase().startsWith('image/'))
                throw new Error(`artwork response is not an image: ${contentType}`);

            const contents = await this._readLimited(stream, cancellable);
            await ensureDirectory(this._cacheDirectory, cancellable);
            await cacheFile.replace_contents_async(
                contents,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                cancellable);
        } finally {
            await closeStream(stream);
        }

        await this._evictOldest(cancellable);
        return {file: cacheFile, fromCache: false, remote: true};
    }

    async _readLimited(stream, cancellable) {
        const chunks = [];
        let total = 0;
        while (true) {
            const bytes = await stream.read_bytes_async(
                READ_CHUNK_BYTES,
                GLib.PRIORITY_DEFAULT,
                cancellable);
            const size = bytes.get_size();
            if (size === 0)
                break;
            total += size;
            if (total > this._maxResponseBytes)
                throw new Error('artwork response exceeds the size limit');
            chunks.push(bytes.get_data());
        }

        if (total === 0)
            throw new Error('artwork response is empty');
        const contents = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            contents.set(chunk, offset);
            offset += chunk.length;
        }
        return contents;
    }

    async _isUsableCacheFile(file, cancellable) {
        try {
            const info = await file.query_info_async(
                'standard::type,standard::size',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable);
            return info.get_file_type() === Gio.FileType.REGULAR &&
                info.get_size() > 0 &&
                info.get_size() <= this._maxResponseBytes;
        } catch (error) {
            if (!isIoError(error, Gio.IOErrorEnum.NOT_FOUND) &&
                !isIoError(error, Gio.IOErrorEnum.CANCELLED))
                console.debug(`MPRIS Lyrics: artwork cache read failed: ${error.message}`);
            return false;
        }
    }

    async _touch(file, cancellable) {
        const info = new Gio.FileInfo();
        info.set_attribute_uint64(
            'time::modified', Math.floor(Date.now() / 1000));
        await file.set_attributes_async(
            info,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable);
    }

    async _evictOldest(cancellable) {
        let enumerator;
        try {
            enumerator = await this._cacheDirectory.enumerate_children_async(
                'standard::name,standard::type,standard::size,time::modified',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT,
                cancellable);
        } catch (error) {
            if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
                return;
            throw error;
        }

        const entries = [];
        try {
            while (true) {
                const batch = await enumerator.next_files_async(
                    64, GLib.PRIORITY_DEFAULT, cancellable);
                if (batch.length === 0)
                    break;
                for (const info of batch) {
                    if (info.get_file_type() !== Gio.FileType.REGULAR ||
                        !info.get_name().endsWith('.image'))
                        continue;
                    entries.push({
                        name: info.get_name(),
                        size: info.get_size(),
                        modified: info.get_attribute_uint64('time::modified'),
                    });
                }
            }
        } finally {
            await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
        }

        entries.sort((left, right) => left.modified - right.modified);
        let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
        let totalEntries = entries.length;
        for (const entry of entries) {
            if (totalEntries <= this._maxEntries &&
                totalBytes <= this._maxTotalBytes)
                break;
            try {
                await this._cacheDirectory.get_child(entry.name)
                    .delete_async(GLib.PRIORITY_DEFAULT, cancellable);
            } catch (error) {
                if (!isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
                    console.debug(`MPRIS Lyrics: artwork cache eviction failed: ${error.message}`);
            }
            totalEntries--;
            totalBytes -= entry.size;
        }
    }

    _isCacheFile(file) {
        const cachePath = this._cacheDirectory.get_path();
        const path = file.get_path();
        return Boolean(cachePath && path &&
            path.startsWith(`${cachePath}${GLib.DIR_SEPARATOR_S}`));
    }
}
