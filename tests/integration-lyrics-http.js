import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {LyricsProvider} from '../lyrics.js';

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

function response(message, status, body = '') {
    message.set_status(status, null);
    if (body) {
        message.set_response(
            'application/json',
            Soup.MemoryUse.COPY,
            new TextEncoder().encode(body));
    }
}

const server = new Soup.Server();
const receivedQueries = [];
server.add_handler(null, (currentServer, message) => {
    const query = decodeURIComponent(message.get_uri().get_query() ?? '');
    receivedQueries.push(query);

    if (query.includes('Invalid JSON')) {
        response(message, Soup.Status.OK, '{not json');
    } else if (query.includes('HTTP Error')) {
        response(message, Soup.Status.INTERNAL_SERVER_ERROR);
    } else if (query.includes('No Lyrics')) {
        response(message, Soup.Status.OK, '{"syncedLyrics":null}');
    } else if (query.includes('Malformed LRC')) {
        response(message, Soup.Status.OK,
            '{"syncedLyrics":"this has no timestamps"}');
    } else if (query.includes('Slow Request')) {
        currentServer.pause_message(message);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            response(message, Soup.Status.OK,
                '{"syncedLyrics":"[00:01.00] stale"}');
            currentServer.unpause_message(message);
            return GLib.SOURCE_REMOVE;
        });
    } else {
        response(message, Soup.Status.OK,
            '{"syncedLyrics":"[00:01.00] current"}');
    }
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);

const baseUri = server.get_uris()[0].to_string().replace(/\/$/, '');
const provider = new LyricsProvider({
    apiUrl: `${baseUri}/api/get`,
    requestSpacingMs: 0,
    timeoutSeconds: 2,
    persistentCache: false,
});
const baseTrack = {
    artist: 'MPRIS Lyrics',
    album: 'HTTP Integration',
    durationUs: 120_000_000,
};

function fetch(title) {
    return new Promise(resolve => {
        provider.fetch({...baseTrack, title}, resolve);
    });
}

const loop = new GLib.MainLoop(null, false);
let scenarioError = null;

async function run() {
    const valid = await fetch('Valid Lyrics');
    assert(valid?.length === 1 && valid[0].text === 'current',
        'a valid syncedLyrics response should be parsed');
    const validQuery = receivedQueries.at(-1);
    assert(validQuery.includes('track_name=Valid Lyrics') &&
        validQuery.includes('artist_name=MPRIS Lyrics') &&
        validQuery.includes('album_name=HTTP Integration') &&
        validQuery.includes('duration=120'),
        'the LRCLIB request must include title, artist, album and duration');
    const afterFirstValid = receivedQueries.length;
    const cachedValid = await fetch('Valid Lyrics');
    assert(cachedValid?.[0]?.text === 'current' &&
        receivedQueries.length === afterFirstValid,
        'a successful result should be served from the session cache');
    assert(await fetch('Invalid JSON') === null,
        'invalid JSON should safely return no lyrics');
    assert(await fetch('HTTP Error') === null,
        'an HTTP error should safely return no lyrics');
    assert(await fetch('No Lyrics') === null,
        'a response without syncedLyrics should safely return no lyrics');
    const afterFirstNoLyrics = receivedQueries.length;
    assert(await fetch('No Lyrics') === null &&
        receivedQueries.length === afterFirstNoLyrics,
        'a no-lyrics result should be served from the session cache');
    assert(await fetch('Malformed LRC') === null,
        'malformed LRC should safely return no lyrics');

    await fetch('Cache A');
    await fetch('Cache B');
    const afterCacheB = receivedQueries.length;
    const cacheAAgain = await fetch('Cache A');
    assert(cacheAAgain?.[0]?.text === 'current' &&
        receivedQueries.length === afterCacheB,
        'A -> B -> A should reuse A without another HTTP request');

    const evictionProvider = new LyricsProvider({
        apiUrl: `${baseUri}/api/get`,
        requestSpacingMs: 0,
        timeoutSeconds: 2,
        maxCacheEntries: 2,
        persistentCache: false,
    });
    const evictionFetch = title => new Promise(resolve => {
        evictionProvider.fetch({...baseTrack, title}, resolve);
    });
    const beforeEviction = receivedQueries.length;
    await evictionFetch('Eviction A');
    await evictionFetch('Eviction B');
    await evictionFetch('Eviction A');
    await evictionFetch('Eviction C');
    await evictionFetch('Eviction B');
    assert(receivedQueries.length === beforeEviction + 4,
        'the bounded LRU cache should refresh hits and evict the oldest entry');
    evictionProvider.destroy();

    let staleCallbacks = 0;
    provider.fetch(
        {...baseTrack, title: 'Slow Request'},
        () => staleCallbacks++);
    await sleep(50);
    const current = await fetch('Current Request');
    assert(current?.[0]?.text === 'current',
        'the replacement request should return current lyrics');
    await sleep(650);
    assert(staleCallbacks === 0,
        'a delayed stale response must not invoke its callback');

    let destroyedCallbacks = 0;
    provider.fetch(
        {...baseTrack, title: 'Slow Request'},
        () => destroyedCallbacks++);
    await sleep(50);
    provider.destroy();
    await sleep(650);
    assert(destroyedCallbacks === 0,
        'destroy() must suppress an in-flight Soup response');
}

run()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

provider.destroy();
server.disconnect();

if (scenarioError)
    throw scenarioError;

print('LRCLIB HTTP, cache, JSON, LRC and stale-response integration tests passed');
