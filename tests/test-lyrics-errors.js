import GLib from 'gi://GLib';

import {LyricsProvider} from '../lyrics.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const track = {
    title: 'Error Test',
    artist: 'MPRIS Lyrics',
    album: 'Network Failure',
    durationUs: 123_000_000,
};

function waitForCallback(start) {
    const loop = new GLib.MainLoop(null, false);
    let timedOut = false;
    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        timeoutId = 0;
        timedOut = true;
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    start(loop);
    loop.run();

    if (timeoutId)
        GLib.source_remove(timeoutId);
    assert(!timedOut, 'the error-path callback timed out');
}

const invalidProvider = new LyricsProvider({
    apiUrl: 'not a valid URI',
    requestSpacingMs: 0,
    persistentCache: false,
});
let invalidCallbacks = 0;
invalidProvider.fetch(track, lines => {
    invalidCallbacks++;
    assert(lines === null, 'an invalid URI should return no lyrics');
});
invalidProvider.destroy();
assert(invalidCallbacks === 1,
    'an invalid URI should complete exactly once');

const failedProvider = new LyricsProvider({
    apiUrl: 'http://127.0.0.1:9/api/get',
    requestSpacingMs: 0,
    timeoutSeconds: 1,
    persistentCache: false,
});
let failureCallbacks = 0;
waitForCallback(loop => {
    failedProvider.fetch(track, lines => {
        failureCallbacks++;
        assert(lines === null, 'a network failure should return no lyrics');
        loop.quit();
    });
});
failedProvider.destroy();
assert(failureCallbacks === 1,
    'a network failure should complete exactly once');

const replacementProvider = new LyricsProvider({
    apiUrl: 'http://127.0.0.1:9/api/get',
    requestSpacingMs: 0,
    timeoutSeconds: 1,
    persistentCache: false,
});
let staleCallbacks = 0;
let currentCallbacks = 0;
waitForCallback(loop => {
    replacementProvider.fetch(
        {...track, title: 'Stale Request'},
        () => staleCallbacks++);
    replacementProvider.fetch(
        {...track, title: 'Current Request'},
        lines => {
            currentCallbacks++;
            assert(lines === null,
                'the current failed request should return no lyrics');
            loop.quit();
        });
});
replacementProvider.destroy();
assert(staleCallbacks === 0,
    'a cancelled stale request must not invoke its callback');
assert(currentCallbacks === 1,
    'the replacement request should complete exactly once');

const destroyedProvider = new LyricsProvider({
    apiUrl: 'http://127.0.0.1:9/api/get',
    requestSpacingMs: 0,
    timeoutSeconds: 1,
    persistentCache: false,
});
let destroyedCallbacks = 0;
destroyedProvider.fetch(track, () => destroyedCallbacks++);
destroyedProvider.destroy();

const cleanupLoop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    cleanupLoop.quit();
    return GLib.SOURCE_REMOVE;
});
cleanupLoop.run();
assert(destroyedCallbacks === 0,
    'destroy() must suppress callbacks from cancelled requests');

print('Lyrics provider error, cancellation and cleanup tests passed');
