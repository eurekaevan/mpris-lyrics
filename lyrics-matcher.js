import {normalizeLyricsPayload} from './lyrics-normalizer.js';

export const MIN_CANDIDATE_SCORE = 82;

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/\p{Mark}/gu, '')
        .toLocaleLowerCase()
        .replace(/&/g, ' and ')
        .replace(/\b(?:featuring|feat\.?|ft\.?)\b/g, ' ')
        .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeBaseTitle(value) {
    return normalizeText(String(value ?? '')
        .replace(/[([][^\])]*(?:remaster(?:ed)?|deluxe|explicit|clean|radio edit|single version|album version)[^\])]*[)\]]/gi, ' ')
        .replace(/[-–—]\s*(?:\d{4}\s*)?remaster(?:ed)?\b.*$/i, ' '));
}

function tokenSimilarity(left, right) {
    if (!left || !right)
        return 0;
    if (left === right)
        return 1;

    const leftTokens = new Set(left.split(' '));
    const rightTokens = new Set(right.split(' '));
    let intersection = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token))
            intersection++;
    }
    const union = new Set([...leftTokens, ...rightTokens]).size;
    return union > 0 ? intersection / union : 0;
}

function titleSimilarity(left, right) {
    const normalizedLeft = normalizeText(left);
    const normalizedRight = normalizeText(right);
    if (normalizedLeft === normalizedRight && normalizedLeft)
        return 1;

    const baseLeft = normalizeBaseTitle(left);
    const baseRight = normalizeBaseTitle(right);
    if (baseLeft === baseRight && baseLeft)
        return 0.92;
    return Math.max(
        tokenSimilarity(normalizedLeft, normalizedRight),
        tokenSimilarity(baseLeft, baseRight) * 0.92);
}

function artistSimilarity(left, right) {
    const normalizedLeft = normalizeText(left);
    const normalizedRight = normalizeText(right);
    if (normalizedLeft === normalizedRight && normalizedLeft)
        return 1;
    if (normalizedLeft && normalizedRight &&
        (normalizedLeft.includes(normalizedRight) ||
            normalizedRight.includes(normalizedLeft)))
        return 0.88;
    return tokenSimilarity(normalizedLeft, normalizedRight);
}

function durationScore(track, candidate) {
    const trackDuration = Number(track.durationUs) / 1_000_000;
    const candidateDuration = Number(candidate.duration);
    if (!(trackDuration > 0) || !(candidateDuration > 0))
        return {durationDelta: null, points: 15};

    const durationDelta = Math.abs(trackDuration - candidateDuration);
    if (durationDelta <= 1)
        return {durationDelta, points: 35};
    if (durationDelta <= 2.5)
        return {durationDelta, points: 32};
    if (durationDelta <= 4)
        return {durationDelta, points: 25};
    if (durationDelta <= 8)
        return {durationDelta, points: 10};
    return {durationDelta, points: -25};
}

export function scoreLyricsCandidate(track, candidate) {
    const titleMatch = titleSimilarity(
        track.title, candidate?.trackName ?? candidate?.name);
    const artistMatch = artistSimilarity(track.artist, candidate?.artistName);
    const albumMatch = track.album
        ? titleSimilarity(track.album, candidate?.albumName)
        : 0.5;
    const {durationDelta, points: durationPoints} =
        durationScore(track, candidate ?? {});
    const document = normalizeLyricsPayload(candidate);
    const syncLevel = document?.syncLevel ?? 'none';
    const qualityPoints = document?.instrumental
        ? 4
        : syncLevel === 'word'
            ? 8
            : syncLevel === 'line'
                ? 4
                : document
                    ? 1
                    : -10;
    const score = titleMatch * 42 + artistMatch * 30 + albumMatch * 8 +
        durationPoints + qualityPoints;
    const accepted = Boolean(document) && score >= MIN_CANDIDATE_SCORE &&
        titleMatch >= 0.72 && artistMatch >= 0.55;

    return {
        score,
        accepted,
        diagnostics: {
            titleMatch,
            artistMatch,
            albumMatch,
            durationDelta,
            syncLevel,
            instrumental: Boolean(document?.instrumental),
        },
        document,
    };
}

export function rankLyricsCandidates(track, candidates) {
    if (!Array.isArray(candidates))
        return [];

    return candidates.slice(0, 20)
        .map(candidate => ({
            candidate,
            ...scoreLyricsCandidate(track, candidate),
        }))
        .sort((left, right) => right.score - left.score);
}
