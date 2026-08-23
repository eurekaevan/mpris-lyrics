import {
    comfortableScrollTarget,
    formatDuration,
    getLineVisualLevel,
    progressFraction,
} from '../ui-utils.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

assert(formatDuration(0) === '0:00', 'zero duration should be 0:00');
assert(formatDuration(5.9) === '0:05', 'seconds should be zero-padded');
assert(formatDuration(69) === '1:09', 'minutes should be formatted');
assert(formatDuration(3599) === '59:59', 'sub-hour duration should omit hours');
assert(formatDuration(3733) === '1:02:13', 'hours should include padded minutes');
assert(formatDuration(-1) === '0:00' && formatDuration(Number.NaN) === '0:00',
    'invalid duration should clamp to zero');

assert(progressFraction(30, 100) === 0.3,
    'progress should return a normal fraction');
assert(progressFraction(-10, 100) === 0 &&
    progressFraction(150, 100) === 1,
    'progress should clamp to the closed unit interval');
assert(progressFraction(10, 0) === 0 &&
    progressFraction(Number.NaN, 100) === 0,
    'invalid progress inputs should be safe');

assert(getLineVisualLevel(5, 5).name === 'current' &&
    getLineVisualLevel(4, 5).opacity === 184 &&
    getLineVisualLevel(3, 5).opacity === 143 &&
    getLineVisualLevel(1, 5).opacity === 107,
'line focus should decrease through current, near, mid, and far levels');
assert(getLineVisualLevel(5, -1).name === 'static',
    'plain or not-yet-active lyrics should keep a readable static level');

assert(comfortableScrollTarget({
    rowTop: 140,
    rowBottom: 160,
    value: 50,
    lower: 0,
    upper: 500,
    pageSize: 200,
}) === null, 'a line inside the comfortable zone should not scroll');
assert(comfortableScrollTarget({
    rowTop: 260,
    rowBottom: 280,
    value: 50,
    lower: 0,
    upper: 500,
    pageSize: 200,
}) === 176, 'a line outside the comfortable zone should return near 47%');
assert(comfortableScrollTarget({
    rowTop: 10,
    rowBottom: 30,
    value: 0,
    lower: 0,
    upper: 500,
    pageSize: 200,
    force: true,
}) === 0, 'forced positioning should clamp at the beginning');

print('UI duration and progress tests passed');
