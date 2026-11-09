import { describe, expect, it } from 'vitest';
import { formatProgress, parsePage } from './helpers.js';

describe('parsePage', () => {
	it.each([
		['12', 240, 12], [' 12 ', 240, 12], ['0', 240, 1], ['999', 240, 240],
		['0002', 240, 2], ['9'.repeat(400), 240, 240], ['1', 1, 1],
		['', 240, null], [' ', 240, null], ['12x', 240, null], ['1.5', 240, null],
		['1e2', 240, null], ['-1', 240, null], ['+2', 240, null], ['一', 240, null],
		['1', 0, null], ['1', NaN, null], ['1', 1.5, null]
	])('parses %j of %s as %s', (value, count, expected) => {
		expect(parsePage(value, count)).toBe(expected);
	});
});

describe('formatProgress', () => {
	it.each(['en', 'zh'])('formats two decimals in %s', (locale) => {
		expect(formatProgress(.1005, locale)).toBe('10.05%');
		expect(formatProgress(0, locale)).toBe('0.00%');
		expect(formatProgress(1, locale)).toBe('100.00%');
		expect(formatProgress(.123456, locale)).toBe('12.35%');
		expect(formatProgress(NaN, locale)).toBe('0.00%');
		expect(formatProgress(Infinity, locale)).toBe('0.00%');
		expect(formatProgress(-1, locale)).toBe('0.00%');
		expect(formatProgress(2, locale)).toBe('100.00%');
	});
});
