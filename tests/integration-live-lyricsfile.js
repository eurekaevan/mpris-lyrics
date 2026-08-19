import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {normalizeLyricsPayload} from '../lyrics-normalizer.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

// LRCLIB record 196 is also the word-synced example linked from the current
// Lyricsfile documentation. The response stays in memory; this test does not
// vendor the complete third-party lyric text.
const session = new Soup.Session({
    timeout: 15,
    'idle-timeout': 15,
    'user-agent': 'MPRIS Lyrics/4.0 (mpris-lyrics@eureka)',
});
function fetchRecord(id) {
    const message = Soup.Message.new(
        'GET', `https://lrclib.net/api/get/${id}`);
    const bytes = session.send_and_read(message, null);
    assert(message.status_code === 200,
        `LRCLIB record ${id} returned HTTP ${message.status_code}`);
    return JSON.parse(new TextDecoder().decode(bytes.get_data()));
}

const document = normalizeLyricsPayload(fetchRecord(196));
const wordCount = document?.lines?.reduce(
    (total, line) => total + line.words.length, 0) ?? 0;
assert(document?.sourceId === 196 && document.syncLevel === 'word' &&
    document.lines.length > 20 && wordCount > document.lines.length,
'the current real LRCLIB response should normalize to word sync');

print(`Real Lyricsfile response parsed: id=${document.sourceId}, ` +
    `lines=${document.lines.length}, words=${wordCount}`);

GLib.usleep(350_000);
const plainDocument = normalizeLyricsPayload(fetchRecord(9868210));
assert(plainDocument?.syncLevel === 'none' &&
    !plainDocument.instrumental && plainDocument.lines.length > 0 &&
    plainDocument.lines.every(line => line.startMs === null),
'the current real plain-only response should remain unsynchronized');
print(`Real plain-only response parsed: id=${plainDocument.sourceId}, ` +
    `lines=${plainDocument.lines.length}`);

GLib.usleep(350_000);
const instrumentalDocument = normalizeLyricsPayload(fetchRecord(310861));
assert(instrumentalDocument?.instrumental &&
    instrumentalDocument.lines.length === 0,
'the current real instrumental response should remain a positive result');
print(`Real instrumental response parsed: id=${instrumentalDocument.sourceId}`);
session.abort();
