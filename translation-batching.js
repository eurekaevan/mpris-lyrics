export const DEFAULT_MAX_CHUNK_LINES = 80;
export const DEFAULT_MAX_CHUNK_CHARS = 8000;

export function buildTranslationChunks(document, {
    maxLines = DEFAULT_MAX_CHUNK_LINES,
    maxChars = DEFAULT_MAX_CHUNK_CHARS,
    contextLines = 2,
} = {}) {
    const translatable = document?.lines
        ?.filter(line => typeof line.text === 'string' && line.text.trim()) ?? [];
    if (translatable.length === 0)
        return [];

    const lineLimit = Math.max(1, Math.floor(maxLines));
    const charLimit = Math.max(1, Math.floor(maxChars));
    const chunks = [];
    let current = [];
    let currentChars = 0;

    const finish = () => {
        if (current.length === 0)
            return;
        chunks.push(current);
        current = [];
        currentChars = 0;
    };

    for (const line of translatable) {
        const size = line.text.length;
        if (current.length > 0 &&
            (current.length >= lineLimit || currentChars + size > charLimit))
            finish();
        current.push({id: line.lineId, text: line.text});
        currentChars += size;
    }
    finish();

    return chunks.map((lines, index) => ({
        index,
        lines,
        contextBefore: index === 0
            ? []
            : chunks[index - 1].slice(-contextLines),
        contextAfter: index === chunks.length - 1
            ? []
            : chunks[index + 1].slice(0, contextLines),
    }));
}
