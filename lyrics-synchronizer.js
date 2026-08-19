import {SyncLevel} from './lyrics-document.js';

function effectiveWordEndMs(line, wordIndex) {
    const word = line.words[wordIndex];
    if (word.endMs !== null)
        return word.endMs;

    for (let index = wordIndex + 1; index < line.words.length; index++) {
        if (line.words[index].startMs > word.startMs)
            return line.words[index].startMs;
    }

    return line.endMs;
}

export class LyricsSynchronizer {
    static currentLineIndex(document, positionMs) {
        if (!document || document.syncLevel === SyncLevel.NONE ||
            !Number.isFinite(positionMs))
            return -1;

        const {lines} = document;
        let low = 0;
        let high = lines.length - 1;
        let found = -1;

        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (lines[middle].startMs <= positionMs) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        return found;
    }

    static nextLineStartMs(document, lineIndex) {
        if (!document || document.syncLevel === SyncLevel.NONE)
            return null;
        return document.lines[lineIndex + 1]?.startMs ?? null;
    }

    static wordStates(document, lineIndex, positionMs) {
        if (document?.syncLevel !== SyncLevel.WORD)
            return [];

        const line = document.lines[lineIndex];
        if (!line?.words?.length)
            return [];

        return line.words.map((word, index) => {
            const endMs = effectiveWordEndMs(line, index);
            if (positionMs < word.startMs)
                return 'future';
            if (endMs === null || positionMs < endMs)
                return 'current';
            return 'past';
        });
    }

    static nextWordBoundaryMs(document, lineIndex, positionMs) {
        if (document?.syncLevel !== SyncLevel.WORD)
            return null;

        const line = document.lines[lineIndex];
        if (!line?.words?.length)
            return null;

        let next = null;
        const consider = value => {
            if (Number.isFinite(value) && value > positionMs &&
                (next === null || value < next))
                next = value;
        };

        for (let index = 0; index < line.words.length; index++) {
            consider(line.words[index].startMs);
            consider(effectiveWordEndMs(line, index));
        }

        return next;
    }
}
