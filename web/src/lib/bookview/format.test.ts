import { describe, expect, it } from 'vitest';
import { formatDate, formatDuration, formatPercent, formatPublicationDate, formatRelative, formatSize, parseDate } from './format.js';

describe('book view formatting', () => {
	it('formats byte sizes and handles each unit boundary', () => {
		expect(formatSize(0, 'en')).toBe('0 B');
		expect(formatSize(1023, 'en')).toBe('1023 B');
		expect(formatSize(1536, 'en')).toBe('1.5 KB');
		expect(formatSize(1024 ** 2, 'en')).toBe('1 MB');
		expect(formatSize(1024 ** 3, 'en')).toBe('1 GB');
		expect(formatSize(1024 ** 4, 'en')).toBe('1 TB');
		expect(formatSize(1536, 'de')).toBe('1,5 KB');
		expect(() => formatSize(-1)).toThrow(RangeError);
	});

	it('formats seconds, minutes, and hours', () => {
		expect(formatDuration(54)).toBe('54s');
		expect(formatDuration(60)).toBe('1m');
		expect(formatDuration(2 * 3600 + 56 * 60)).toBe('2h 56m');
		expect(formatDuration(3600)).toBe('1h');
		expect(formatDuration(0)).toBe('0s');
		expect(() => formatDuration(Number.NaN)).toThrow(RangeError);
	});

	it('formats a fraction as a locale-aware percentage', () => {
		expect(formatPercent(0.25, 'en')).toBe('25%');
		expect(formatPercent(0.25, 'de')).toContain('25');
		expect(() => formatPercent(Infinity)).toThrow(RangeError);
	});

	it('formats relative dates in both directions and rejects invalid dates', () => {
		const now = new Date('2026-11-07T12:00:00Z');
		expect(formatRelative('2026-11-06T12:00:00Z', now, 'en')).toBe('yesterday');
		expect(formatRelative('2026-11-07T14:00:00Z', now, 'en')).toBe('in 2 hours');
		expect(formatRelative('2026-11-07T11:59:30Z', now, 'en')).toBe('30 seconds ago');
		expect(formatRelative('2026-11-06T12:00:00Z', now, 'zh')).toBe('昨天');
		expect(() => formatRelative('invalid', now)).toThrow(RangeError);
	});

	it('formats calendar dates without shifting date-only values', () => {
		expect(parseDate('2024-02-29').toISOString()).toBe('2024-02-29T00:00:00.000Z');
		expect(formatDate('2026-11-07', 'en')).toBe('Nov 7, 2026');
		expect(formatDate('2026-11-07', 'zh')).toContain('2026');
		expect(() => formatDate('invalid')).toThrow(RangeError);
		expect(() => formatDate('2026-02-31')).toThrow(RangeError);
		expect(() => formatDate('2026-02-31T12:00:00Z')).toThrow(RangeError);
	});

	it('formats publication dates without a time or timezone day shift', () => {
		expect(formatPublicationDate('2026-11-07', 'en')).toBe('Nov 7, 2026');
		expect(formatPublicationDate('2026-11-07T00:30:00+14:00', 'en')).toBe('Nov 7, 2026');
		expect(formatPublicationDate('2026-11-07T23:30:00-12:00', 'en')).toBe('Nov 7, 2026');
		expect(formatPublicationDate('2024-02-29T12:00:00Z', 'zh')).toBe(formatDate('2024-02-29', 'zh'));
	});

	it('preserves partial publication dates without inventing a month or day', () => {
		expect(formatPublicationDate('2026', 'en')).toBe('2026');
		expect(formatPublicationDate('2026-11', 'en')).toBe('2026-11');
		expect(formatPublicationDate('2026-11', 'zh')).toBe('2026-11');
	});
});
