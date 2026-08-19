import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {LyricsProvider} from '../lyrics.js';
import {
    clearLyricsCache,
    LyricsDiskCache,
    OffsetStore,
    removeTree,
    trackHash,
} from '../storage.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function sleep(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function waitForFile(path) {
    for (let attempt = 0; attempt < 40; attempt++) {
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return;
        await sleep(25);
    }
    throw new Error(`timed out waiting for cache file ${path}`);
}

const tempRoot = GLib.dir_make_tmp('mpris-lyrics-storage-XXXXXX');
const trackA = {
    title: 'Persistent A',
    artist: 'Storage Artist',
    album: 'Cache Album',
    durationUs: 180_000_000,
};
const trackB = {...trackA, title: 'Persistent B'};
const trackC = {...trackA, title: 'Persistent C'};

const server = new Soup.Server();
let networkRequests = 0;
server.add_handler(null, (_server, message) => {
    networkRequests++;
    const query = decodeURIComponent(message.get_uri().get_query() ?? '');
    const noLyrics = query.includes('No Lyrics');
    message.set_status(Soup.Status.OK, null);
    message.set_response(
        'application/json',
        Soup.MemoryUse.COPY,
        new TextEncoder().encode(JSON.stringify({
            id: noLyrics ? 0 : 42,
            syncedLyrics: noLyrics ? null : '[00:01.00] persistent line',
        })));
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const apiUrl = `${server.get_uris()[0].to_string().replace(/\/$/, '')}/api/get`;

function providerFetch(provider, track) {
    return new Promise(resolve => provider.fetch(track, resolve));
}

const loop = new GLib.MainLoop(null, false);
let scenarioError = null;

async function run() {
    let now = 10_000;
    const directRoot = GLib.build_filenamev([tempRoot, 'direct-cache']);
    const diskCache = new LyricsDiskCache({
        cacheRoot: directRoot,
        positiveTtlMs: 100,
        negativeTtlMs: 50,
        maxEntries: 2,
        now: () => now,
    });
    await diskCache.put(trackA, {
        resultId: 7,
        syncedLyrics: '[00:01.00] cached A',
    });
    let cached = await diskCache.get(trackA);
    assert(cached.hit && cached.lines?.[0]?.text === 'cached A' &&
        cached.record.resultId === 7,
    'a positive disk entry should retain raw lyrics and the LRCLIB ID');

    await diskCache.put(trackB, {syncedLyrics: null});
    cached = await diskCache.get(trackB);
    assert(cached.hit && cached.lines === null && cached.record.negative,
        'a no-lyrics result should be a negative disk-cache hit');

    const trackAPath = GLib.build_filenamev([
        directRoot, 'lyrics', `${trackHash(trackA)}.json`,
    ]);
    GLib.file_set_contents(trackAPath, '{broken json');
    cached = await diskCache.get(trackA);
    assert(!cached.hit, 'corrupt JSON should be treated as a safe miss');

    await diskCache.put(trackA, {syncedLyrics: '[00:01.00] fresh'});
    now += 101;
    cached = await diskCache.get(trackA);
    assert(!cached.hit, 'an expired positive entry should be a miss');
    now += 50;
    cached = await diskCache.get(trackB);
    assert(!cached.hit, 'an expired negative entry should be a miss');

    const evictionRoot = GLib.build_filenamev([tempRoot, 'eviction-cache']);
    let evictionNow = 1;
    const evictionCache = new LyricsDiskCache({
        cacheRoot: evictionRoot,
        maxEntries: 2,
        now: () => evictionNow++,
    });
    await evictionCache.put(trackA, {syncedLyrics: '[00:01.00] A'});
    await evictionCache.put(trackB, {syncedLyrics: '[00:01.00] B'});
    await evictionCache.put(trackC, {syncedLyrics: '[00:01.00] C'});
    assert(!(await evictionCache.get(trackA)).hit &&
        (await evictionCache.get(trackB)).hit &&
        (await evictionCache.get(trackC)).hit,
    'disk eviction should remove the oldest entry above the size limit');

    const configRoot = GLib.build_filenamev([tempRoot, 'config']);
    let offsetNow = 100;
    const offsets = new OffsetStore({
        configRoot,
        maxEntries: 2,
        now: () => offsetNow++,
    });
    await offsets.ready();
    offsets.set(trackA, 1000);
    offsets.set(trackB, -500);
    await offsets.flush();
    offsets.destroy();

    const reloadedOffsets = new OffsetStore({configRoot, maxEntries: 2});
    await reloadedOffsets.ready();
    assert(reloadedOffsets.get(trackA) === 1000 &&
        reloadedOffsets.get(trackB) === -500 &&
        reloadedOffsets.get(trackC) === 0,
    'per-track offsets should survive store recreation and remain isolated');
    reloadedOffsets.set(trackC, 500);
    await reloadedOffsets.flush();
    reloadedOffsets.destroy();

    const providerRoot = GLib.build_filenamev([tempRoot, 'provider-cache']);
    const providerOptions = {
        apiUrl,
        cacheRoot: providerRoot,
        requestSpacingMs: 0,
        timeoutSeconds: 2,
    };
    const firstProvider = new LyricsProvider(providerOptions);
    const firstLines = await providerFetch(firstProvider, trackA);
    assert(firstLines?.[0]?.text === 'persistent line' && networkRequests === 1,
        'the first provider load should use LRCLIB');
    const providerCachePath = GLib.build_filenamev([
        providerRoot, 'lyrics', `${trackHash(trackA)}.json`,
    ]);
    await waitForFile(providerCachePath);
    firstProvider.destroy();

    const secondProvider = new LyricsProvider(providerOptions);
    const diskLines = await providerFetch(secondProvider, trackA);
    assert(diskLines?.[0]?.text === 'persistent line' && networkRequests === 1,
        'provider recreation should use L2 without another LRCLIB request');

    const noLyricsTrack = {...trackA, title: 'No Lyrics'};
    assert(await providerFetch(secondProvider, noLyricsTrack) === null &&
        networkRequests === 2,
    'the first no-lyrics lookup should reach LRCLIB');
    const negativePath = GLib.build_filenamev([
        providerRoot, 'lyrics', `${trackHash(noLyricsTrack)}.json`,
    ]);
    await waitForFile(negativePath);
    secondProvider.destroy();

    const thirdProvider = new LyricsProvider(providerOptions);
    assert(await providerFetch(thirdProvider, noLyricsTrack) === null &&
        networkRequests === 2,
    'a fresh provider should reuse a persistent negative result');

    await clearLyricsCache(providerRoot);
    await thirdProvider.clearCaches();
    const afterClear = await providerFetch(thirdProvider, trackA);
    assert(afterClear?.[0]?.text === 'persistent line' && networkRequests === 3,
        'clearing L1 and L2 should force the next LRCLIB request');
    thirdProvider.destroy();

    await removeTree(Gio.File.new_for_path(tempRoot));
}

run()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

server.disconnect();
if (scenarioError)
    throw scenarioError;

print('Persistent lyrics cache, expiry, corruption, clear and offset tests passed');
