import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {LyricsProvider} from '../lyrics.js';
import {LyricsSynchronizer} from '../lyrics-synchronizer.js';
import {MprisManager} from '../mpris.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

function sleep(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
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
const provider = new LyricsProvider();
let state = null;
let document = null;
let fetchedKey = null;
let previousSample = null;
let pausedAnchor = null;
let playingAdvanced = false;
let pausedStayedStill = false;
let forwardSeekObserved = false;
let backwardSeekObserved = false;
let resolveReady;
let scenarioError = null;
const ready = new Promise(resolve => (resolveReady = resolve));

function maybeReady() {
    if (state)
        resolveReady();
}

const manager = new MprisManager(nextState => {
    state = nextState;
    if (!state)
        return;

    const key = [
        state.metadata.title,
        state.metadata.artist,
        state.metadata.album,
        state.metadata.durationUs,
    ].join('\u0000');
    if (key !== fetchedKey) {
        fetchedKey = key;
        document = null;
        provider.fetch(state.metadata, result => {
            document = result;
            print(`lyrics-loaded=${document?.lines?.length ?? 0}`);
            maybeReady();
        });
    }
    maybeReady();
});

manager.start();
const sampleTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    if (!state)
        return GLib.SOURCE_CONTINUE;

    const nowUs = GLib.get_monotonic_time();
    const positionUs = manager.getPositionUs();

    if (previousSample) {
        const jumpUs = positionUs - previousSample.positionUs;
        if (jumpUs > 5_000_000)
            forwardSeekObserved = true;
        else if (jumpUs < -5_000_000)
            backwardSeekObserved = true;

        if (state.playbackStatus === 'Playing' &&
            previousSample.status === 'Playing' &&
            positionUs - previousSample.positionUs > 100_000)
            playingAdvanced = true;
    }

    if (state.playbackStatus === 'Paused') {
        pausedAnchor ??= {positionUs, nowUs};
        if (nowUs - pausedAnchor.nowUs > 800_000 &&
            Math.abs(positionUs - pausedAnchor.positionUs) < 100_000)
            pausedStayedStill = true;
    } else {
        pausedAnchor = null;
    }

    const index = LyricsSynchronizer.currentLineIndex(
        document, positionUs / 1000);
    const line = document?.lines?.[index]?.text ?? '';
    print(`sample=${state.playbackStatus},${Math.round(positionUs)},${line}`);
    previousSample = {positionUs, status: state.playbackStatus};
    return GLib.SOURCE_CONTINUE;
});

let timeoutTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
    timeoutTimerId = 0;
    scenarioError = new Error('playback synchronization test timed out');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

async function runScenario() {
    await ready;

    const original = {
        busName: state.busName,
        status: state.playbackStatus,
        positionUs: manager.getPositionUs(),
        trackId: state.metadata.trackId,
        durationUs: state.metadata.durationUs,
    };
    if (!original.trackId)
        throw new Error('the player did not expose mpris:trackid');

    const safeEndUs = Math.max(0, original.durationUs - 5_000_000);
    const backwardTargetUs = Math.min(20_000_000, safeEndUs * 0.2);
    const forwardTargetUs = Math.min(
        safeEndUs, Math.max(backwardTargetUs + 15_000_000, safeEndUs * 0.65));
    if (forwardTargetUs - backwardTargetUs < 5_000_000)
        throw new Error('the track is too short for forward/backward seek checks');

    try {
        await control(original.busName, 'Pause');
        await sleep(1000);
        await control(original.busName, 'SetPosition',
            new GLib.Variant('(ox)', [
                original.trackId, Math.round(backwardTargetUs)]));
        await sleep(800);
        await control(original.busName, 'SetPosition',
            new GLib.Variant('(ox)', [
                original.trackId, Math.round(forwardTargetUs)]));
        await sleep(1000);
        await control(original.busName, 'Play');
        await sleep(2000);
        await control(original.busName, 'Pause');
        await sleep(1200);
        await control(original.busName, 'SetPosition',
            new GLib.Variant('(ox)', [
                original.trackId, Math.round(backwardTargetUs)]));
        await sleep(1000);
    } finally {
        await control(original.busName, 'SetPosition',
            new GLib.Variant('(ox)', [original.trackId,
                Math.round(original.positionUs)]));
        await control(original.busName,
            original.status === 'Playing' ? 'Play' : 'Pause');
        await sleep(500);
    }
}

runScenario()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

if (timeoutTimerId)
    GLib.source_remove(timeoutTimerId);
GLib.source_remove(sampleTimerId);
manager.destroy();
provider.destroy();

if (scenarioError)
    throw scenarioError;
if (!playingAdvanced)
    throw new Error('the local position did not advance while playing');
if (!pausedStayedStill)
    throw new Error('the local position did not remain stable while paused');
if (!forwardSeekObserved)
    throw new Error('the forward seek was not observed');
if (!backwardSeekObserved)
    throw new Error('the backward seek was not observed');

print('Playback, pause, resume and bidirectional seek synchronization test passed');
