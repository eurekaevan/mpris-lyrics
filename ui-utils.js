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

const PANEL_PAN_LEAD_FRACTION = 0.12;
const PANEL_PAN_END_HOLD_FRACTION = 0.20;
const PANEL_PAN_MAX_LEAD_MS = 600;
const PANEL_PAN_MAX_END_HOLD_MS = 1000;

export function normalizePanelTimeline(timeline) {
    const startMs = timeline?.startMs;
    const endMs = timeline?.endMs;
    const positionMs = timeline?.positionMs;
    const playbackRate = timeline?.playbackRate;
    if (![startMs, endMs, positionMs].every(Number.isFinite) ||
        endMs <= startMs)
        return null;

    return {
        startMs,
        endMs,
        positionMs,
        playbackRate: Number.isFinite(playbackRate) && playbackRate > 0
            ? playbackRate
            : 1,
    };
}

export function panelTimelinesEqual(first, second) {
    if (!first || !second)
        return first === second;
    return first.startMs === second.startMs &&
        first.endMs === second.endMs &&
        first.positionMs === second.positionMs &&
        first.playbackRate === second.playbackRate;
}

export function panelPanState(timeline, positionMs, overflow) {
    const normalized = normalizePanelTimeline(timeline);
    const position = Number(positionMs);
    const distance = Number(overflow);
    if (!normalized || !Number.isFinite(position) ||
        !Number.isFinite(distance) || distance <= 0)
        return null;

    const lineDurationMs = normalized.endMs - normalized.startMs;
    const leadMs = Math.min(
        PANEL_PAN_MAX_LEAD_MS,
        lineDurationMs * PANEL_PAN_LEAD_FRACTION);
    const endHoldMs = Math.min(
        PANEL_PAN_MAX_END_HOLD_MS,
        lineDurationMs * PANEL_PAN_END_HOLD_FRACTION);
    const motionStartMs = normalized.startMs + leadMs;
    const motionEndMs = Math.max(
        motionStartMs, normalized.endMs - endHoldMs);
    const motionDurationMs = Math.max(1, motionEndMs - motionStartMs);
    const progress = Math.min(1, Math.max(0,
        (position - motionStartMs) / motionDurationMs));
    const initialX = -distance * progress;
    const targetX = -distance;
    const delayMs = Math.max(0, Math.round(
        (motionStartMs - position) / normalized.playbackRate));
    const durationMs = Math.max(1, Math.round(
        (motionEndMs - Math.max(position, motionStartMs)) /
        normalized.playbackRate));
    const remainingDistance = Math.abs(targetX - initialX);

    return {
        initialX,
        targetX,
        delayMs,
        durationMs,
        speedPxPerSecond: remainingDistance / durationMs * 1000,
        shouldAnimate: position < motionEndMs && remainingDistance > 0.5,
    };
}

const LINE_VISUAL_LEVELS = Object.freeze({
    static: Object.freeze({name: 'static', opacity: 224}),
    far: Object.freeze({name: 'far', opacity: 107}),
    mid: Object.freeze({name: 'mid', opacity: 143}),
    near: Object.freeze({name: 'near', opacity: 184}),
    current: Object.freeze({name: 'current', opacity: 255}),
});

export function getLineVisualLevel(index, currentIndex) {
    if (!Number.isInteger(index) || !Number.isInteger(currentIndex) ||
        currentIndex < 0)
        return LINE_VISUAL_LEVELS.static;

    const distance = Math.abs(index - currentIndex);
    if (distance === 0)
        return LINE_VISUAL_LEVELS.current;
    if (distance === 1)
        return LINE_VISUAL_LEVELS.near;
    if (distance === 2)
        return LINE_VISUAL_LEVELS.mid;
    return LINE_VISUAL_LEVELS.far;
}

export function comfortableScrollTarget({
    rowTop,
    rowBottom,
    value,
    lower,
    upper,
    pageSize,
    force = false,
}) {
    const values = [rowTop, rowBottom, value, lower, upper, pageSize];
    if (!values.every(Number.isFinite) || pageSize <= 0 || rowBottom < rowTop)
        return null;

    const maximum = Math.max(lower, upper - pageSize);
    const currentValue = Math.min(maximum, Math.max(lower, value));
    const rowCenter = (rowTop + rowBottom) / 2;
    const halfRowHeight = (rowBottom - rowTop) / 2;
    const zoneStart = currentValue + pageSize * 0.40 - halfRowHeight;
    const zoneEnd = currentValue + pageSize * 0.58 + halfRowHeight;
    if (!force && rowCenter >= zoneStart && rowCenter <= zoneEnd)
        return null;

    const target = rowCenter - pageSize * 0.47;
    return Math.min(maximum, Math.max(lower, target));
}
