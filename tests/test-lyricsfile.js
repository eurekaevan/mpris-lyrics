import GLib from 'gi://GLib';

import {SyncLevel} from '../lyrics-document.js';
import {normalizeLyricsPayload} from '../lyrics-normalizer.js';
import {LrcParser} from '../lyrics-parser.js';
import {LyricsfileParser} from '../lyricsfile-parser.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function fixture(name) {
    const path = GLib.build_filenamev([
        GLib.get_current_dir(), 'tests', 'fixtures', 'lyrics', name,
    ]);
    const [ok, contents] = GLib.file_get_contents(path);
    assert(ok, `could not read fixture ${name}`);
    return new TextDecoder().decode(contents);
}

const lrcDocument = LrcParser.parseDocument(fixture('line-synced.lrc'));
assert(lrcDocument.syncLevel === SyncLevel.LINE &&
    lrcDocument.lines[0].startMs === 1100 &&
    lrcDocument.lines[1].text === '第二行',
'LRC should normalize to a Unicode-safe line-synced LyricsDocument');
assert(LrcParser.parseDocument(fixture('malformed.lrc')).syncLevel ===
    SyncLevel.NONE,
'malformed LRC should safely produce an unsynchronized document');

const lineDocument = LyricsfileParser.parse(fixture('lyricsfile-line.yaml'));
assert(lineDocument.syncLevel === SyncLevel.LINE &&
    lineDocument.lines[1].text === '' &&
    lineDocument.lines[2].endMs === null,
'Lyricsfile should preserve quoting, blank lines, and optional line ends');

const wordDocument = LyricsfileParser.parse(fixture('lyricsfile-word.yaml'));
assert(wordDocument.syncLevel === SyncLevel.WORD &&
    wordDocument.lines[0].words.map(word => word.text).join('') ===
        wordDocument.lines[0].text &&
    wordDocument.lines[0].words.every(word => word.endMs === null),
'the documented LRCLIB word-timing shape should preserve spaces and missing ends');

const cjkDocument = LyricsfileParser.parse(fixture('lyricsfile-cjk.yaml'));
assert(cjkDocument.syncLevel === SyncLevel.WORD &&
    cjkDocument.lines[0].words.map(word => word.text).join('') === '你好，世界！',
'CJK and punctuation tokens should round-trip without inserted spaces');

const instrumentalResponse = JSON.parse(
    fixture('lrclib-instrumental-response.json'));
const instrumental = normalizeLyricsPayload(instrumentalResponse);
assert(instrumental.instrumental && instrumental.lines.length === 0 &&
    instrumental.sourceId === 310861,
'the real LRCLIB instrumental response should be a positive document');

let malformedFailed = false;
try {
    LyricsfileParser.parse(fixture('lyricsfile-malformed.yaml'));
} catch {
    malformedFailed = true;
}
assert(malformedFailed, 'malformed YAML should fail the Lyricsfile parser');

for (const [name, source] of [
    ['duplicate keys', "version: '1.0'\nversion: '1.0'\nmetadata: {title: T, artist: A}\n"],
    ['unknown version', "version: '2.0'\nmetadata: {title: T, artist: A}\n"],
    ['anchors', "version: '1.0'\nmetadata: &m {title: T, artist: A}\ncopy: *m\n"],
]) {
    let rejected = false;
    try {
        LyricsfileParser.parse(source);
    } catch {
        rejected = true;
    }
    assert(rejected, `Lyricsfile should reject ${name}`);
}

const fallback = normalizeLyricsPayload({
    id: 7,
    trackName: 'Fallback',
    artistName: 'Fixture Artist',
    lyricsfile: fixture('lyricsfile-malformed.yaml'),
    syncedLyrics: '[00:01.00]Synced fallback',
    plainLyrics: 'Plain fallback',
});
assert(fallback.syncLevel === SyncLevel.LINE &&
    fallback.source === 'lrclib-synced' &&
    fallback.lines[0].text === 'Synced fallback',
'Lyricsfile failure must fall back to syncedLyrics');

const plain = normalizeLyricsPayload({
    id: 8,
    trackName: 'Plain',
    artistName: 'Fixture Artist',
    lyricsfile: fixture('lyricsfile-malformed.yaml'),
    syncedLyrics: null,
    plainLyrics: 'First\n\nآخر',
});
assert(plain.syncLevel === SyncLevel.NONE && plain.lines.length === 3 &&
    plain.lines[2].text === 'آخر',
'plain lyrics should remain static, preserve blank lines, and support RTL text');

print('Lyricsfile, LRC, fallback, Unicode, plain and instrumental tests passed');
