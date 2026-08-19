import {JSON_SCHEMA, load as loadYaml} from './js-yaml.mjs';

import {createLyricsDocument} from './lyrics-document.js';

const MAX_DOCUMENT_CHARS = 1024 * 1024;
const MAX_COLLECTION_DEPTH = 32;
const MAX_COLLECTION_NODES = 50_000;

function isMapping(value) {
    return value !== null && typeof value === 'object' &&
        !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validateYamlValue(value, seen, depth, counter) {
    if (value === null || typeof value === 'string' ||
        typeof value === 'boolean')
        return;

    if (typeof value === 'number') {
        if (!Number.isInteger(value) || !Number.isFinite(value))
            throw new Error('Lyricsfile supports integer numbers only');
        return;
    }

    if (!Array.isArray(value) && !isMapping(value))
        throw new Error('Lyricsfile contains an unsupported YAML value');
    if (depth > MAX_COLLECTION_DEPTH)
        throw new Error('Lyricsfile nesting is too deep');
    if (seen.has(value))
        throw new Error('Lyricsfile YAML aliases are not supported');
    seen.add(value);
    counter.count++;
    if (counter.count > MAX_COLLECTION_NODES)
        throw new Error('Lyricsfile contains too many values');

    if (Array.isArray(value)) {
        for (const item of value)
            validateYamlValue(item, seen, depth + 1, counter);
    } else {
        for (const item of Object.values(value))
            validateYamlValue(item, seen, depth + 1, counter);
    }
}

function optionalInteger(value) {
    return value === undefined || value === null ? null : value;
}

function parseWords(words, lineNumber) {
    if (words === undefined || words === null)
        return [];
    if (!Array.isArray(words))
        throw new Error(`Lyricsfile line ${lineNumber} words must be a sequence`);

    return words.map((word, index) => {
        if (!isMapping(word) || typeof word.text !== 'string') {
            throw new Error(
                `Lyricsfile line ${lineNumber} word ${index + 1} is invalid`);
        }
        return {
            text: word.text,
            startMs: word.start_ms ?? Number.NaN,
            endMs: optionalInteger(word.end_ms),
        };
    });
}

function parseLines(lines) {
    if (lines === undefined || lines === null)
        return [];
    if (!Array.isArray(lines))
        throw new Error('Lyricsfile lines must be a sequence');

    return lines.map((line, index) => {
        if (!isMapping(line) || typeof line.text !== 'string')
            throw new Error(`Lyricsfile line ${index + 1} is invalid`);
        return {
            text: line.text,
            startMs: line.start_ms ?? Number.NaN,
            endMs: optionalInteger(line.end_ms),
            words: parseWords(line.words, index + 1),
        };
    });
}

export class LyricsfileParser {
    static parse(source, {
        sourceId = null,
        providerMetadata = {},
    } = {}) {
        if (typeof source !== 'string' || !source.trim())
            throw new Error('Lyricsfile is empty');
        if (source.length > MAX_DOCUMENT_CHARS)
            throw new Error('Lyricsfile exceeds the 1 MiB safety limit');

        let anchorFound = false;
        const data = loadYaml(source, {
            schema: JSON_SCHEMA,
            json: false,
            listener: (event, state) => {
                if (event === 'close' && state.anchor !== null)
                    anchorFound = true;
            },
        });
        if (anchorFound)
            throw new Error('Lyricsfile YAML anchors and aliases are not supported');

        validateYamlValue(data, new WeakSet(), 0, {count: 0});
        if (!isMapping(data))
            throw new Error('Lyricsfile must contain a top-level mapping');
        if (data.version !== '1.0')
            throw new Error(`Unsupported Lyricsfile version: ${data.version}`);
        if (!isMapping(data.metadata))
            throw new Error('Lyricsfile metadata must be a mapping');
        if (typeof data.metadata.title !== 'string' ||
            typeof data.metadata.artist !== 'string')
            throw new Error('Lyricsfile metadata title and artist are required');
        if (data.plain !== undefined && data.plain !== null &&
            typeof data.plain !== 'string')
            throw new Error('Lyricsfile plain lyrics must be a string');
        if (data.metadata.instrumental !== undefined &&
            typeof data.metadata.instrumental !== 'boolean')
            throw new Error('Lyricsfile instrumental metadata must be boolean');

        const instrumental = data.metadata.instrumental === true;
        const lines = parseLines(data.lines);
        if (instrumental &&
            (lines.length > 0 || (typeof data.plain === 'string' && data.plain)))
            throw new Error('Instrumental Lyricsfile must not contain lyrics');

        return createLyricsDocument({
            source: 'lrclib-lyricsfile',
            sourceId,
            instrumental,
            metadata: {
                title: data.metadata.title || providerMetadata.title,
                artist: data.metadata.artist || providerMetadata.artist,
                album: data.metadata.album ?? providerMetadata.album,
                durationMs: data.metadata.duration_ms ??
                    providerMetadata.durationMs,
                language: data.metadata.language ?? null,
            },
            lines,
            plain: data.plain ?? null,
        });
    }
}
