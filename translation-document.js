import GLib from 'gi://GLib';

export const TRANSLATION_DOCUMENT_VERSION = 1;

function checksum(value) {
    return GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256, value, -1);
}

function requiredString(value, name) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`Translation ${name} is required`);
    return value.trim();
}

export function sourceLyricsHash(document) {
    if (!document?.lines?.length)
        return null;

    return checksum(JSON.stringify(document.lines.map(line =>
        [line.lineId, line.text])));
}

export function translationCacheKey({
    sourceLyricsHash: lyricsHash,
    targetLanguage,
    provider,
    model,
    version = TRANSLATION_DOCUMENT_VERSION,
}) {
    return checksum(JSON.stringify([
        version,
        requiredString(lyricsHash, 'source lyrics hash'),
        requiredString(targetLanguage, 'target language'),
        requiredString(provider, 'provider'),
        requiredString(model, 'model'),
    ]));
}

export function languagesEquivalent(sourceLanguage, targetLanguage) {
    if (typeof sourceLanguage !== 'string' ||
        typeof targetLanguage !== 'string')
        return false;

    const source = sourceLanguage.trim().toLowerCase();
    const target = targetLanguage.trim().toLowerCase();
    if (!source || source === 'unknown' || !target)
        return false;
    return source === target || source.split('-')[0] === target.split('-')[0];
}

export function validateTranslationLines(document, response) {
    if (!response || typeof response !== 'object' ||
        !Array.isArray(response.lines))
        throw new Error('Translation response must contain a lines array');

    const knownIds = new Set(document.lines.map(line => line.lineId));
    const seenIds = new Set();
    const lines = [];
    for (const line of response.lines) {
        if (!line || typeof line !== 'object' ||
            typeof line.id !== 'string' || typeof line.text !== 'string')
            throw new Error('Translation response contains an invalid line');
        if (!knownIds.has(line.id))
            throw new Error(`Translation response contains unknown line ID ${line.id}`);
        if (seenIds.has(line.id))
            throw new Error(`Translation response contains duplicate line ID ${line.id}`);
        seenIds.add(line.id);
        lines.push({lineId: line.id, text: line.text});
    }

    return lines;
}

export function createTranslationDocument({
    trackKey,
    sourceLyricsHash: lyricsHash,
    sourceLanguage = 'unknown',
    targetLanguage,
    provider,
    model,
    createdAt = new Date().toISOString(),
    lines = [],
}) {
    const seenIds = new Set();
    const normalizedLines = lines.map(line => {
        const lineId = requiredString(line?.lineId, 'line ID');
        if (seenIds.has(lineId))
            throw new Error(`Duplicate TranslationDocument line ID ${lineId}`);
        if (typeof line.text !== 'string')
            throw new Error(`Translation text for ${lineId} must be a string`);
        seenIds.add(lineId);
        return Object.freeze({lineId, text: line.text});
    });

    const created = new Date(createdAt);
    if (!Number.isFinite(created.getTime()))
        throw new Error('Translation createdAt is invalid');

    return Object.freeze({
        version: TRANSLATION_DOCUMENT_VERSION,
        trackKey: requiredString(trackKey, 'track key'),
        sourceLyricsHash: requiredString(lyricsHash, 'source lyrics hash'),
        sourceLanguage: typeof sourceLanguage === 'string' && sourceLanguage
            ? sourceLanguage
            : 'unknown',
        targetLanguage: requiredString(targetLanguage, 'target language'),
        provider: requiredString(provider, 'provider'),
        model: requiredString(model, 'model'),
        createdAt: created.toISOString(),
        lines: Object.freeze(normalizedLines),
    });
}

export function alignTranslation(document, translation) {
    const translations = new Map(
        translation?.lines?.map(line => [line.lineId, line.text]) ?? []);
    return document.lines.map(line => translations.get(line.lineId) ?? null);
}
