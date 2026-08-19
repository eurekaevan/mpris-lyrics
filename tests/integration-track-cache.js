import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {LyricsProvider} from '../lyrics.js';
import {MprisManager} from '../mpris.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

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

function trackKey(state) {
    const {title, artist, album, durationUs} = state.metadata;
    return [title, artist, album, durationUs].join('\u0000');
}

async function control(busName, method, parameters = null) {
    await Gio.DBus.session.call(
        busName,
        MPRIS_PATH,
        PLAYER_INTERFACE,
        method,
        parameters,
        null,
        Gio.DBusCallFlags.NONE,
        5000,
        null);
}

const loop = new GLib.MainLoop(null, false);
const provider = new LyricsProvider({persistentCache: false});
let state = null;
let networkRequests = 0;
let scenarioError = null;
const sendRequest = provider._sendRequest.bind(provider);
provider._sendRequest = (...args) => {
    networkRequests++;
    return sendRequest(...args);
};

const manager = new MprisManager(nextState => (state = nextState));
manager.start();

async function waitForState(predicate, timeoutMs = 10_000) {
    const deadlineUs = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (!state || !predicate(state)) {
        if (GLib.get_monotonic_time() >= deadlineUs)
            throw new Error('timed out waiting for the expected track');
        await sleep(100);
    }
    return state;
}

function fetchLyrics(metadata) {
    return new Promise(resolve => provider.fetch(metadata, resolve));
}

async function restoreOriginal(original) {
    if (!state || trackKey(state) !== original.key) {
        if (state?.metadata.trackId) {
            await control(original.busName, 'SetPosition',
                new GLib.Variant('(ox)', [state.metadata.trackId, 0]));
        }
        await control(original.busName, 'Previous');
        await waitForState(current => trackKey(current) === original.key, 5000);
    }

    await control(original.busName, 'SetPosition',
        new GLib.Variant('(ox)', [
            original.trackId, Math.round(original.positionUs)]));
    await control(original.busName,
        original.status === 'Playing' ? 'Play' : 'Pause');
}

async function runScenario() {
    const first = await waitForState(current => current.metadata.trackId);
    const original = {
        busName: first.busName,
        key: trackKey(first),
        title: first.metadata.title,
        trackId: first.metadata.trackId,
        positionUs: manager.getPositionUs(),
        status: first.playbackStatus,
    };
    print(`originalTrack=${original.title}`);

    try {
        const firstLyrics = await fetchLyrics(first.metadata);
        assert(firstLyrics?.length > 0,
            'track A should have synchronized lyrics for this live test');
        assert(networkRequests === 1,
            'the first track should perform one LRCLIB request');

        await control(original.busName, 'Next');
        const second = await waitForState(current =>
            trackKey(current) !== original.key &&
            current.metadata.trackId &&
            current.metadata.title &&
            current.metadata.artist &&
            current.metadata.durationUs > 0);
        await control(original.busName, 'Pause');
        const secondLyrics = await fetchLyrics(second.metadata);
        print(`trackB=${second.metadata.title}`);
        print(`trackBArtist=${second.metadata.artist}`);
        print(`networkRequestsAfterB=${networkRequests}`);
        assert(networkRequests === 2,
            'track B should perform one additional LRCLIB request');

        await control(original.busName, 'SetPosition',
            new GLib.Variant('(ox)', [second.metadata.trackId, 0]));
        await control(original.busName, 'Previous');
        const returned = await waitForState(current =>
            trackKey(current) === original.key);
        const requestsBeforeReturn = networkRequests;
        const returnedLyrics = await fetchLyrics(returned.metadata);
        assert(networkRequests === requestsBeforeReturn,
            'returning to A should be a cache hit without another request');
        assert(returnedLyrics?.length === firstLyrics.length,
            'the cached A result should match the original parsed lyrics');

        print(`trackA=${original.title}`);
        print(`trackBHasSyncedLyrics=${Boolean(secondLyrics?.length)}`);
        print(`networkRequests=${networkRequests}`);
        print('Live Firefox A -> B -> A session cache test passed');
    } finally {
        await restoreOriginal(original);
        await sleep(500);
    }
}

let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 35, () => {
    timeoutId = 0;
    scenarioError = new Error('live track-cache test timed out');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

runScenario()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

if (timeoutId)
    GLib.source_remove(timeoutId);
manager.destroy();
provider.destroy();

if (scenarioError)
    throw scenarioError;
