import GLib from 'gi://GLib';

import {LyricsProvider} from '../lyrics.js';
import {LyricsSynchronizer} from '../lyrics-synchronizer.js';
import {MprisManager} from '../mpris.js';

const loop = new GLib.MainLoop(null, false);
const provider = new LyricsProvider();
let networkRequests = 0;
const sendRequest = provider._sendRequest.bind(provider);
provider._sendRequest = (...args) => {
    networkRequests++;
    return sendRequest(...args);
};
let requested = false;
let finished = false;
let lyricsFinished = false;
let selectedPlayer = null;

function maybeFinish() {
    if (!lyricsFinished || !selectedPlayer)
        return;

    print(`identity=${selectedPlayer.identity}`);
    print(`desktopEntry=${selectedPlayer.desktopEntry}`);
    print(`stableId=${selectedPlayer.stableId}`);
    print(`networkRequests=${networkRequests}`);
    finished = true;
    loop.quit();
}

const manager = new MprisManager(state => {
    if (!state || requested)
        return;

    requested = true;
    print(`player=${state.busName}`);
    print(`status=${state.playbackStatus}`);
    print(`title=${state.metadata.title}`);
    print(`artist=${state.metadata.artist}`);
    print(`album=${state.metadata.album}`);
    print(`durationUs=${state.metadata.durationUs}`);
    print(`positionUs=${Math.round(state.positionUs)}`);

    provider.fetch(state.metadata, document => {
        const index = LyricsSynchronizer.currentLineIndex(
            document, manager.getPositionUs() / 1000);
        print(`syncLevel=${document?.syncLevel ?? 'missing'}`);
        print(`lyricsLines=${document?.lines?.length ?? 0}`);
        print(`currentLineAvailable=${index >= 0}`);
        lyricsFinished = true;
        maybeFinish();
    });
}, {
    onPlayersChanged: players => {
        selectedPlayer = players.find(player => player.selected) ?? null;
        maybeFinish();
    },
});

manager.start();
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
    if (!finished)
        printerr('integration test timed out');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();

manager.destroy();
provider.destroy();

if (!finished)
    throw new Error('current-player integration test did not finish');
