export function formatDuration(seconds) {
    const value = Number(seconds);
    const totalSeconds = Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:` +
            `${String(remainingSeconds).padStart(2, '0')}`;
    }

    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function progressFraction(positionUs, durationUs) {
    const position = Number(positionUs);
    const duration = Number(durationUs);
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0)
        return 0;

    return Math.min(1, Math.max(0, position / duration));
}
