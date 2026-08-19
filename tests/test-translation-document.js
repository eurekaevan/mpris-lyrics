import {createLyricsDocument} from '../lyrics-document.js';
import {buildTranslationChunks} from '../translation-batching.js';
import {
    alignTranslation,
    createTranslationDocument,
    languagesEquivalent,
    sourceLyricsHash,
    translationCacheKey,
    validateTranslationLines,
} from '../translation-document.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function rejects(callback, message) {
    let rejected = false;
    try {
        callback();
    } catch {
        rejected = true;
    }
    assert(rejected, message);
}

const lyrics = createLyricsDocument({
    source: 'test',
    metadata: {title: 'Context', artist: 'Tester', language: 'en'},
    lines: [
        {text: 'First line', startMs: 1000, endMs: 2000},
        {text: '', startMs: 2000, endMs: 2500},
        {text: 'Repeated', startMs: 2500, endMs: 3000},
        {text: 'Repeated', startMs: 3000, endMs: 3500},
    ],
});
const sameLyrics = createLyricsDocument({
    source: 'different-provider',
    metadata: {title: 'Context', artist: 'Tester', language: 'en'},
    lines: [
        {text: 'First line', startMs: 1000, endMs: 2000},
        {text: '', startMs: 2000, endMs: 2500},
        {text: 'Repeated', startMs: 2500, endMs: 3000},
        {text: 'Repeated', startMs: 3000, endMs: 3500},
    ],
});
assert(lyrics.lines.every(line => line.lineId) &&
    lyrics.lines.map(line => line.lineId).join() ===
        sameLyrics.lines.map(line => line.lineId).join(),
'line IDs should be stable and independent of provider/UI state');
assert(new Set(lyrics.lines.map(line => line.lineId)).size === 4,
    'line index and timing should distinguish repeated text');

const hash = sourceLyricsHash(lyrics);
assert(hash === sourceLyricsHash(sameLyrics),
    'equivalent normalized lyrics should have the same source hash');
const changed = createLyricsDocument({
    source: 'test',
    lines: [{text: 'Changed line', startMs: 1000, endMs: 2000}],
});
assert(sourceLyricsHash(changed) !== hash,
    'a lyrics content change should invalidate the source hash');

const returned = validateTranslationLines(lyrics, {lines: [
    {id: lyrics.lines[2].lineId, text: '重复'},
    {id: lyrics.lines[0].lineId, text: '第一行'},
]});
const translation = createTranslationDocument({
    trackKey: 'track-key',
    sourceLyricsHash: hash,
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    provider: 'mock',
    model: 'mock-v1',
    lines: returned,
});
const aligned = alignTranslation(lyrics, translation);
assert(aligned[0] === '第一行' && aligned[1] === null &&
    aligned[2] === '重复' && aligned[3] === null,
'alignment should use line IDs and safely leave missing lines untranslated');

rejects(() => validateTranslationLines(lyrics, {
    lines: [{id: 'unknown', text: '错误'}],
}), 'unknown returned IDs must be rejected');
rejects(() => validateTranslationLines(lyrics, {lines: [
    {id: lyrics.lines[0].lineId, text: '一'},
    {id: lyrics.lines[0].lineId, text: '二'},
]}), 'duplicate returned IDs must be rejected');
rejects(() => validateTranslationLines(lyrics, {lines: 'bad'}),
    'malformed translation responses must be rejected');

const cacheOptions = {
    sourceLyricsHash: hash,
    targetLanguage: 'zh-CN',
    provider: 'mock',
    model: 'mock-v1',
};
const key = translationCacheKey(cacheOptions);
assert(key !== translationCacheKey({...cacheOptions, targetLanguage: 'ja'}) &&
    key !== translationCacheKey({...cacheOptions, provider: 'other'}) &&
    key !== translationCacheKey({...cacheOptions, model: 'mock-v2'}),
'target language, provider, and model must invalidate the cache key');
assert(languagesEquivalent('zh', 'zh-CN') &&
    languagesEquivalent('en-US', 'en') &&
    !languagesEquivalent('unknown', 'zh-CN') &&
    !languagesEquivalent('ja', 'zh-CN'),
'same-language skipping should only use explicit language codes');

const chunks = buildTranslationChunks(lyrics, {
    maxLines: 2,
    maxChars: 100,
    contextLines: 1,
});
assert(chunks.length === 2 && chunks[0].lines.length === 2 &&
    chunks[1].lines.length === 1 &&
    chunks[0].contextAfter[0].id === chunks[1].lines[0].id &&
    chunks[1].contextBefore[0].id === chunks[0].lines.at(-1).id,
'long lyrics batching should skip blank lines and preserve boundary context');

print('Translation document, alignment, hash and batching tests passed');
