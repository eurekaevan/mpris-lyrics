import GLib from 'gi://GLib';

import {LrcParser, LyricsProvider} from '../lyrics.js';
import {MprisManager} from '../mpris.js';

const loop = new GLib.MainLoop(null, false);
const provider = new LyricsProvider();
let requested = false;
let finished = false;

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

    provider.fetch(state.metadata, lines => {
        print(`syncedLines=${lines?.length ?? 0}`);
        print(`currentLine=${LrcParser.currentLine(lines, manager.getPositionUs()) ?? ''}`);
        finished = true;
        loop.quit();
    });
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
