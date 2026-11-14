import { describe, expect, it } from 'vitest';
import { aggregateReadingHabits, defaultReadingMonth } from './reading-habits.js';

describe('reading habits', () => {
	it('groups local calendar dates Monday first, independently of the browser timezone', () => {
		const result = aggregateReadingHabits({
			year: 2026,
			daily: [
				{ date: '2026-11-02', active_seconds: 1800, session_count: 1 },
				{ date: '2026-11-09', active_seconds: 3600, session_count: 1 },
				{ date: '2026-11-01', active_seconds: 7200, session_count: 1 },
				{ date: '2026-10-26', active_seconds: 3600, session_count: 1 },
				{ date: '2025-11-03', active_seconds: 3600, session_count: 1 }
			],
			hours: []
		}, 11);
		expect(result.weekdays).toEqual([1.5, 0, 0, 0, 0, 0, 2]);
	});

	it('combines monthly hour buckets without merging midnight with the final hour', () => {
		const data = {
			year: 2026, daily: [],
			hours: [
				{ month: 1, hour: 0, active_seconds: 1800, session_count: 1 },
				{ month: 2, hour: 0, active_seconds: 3600, session_count: 1 },
				{ month: 2, hour: 23, active_seconds: 7200, session_count: 1 }
			]
		};
		const all = aggregateReadingHabits(data, 0);
		expect(all.hours).toHaveLength(24);
		expect(all.hours[0]).toBe(1.5);
		expect(all.hours[23]).toBe(2);
		expect(aggregateReadingHabits(data, 1).hours[0]).toBe(0.5);
		expect(aggregateReadingHabits(data, 1).hours[23]).toBe(0);
		expect(aggregateReadingHabits(data, 3).hours.every((hours) => hours === 0)).toBe(true);
	});

	it('rejects impossible dates and invalid buckets while preserving leap days and fractional hours', () => {
		const result = aggregateReadingHabits({
			year: 2024,
			daily: [
				{ date: '2024-02-29', active_seconds: 900, session_count: 1 },
				{ date: '2024-02-30', active_seconds: 3600, session_count: 1 },
				{ date: '2024-13-01', active_seconds: 3600, session_count: 1 },
				{ date: '2024-02-01', active_seconds: NaN, session_count: 1 },
				{ date: '2024-02-02', active_seconds: -60, session_count: 1 }
			],
			hours: [
				{ month: 2, hour: 5, active_seconds: 900, session_count: 1 },
				{ month: 2, hour: 24, active_seconds: 3600, session_count: 1 },
				{ month: 13, hour: 5, active_seconds: 3600, session_count: 1 },
				{ month: 2, hour: 1.5, active_seconds: 3600, session_count: 1 },
				{ month: 2, hour: 5, active_seconds: Infinity, session_count: 1 }
			]
		}, 0);
		expect(result.weekdays).toEqual([0, 0, 0, 0.25, 0, 0, 0]);
		expect(result.hours[5]).toBe(0.25);
		expect(result.hours.reduce((sum, value) => sum + value, 0)).toBe(0.25);
	});

	it('defaults to the current month in the requested timezone and all months for another year', () => {
		const now = new Date('2026-01-01T00:30:00Z');
		expect(defaultReadingMonth(2025, 'America/Los_Angeles', now)).toBe(12);
		expect(defaultReadingMonth(2026, 'America/Los_Angeles', now)).toBe(0);
		expect(defaultReadingMonth(2026, 'Asia/Shanghai', now)).toBe(1);
	});
});
