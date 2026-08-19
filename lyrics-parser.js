export class LrcParser {
    static parse(lrc) {
        if (typeof lrc !== 'string' || !lrc.trim())
            return [];

        const offsetMatch = lrc.match(/^\s*\[offset:([+-]?\d+)\]\s*$/im);
        const offsetUs = offsetMatch ? Number(offsetMatch[1]) * 1000 : 0;
        const entries = [];

        for (const sourceLine of lrc.split(/\r?\n/)) {
            const timestamp = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;
            const times = [];
            let match;

            while ((match = timestamp.exec(sourceLine)) !== null) {
                const minutes = Number(match[1]);
                const seconds = Number(match[2]);
                const timeUs = Math.max(0,
                    Math.round((minutes * 60 + seconds) * 1_000_000) + offsetUs);
                times.push(timeUs);
            }

            if (times.length === 0)
                continue;

            const text = sourceLine.replace(timestamp, '').trim();
            for (const timeUs of times)
                entries.push({timeUs, text});
        }

        entries.sort((a, b) => a.timeUs - b.timeUs);

        const deduplicated = [];
        for (const entry of entries) {
            const previous = deduplicated.at(-1);
            if (previous?.timeUs === entry.timeUs)
                previous.text = entry.text;
            else
                deduplicated.push(entry);
        }

        return deduplicated;
    }

    static currentLine(lines, positionUs) {
        const index = this.currentIndex(lines, positionUs);
        return index >= 0 ? lines[index].text : null;
    }

    static currentIndex(lines, positionUs) {
        if (!Array.isArray(lines) || lines.length === 0)
            return -1;

        let low = 0;
        let high = lines.length - 1;
        let found = -1;

        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (lines[middle].timeUs <= positionUs) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        return found;
    }
}
