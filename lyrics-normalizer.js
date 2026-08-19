import {createLyricsDocument, createPlainLyricsDocument, SyncLevel} from './lyrics-document.js';
import {LrcParser} from './lyrics-parser.js';
import {LyricsfileParser} from './lyricsfile-parser.js';

function providerMetadata(payload) {
    return {
        title: payload?.trackName ?? payload?.name ?? '',
        artist: payload?.artistName ?? '',
        album: payload?.albumName ?? '',
        durationMs: Number.isFinite(payload?.duration)
            ? Math.max(0, Math.round(payload.duration * 1000))
            : null,
    };
}

export function normalizeLyricsPayload(payload, {onLyricsfileError = null} = {}) {
    if (!payload || typeof payload !== 'object')
        return null;

    const sourceId = payload.id ?? null;
    const metadata = providerMetadata(payload);
    let lyricsfileDocument = null;

    if (typeof payload.lyricsfile === 'string' && payload.lyricsfile.trim()) {
        try {
            lyricsfileDocument = LyricsfileParser.parse(payload.lyricsfile, {
                sourceId,
                providerMetadata: metadata,
            });
            if (lyricsfileDocument.instrumental ||
                lyricsfileDocument.syncLevel !== SyncLevel.NONE)
                return lyricsfileDocument;
        } catch (error) {
            onLyricsfileError?.(error);
        }
    }

    if (payload.instrumental === true) {
        return createLyricsDocument({
            source: 'lrclib',
            sourceId,
            instrumental: true,
            metadata,
        });
    }

    const syncedDocument = LrcParser.parseDocument(payload.syncedLyrics, {
        source: 'lrclib-synced',
        sourceId,
        metadata,
    });
    if (syncedDocument.syncLevel === SyncLevel.LINE)
        return syncedDocument;

    if (typeof payload.plainLyrics === 'string' && payload.plainLyrics) {
        return createPlainLyricsDocument(payload.plainLyrics, {
            source: 'lrclib-plain',
            sourceId,
            metadata,
        });
    }

    if (lyricsfileDocument?.lines.length)
        return lyricsfileDocument;

    return null;
}
