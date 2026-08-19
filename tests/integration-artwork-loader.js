import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {ArtworkLoader} from '../artwork-loader.js';
import {removeTree} from '../storage.js';

Gio._promisify(Gio.File.prototype,
    'replace_contents_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype,
    'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'close_async', 'close_finish');

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function expectFailure(promise, message) {
    try {
        await promise;
    } catch {
        return;
    }
    throw new Error(message);
}

async function countCacheFiles(directory) {
    const file = Gio.File.new_for_path(directory);
    const enumerator = await file.enumerate_children_async(
        'standard::name',
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        null);
    let count = 0;
    try {
        while (true) {
            const files = await enumerator.next_files_async(
                32, GLib.PRIORITY_DEFAULT, null);
            if (files.length === 0)
                break;
            count += files.filter(info =>
                info.get_name().endsWith('.image')).length;
        }
    } finally {
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
    }
    return count;
}

const png = GLib.base64_decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
const oversized = new Uint8Array(256);
const tempRoot = GLib.dir_make_tmp('mpris-lyrics-artwork-test-XXXXXX');
const cacheDirectory = GLib.build_filenamev([tempRoot, 'cache']);
const localFile = Gio.File.new_for_path(
    GLib.build_filenamev([tempRoot, 'local.png']));
await localFile.replace_contents_async(
    png, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

const server = new Soup.Server();
let requestCount = 0;
server.add_handler(null, (currentServer, message) => {
    requestCount++;
    const path = message.get_uri().get_path();
    if (path === '/missing') {
        message.set_status(Soup.Status.NOT_FOUND, null);
    } else if (path === '/slow') {
        currentServer.pause_message(message);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            message.set_status(Soup.Status.OK, null);
            message.set_response(
                'image/png', Soup.MemoryUse.COPY, png);
            currentServer.unpause_message(message);
            return GLib.SOURCE_REMOVE;
        });
    } else if (path === '/too-large') {
        message.set_status(Soup.Status.OK, null);
        message.set_response(
            'image/png', Soup.MemoryUse.COPY, oversized);
    } else if (path === '/not-image') {
        message.set_status(Soup.Status.OK, null);
        message.set_response(
            'text/plain', Soup.MemoryUse.COPY, png);
    } else {
        message.set_status(Soup.Status.OK, null);
        message.set_response(
            'image/png', Soup.MemoryUse.COPY, png);
    }
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const baseUri = server.get_uris()[0].to_string().replace(/\/$/, '');

const loader = new ArtworkLoader({
    cacheDirectory,
    maxEntries: 2,
    maxTotalBytes: 1024,
    maxResponseBytes: 128,
    timeoutSeconds: 2,
});

try {
    const local = await loader.load(localFile.get_uri());
    assert(local.file.equal(localFile) && !local.remote && !local.fromCache,
        'file artwork should resolve without copying into the remote cache');
    await expectFailure(
        loader.load(`${localFile.get_uri()}-missing`),
        'a disappeared local artwork file should fail safely');
    await expectFailure(
        loader.load('data:image/png;base64,AAAA'),
        'unsupported artwork schemes should be rejected');

    const firstUrl = `${baseUri}/cover-a`;
    const first = await loader.load(firstUrl);
    assert(first.remote && !first.fromCache && requestCount === 1,
        'the first HTTP artwork load should use the network');
    const cached = await loader.load(firstUrl);
    assert(cached.fromCache && requestCount === 1 &&
        cached.file.equal(first.file),
    'the same artUrl should use its hashed disk cache entry');

    await expectFailure(
        loader.load(`${baseUri}/too-large`),
        'streamed artwork should stop at the configured byte limit');
    await expectFailure(
        loader.load(`${baseUri}/not-image`),
        'an explicit non-image response should be rejected');
    await expectFailure(
        loader.load(`${baseUri}/missing`),
        'an HTTP error should keep the fallback path safe');

    const cancellable = new Gio.Cancellable();
    const slowRequest = loader.load(`${baseUri}/slow`, cancellable);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    await expectFailure(slowRequest,
        'canceling an in-flight artwork request should reject it');
    await new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });

    await loader.load(`${baseUri}/cover-b`);
    await loader.load(`${baseUri}/cover-c`);
    assert(await countCacheFiles(cacheDirectory) === 2,
        'oldest-access cleanup should enforce the artwork entry limit');
} finally {
    loader.destroy();
    server.disconnect();
    await removeTree(Gio.File.new_for_path(tempRoot));
}

print('Artwork file, HTTP, cancellation, size limit and cache tests passed');
