import GLib from 'gi://GLib';

import {parseMetadata} from '../mpris.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const metadata = new GLib.Variant('a{sv}', {
    'mpris:trackid': new GLib.Variant('o', '/org/mpris/MediaPlayer2/example'),
    'xesam:title': new GLib.Variant('s', ' Example Song '),
    'xesam:artist': new GLib.Variant('as', ['First Artist', 'Second Artist']),
    'xesam:album': new GLib.Variant('s', 'Example Album'),
    'mpris:length': new GLib.Variant('x', 220_000_000),
});
const parsed = parseMetadata(metadata);

assert(parsed.trackId === '/org/mpris/MediaPlayer2/example',
    'track ID should be unpacked');
assert(parsed.title === 'Example Song', 'title should be unpacked and trimmed');
assert(parsed.artist === 'First Artist, Second Artist',
    'multiple artists should be joined');
assert(parsed.album === 'Example Album', 'album should be unpacked');
assert(parsed.durationUs === 220_000_000, 'duration should stay in microseconds');

print('MPRIS metadata tests passed');
