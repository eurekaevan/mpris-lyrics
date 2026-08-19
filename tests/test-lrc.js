import {LrcParser} from '../lyrics.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const lines = LrcParser.parse(`
[ar:Example]
[offset:+100]
[00:01.00] First line
[00:02.5][00:03.050] Repeated line
[00:04.00]
`);

assert(lines.length === 4, 'all timestamped lines should be parsed');
assert(lines[0].timeUs === 1_100_000, 'the global offset should be applied');
assert(lines[1].timeUs === 2_600_000, 'one-digit fractions should mean tenths');
assert(lines[2].timeUs === 3_150_000, 'three-digit fractions should mean milliseconds');
assert(LrcParser.currentLine(lines, 1_000_000) === null,
    'there should be no lyric before the first timestamp');
assert(LrcParser.currentLine(lines, 2_600_000) === 'Repeated line',
    'binary search should match an exact timestamp');
assert(LrcParser.currentLine(lines, 4_100_000) === '',
    'an empty timestamp should clear the previous lyric');
assert(LrcParser.currentIndex(lines, 1_000_000) === -1,
    'the binary search index should identify positions before the first line');
assert(LrcParser.currentIndex(lines, 3_150_000) === 2,
    'the binary search index should identify the exact current entry');

const duplicate = LrcParser.parse('[00:01.00] old\n[00:01.00] new');
assert(duplicate.length === 1 && duplicate[0].text === 'new',
    'the last duplicate timestamp should win');

print('LRC parser tests passed');
