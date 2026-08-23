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
const receivedRequests = [];
let rateLimitAttempts = 0;
server.add_handler(null, (currentServer, message) => {
    const query = decodeURIComponent(message.get_uri().get_query() ?? '');
    const path = message.get_uri().get_path();
    receivedRequests.push({
        path,
        query,
        userAgent: message.get_request_headers().get_one('User-Agent'),
    });

    if (query.includes('Search Match') && path.endsWith('/api/get')) {
        response(message, Soup.Status.NOT_FOUND);
    } else if (query.includes('Search Match') && path.endsWith('/api/search')) {
        response(message, Soup.Status.OK, JSON.stringify([
            {
                id: 90,
                trackName: 'Unrelated first result',
                artistName: 'Someone Else',
                albumName: 'Wrong',
                duration: 120,
                syncedLyrics: '[00:01.00]wrong',
            },
            {
                id: 91,
                trackName: 'Search Match',
                artistName: 'MPRIS Lyrics',
                albumName: 'HTTP Integration',
                duration: 120.5,
                syncedLyrics: '[00:01.00]scored candidate',
            },
        ]));
    } else if (query.includes('Search Reject') && path.endsWith('/api/get')) {
        response(message, Soup.Status.NOT_FOUND);
    } else if (query.includes('Search Reject') && path.endsWith('/api/search')) {
        response(message, Soup.Status.OK, JSON.stringify([{
            id: 92,
            trackName: 'Different Song',
            artistName: 'Someone Else',
            albumName: 'Wrong',
            duration: 500,
            syncedLyrics: '[00:01.00]wrong',
        }]));
    } else if (query.includes('Rate Limited') && rateLimitAttempts++ === 0) {
        message.get_response_headers().append('Retry-After', '1');
        response(message, 429);
    } else if (query.includes('Invalid JSON')) {
        response(message, Soup.Status.OK, '{not json');
    } else if (query.includes('HTTP Error')) {
        response(message, Soup.Status.INTERNAL_SERVER_ERROR);
    } else if (query.includes('No Lyrics')) {
        response(message, Soup.Status.OK, '{"syncedLyrics":null}');
    } else if (query.includes('Malformed LRC')) {
        response(message, Soup.Status.OK,
            '{"syncedLyrics":"this has no timestamps"}');
    } else if (query.includes('Large Response')) {
        response(message, Soup.Status.OK, JSON.stringify({
            syncedLyrics: `[00:01.00]${'x'.repeat(256)}`,
        }));
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
let provider = new LyricsProvider({
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
    assert(valid?.syncLevel === 'line' && valid.lines[0].text === 'current',
        'a valid syncedLyrics response should normalize to a document');
    const validRequest = receivedRequests.at(-1);
    const validQuery = validRequest.query;
    assert(validQuery.includes('track_name=Valid Lyrics') &&
        validQuery.includes('artist_name=MPRIS Lyrics') &&
        validQuery.includes('album_name=HTTP Integration') &&
        validQuery.includes('duration=120'),
        'the LRCLIB request must include title, artist, album and duration');
    assert(validRequest.userAgent === 'MPRIS Lyrics/0.9.0 (mpris-lyrics@eureka)',
        'requests should identify this extension, not impersonate a browser');
    const afterFirstValid = receivedRequests.length;
    const cachedValid = await fetch('Valid Lyrics');
    assert(cachedValid?.lines?.[0]?.text === 'current' &&
        receivedRequests.length === afterFirstValid,
        'a successful result should be served from the session cache');
    assert(await fetch('Invalid JSON') === null,
        'invalid JSON should safely return no lyrics');
    assert(await fetch('HTTP Error') === null,
        'an HTTP error should safely return no lyrics');
    assert(await fetch('No Lyrics') === null,
        'a response without syncedLyrics should safely return no lyrics');
    const afterFirstNoLyrics = receivedRequests.length;
    assert(await fetch('No Lyrics') === null &&
        receivedRequests.length === afterFirstNoLyrics,
        'a no-lyrics result should be served from the session cache');
    assert(await fetch('Malformed LRC') === null,
        'malformed LRC should safely return no lyrics');

    const limitedProvider = new LyricsProvider({
        apiUrl: `${baseUri}/api/get`,
        requestSpacingMs: 0,
        maxResponseBytes: 64,
        persistentCache: false,
    });
    const oversized = await new Promise(resolve => {
        limitedProvider.fetch(
            {...baseTrack, title: 'Large Response'}, resolve);
    });
    assert(oversized === null,
        'an LRCLIB response above the configured limit should be rejected');
    limitedProvider.destroy();

    await fetch('Cache A');
    await fetch('Cache B');
    const afterCacheB = receivedRequests.length;
    const cacheAAgain = await fetch('Cache A');
    assert(cacheAAgain?.lines?.[0]?.text === 'current' &&
        receivedRequests.length === afterCacheB,
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
    const beforeEviction = receivedRequests.length;
    await evictionFetch('Eviction A');
    await evictionFetch('Eviction B');
    await evictionFetch('Eviction A');
    await evictionFetch('Eviction C');
    await evictionFetch('Eviction B');
    assert(receivedRequests.length === beforeEviction + 4,
        'the bounded LRU cache should refresh hits and evict the oldest entry');
    evictionProvider.destroy();

    const beforeSearch = receivedRequests.length;
    const searched = await fetch('Search Match');
    assert(searched?.sourceId === 91 &&
        searched.lines[0].text === 'scored candidate' &&
        receivedRequests.length === beforeSearch + 2 &&
        receivedRequests.at(-1).path.endsWith('/api/search') &&
        !receivedRequests.at(-1).query.includes('duration='),
    'a /get 404 should search and score all candidates instead of taking the first');
    assert(await fetch('Search Reject') === null,
        'a low-confidence search result should be treated as no lyrics');

    const rateLimitStartUs = GLib.get_monotonic_time();
    const rateLimited = await fetch('Rate Limited');
    const rateLimitDelayMs =
        (GLib.get_monotonic_time() - rateLimitStartUs) / 1000;
    assert(rateLimited?.lines?.[0]?.text === 'current' &&
        rateLimitAttempts === 2 && rateLimitDelayMs >= 900,
    '429 handling should honor Retry-After before one bounded retry');

    const beforeCoalesced = receivedRequests.length;
    const coalescedTrack = {...baseTrack, title: 'Coalesced Slow Request'};
    const coalesced = await Promise.all([
        new Promise(resolve => provider.fetch(coalescedTrack, resolve)),
        new Promise(resolve => provider.fetch(coalescedTrack, resolve)),
    ]);
    assert(receivedRequests.length === beforeCoalesced + 1 &&
        coalesced.every(document => document?.lines?.[0]?.text === 'stale'),
    'concurrent requests for the same track should be coalesced');

    let staleCallbacks = 0;
    provider.fetch(
        {...baseTrack, title: 'Slow Request'},
        () => staleCallbacks++);
    await sleep(50);
    const current = await fetch('Current Request');
    assert(current?.lines?.[0]?.text === 'current',
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
    provider = null;
    await sleep(650);
    assert(destroyedCallbacks === 0,
        'destroy() must suppress an in-flight Soup response');
}

run()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

provider?.destroy();
server.disconnect();

if (scenarioError)
    throw scenarioError;

print('LRCLIB get/search/scoring, 429, coalescing, cache and cancellation tests passed');
