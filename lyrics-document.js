import GLib from 'gi://GLib';

export const SyncLevel = Object.freeze({
    NONE: 'none',
    LINE: 'line',
    WORD: 'word',
});

export function createLineId(index, startMs, text) {
    const identity = JSON.stringify([
        Number.isInteger(index) ? index : -1,
        Number.isInteger(startMs) ? startMs : '',
        stringOrEmpty(text),
    ]);
    const digest = GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256, identity, -1);
    return `l${index}-${digest.slice(0, 20)}`;
}

function stringOrEmpty(value) {
    return typeof value === 'string' ? value : '';
}

function nullableTimestamp(value) {
    return value === null || value === undefined ? null : value;
}

export function plainTextLines(plain) {
    if (typeof plain !== 'string' || !plain)
        return [];

    const text = plain.replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    if (lines.at(-1) === '')
        lines.pop();
    return lines.map(text => ({
        text,
        startMs: null,
        endMs: null,
        words: [],
    }));
}

function normalizeMetadata(metadata = {}) {
    return {
        title: stringOrEmpty(metadata.title),
        artist: stringOrEmpty(metadata.artist),
        album: stringOrEmpty(metadata.album),
        durationMs: Number.isInteger(metadata.durationMs) &&
            metadata.durationMs >= 0
            ? metadata.durationMs
            : null,
        language: typeof metadata.language === 'string'
            ? metadata.language
            : null,
    };
}

function normalizeLines(lines) {
    if (!Array.isArray(lines))
        return [];

    return lines.map(line => ({
        text: stringOrEmpty(line?.text),
        startMs: nullableTimestamp(line?.startMs),
        endMs: nullableTimestamp(line?.endMs),
        words: Array.isArray(line?.words)
            ? line.words.map(word => ({
                text: stringOrEmpty(word?.text),
                startMs: nullableTimestamp(word?.startMs),
                endMs: nullableTimestamp(word?.endMs),
            }))
            : [],
    }));
}

function hasValidLineTimings(lines) {
    return lines.length > 0 && lines.every(line =>
        Number.isInteger(line.startMs) && line.startMs >= 0 &&
        (line.endMs === null ||
            (Number.isInteger(line.endMs) && line.endMs >= line.startMs)));
}

function hasValidWordTimings(lines) {
    let timedTextLineCount = 0;

    for (const line of lines) {
        if (!line.text && line.words.length === 0)
            continue;

        timedTextLineCount++;
        if (line.words.length === 0 ||
            line.words.map(word => word.text).join('') !== line.text)
            return false;

        let previousStartMs = -1;
        for (const word of line.words) {
            if (!word.text || !Number.isInteger(word.startMs) ||
                word.startMs < line.startMs ||
                word.startMs < previousStartMs ||
                (line.endMs !== null && word.startMs > line.endMs) ||
                (word.endMs !== null &&
                    (!Number.isInteger(word.endMs) ||
                        word.endMs < word.startMs ||
                        (line.endMs !== null && word.endMs > line.endMs))))
                return false;

            previousStartMs = word.startMs;
        }
    }

    return timedTextLineCount > 0;
}

/**
 * Build the only lyrics representation consumed by synchronization and UI code.
 * Invalid word timing is retained for diagnostics but downgraded to line sync;
 * invalid line timing is rendered as static text without invented timestamps.
 */
export function createLyricsDocument({
    source,
    sourceId = null,
    instrumental = false,
    metadata = {},
    lines = [],
    plain = null,
} = {}) {
    const normalizedMetadata = normalizeMetadata(metadata);
    let normalizedLines = normalizeLines(lines);
    let syncLevel = SyncLevel.NONE;

    if (instrumental) {
        normalizedLines = [];
    } else if (hasValidLineTimings(normalizedLines)) {
        normalizedLines = normalizedLines
            .map((line, index) => ({line, index}))
            .sort((a, b) => a.line.startMs - b.line.startMs ||
                a.index - b.index)
            .map(item => item.line);
        syncLevel = hasValidWordTimings(normalizedLines)
            ? SyncLevel.WORD
            : SyncLevel.LINE;
    } else {
        const staticLines = plainTextLines(plain);
        normalizedLines = staticLines.length > 0
            ? staticLines
            : normalizedLines.map(line => ({
                text: line.text,
                startMs: null,
                endMs: null,
                words: [],
            }));
    }

    return Object.freeze({
        source: typeof source === 'string' ? source : 'unknown',
        sourceId: sourceId ?? null,
        instrumental: Boolean(instrumental),
        metadata: Object.freeze(normalizedMetadata),
        lines: Object.freeze(normalizedLines.map((line, index) => Object.freeze({
            ...line,
            lineId: createLineId(index, line.startMs, line.text),
            words: Object.freeze(line.words.map(word => Object.freeze(word))),
        }))),
        syncLevel,
    });
}

export function createPlainLyricsDocument(plain, options = {}) {
    return createLyricsDocument({...options, plain});
}

export function hasDisplayableLyrics(document) {
    return Boolean(document?.instrumental || document?.lines?.length);
}
