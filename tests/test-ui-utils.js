import {formatDuration, progressFraction} from '../ui-utils.js';

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

print('UI duration and progress tests passed');
