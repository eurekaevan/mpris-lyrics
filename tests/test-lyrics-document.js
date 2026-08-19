import {createLyricsDocument, SyncLevel} from '../lyrics-document.js';
import {LyricsSynchronizer} from '../lyrics-synchronizer.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const overlapping = createLyricsDocument({
    source: 'test',
    lines: [{
        text: 'one two together',
        startMs: 1000,
        endMs: 4000,
        words: [
            {text: 'one ', startMs: 1000, endMs: 2200},
            {text: 'two ', startMs: 1800, endMs: 2500},
            {text: 'together', startMs: 1800, endMs: 4000},
        ],
    }],
});
assert(overlapping.syncLevel === SyncLevel.WORD,
    'intentional overlap and equal word starts should remain word sync');
assert(LyricsSynchronizer.wordStates(overlapping, 0, 1900).join(',') ===
    'current,current,current',
'overlapping words with equal timestamps should all be current');
assert(LyricsSynchronizer.nextWordBoundaryMs(overlapping, 0, 1900) === 2200,
    'the scheduler should choose the next word boundary, not a polling tick');

const incompleteWords = createLyricsDocument({
    source: 'test',
    lines: [{
        text: 'word timing',
        startMs: 1000,
        endMs: 3000,
        words: [
            {text: 'word ', startMs: 900, endMs: 1500},
            {text: 'timing', startMs: 1500, endMs: 3000},
        ],
    }],
});
assert(incompleteWords.syncLevel === SyncLevel.LINE,
    'a word before its line should downgrade to line sync');

const whitespaceToken = createLyricsDocument({
    source: 'test',
    lines: [{
        text: '你 好!',
        startMs: 0,
        endMs: 1000,
        words: [
            {text: '你', startMs: 0, endMs: 250},
            {text: ' ', startMs: 250, endMs: 400},
            {text: '好', startMs: 400, endMs: 750},
            {text: '!', startMs: 750, endMs: 1000},
        ],
    }],
});
assert(whitespaceToken.syncLevel === SyncLevel.WORD,
    'meaningful whitespace and punctuation tokens should remain valid');

const partialWords = createLyricsDocument({
    source: 'test',
    lines: [
        {
            text: 'timed words',
            startMs: 0,
            endMs: 1000,
            words: [
                {text: 'timed ', startMs: 0, endMs: 500},
                {text: 'words', startMs: 500, endMs: 1000},
            ],
        },
        {text: 'line only', startMs: 1000, endMs: 2000, words: []},
    ],
});
assert(partialWords.syncLevel === SyncLevel.LINE,
    'incomplete per-line word coverage should downgrade the document to line sync');

const missingWordStart = createLyricsDocument({
    source: 'test',
    lines: [{
        text: 'bad',
        startMs: 0,
        endMs: 1000,
        words: [{text: 'bad', startMs: null, endMs: 1000}],
    }],
});
assert(missingWordStart.syncLevel === SyncLevel.LINE,
    'a missing word start should downgrade to line sync');

const wordAfterLine = createLyricsDocument({
    source: 'test',
    lines: [{
        text: 'late',
        startMs: 0,
        endMs: 1000,
        words: [{text: 'late', startMs: 1100, endMs: 1200}],
    }],
});
assert(wordAfterLine.syncLevel === SyncLevel.LINE,
    'a word after its line end should downgrade to line sync');

const malformedLine = createLyricsDocument({
    source: 'test',
    plain: 'Static fallback\n\nStill static',
    lines: [{text: 'Bad timing', startMs: Number.NaN, words: []}],
});
assert(malformedLine.syncLevel === SyncLevel.NONE &&
    malformedLine.lines.length === 3 &&
    malformedLine.lines.every(line => line.startMs === null),
'invalid line timing should downgrade to static lyrics without fabrication');

print('LyricsDocument validation and boundary synchronization tests passed');
