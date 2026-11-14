import { describe, expect, it } from 'vitest';
import { yearCalendar } from './heatmap-geometry.js';

describe('reading heatmap calendar', () => {
	it('includes leap day and assigns Monday-first rows without shifting dates', () => {
		const calendar = yearCalendar(2024);
		expect(calendar.days).toHaveLength(366);
		expect(calendar.days[0]).toEqual({ date: '2024-01-01', week: 0, weekday: 0 });
		expect(calendar.days.find((day) => day.date === '2024-02-29'))
			.toEqual({ date: '2024-02-29', week: 8, weekday: 3 });
		expect(calendar.days.at(-1)).toEqual({ date: '2024-12-31', week: 52, weekday: 1 });
		expect(calendar.weeks).toBe(53);
	});

	it('preserves partial weeks at both year boundaries, including 54-week years', () => {
		const calendar = yearCalendar(2012);
		expect(calendar.days[0]).toEqual({ date: '2012-01-01', week: 0, weekday: 6 });
		expect(calendar.days.at(-1)).toEqual({ date: '2012-12-31', week: 53, weekday: 0 });
		expect(calendar.weeks).toBe(54);
		expect(new Set(calendar.days.map((day) => `${day.week}/${day.weekday}`)).size).toBe(366);
		expect(calendar.days.every((day) => day.date.startsWith('2012-'))).toBe(true);
	});

	it('omits leap day in a common century year and handles early calendar years', () => {
		expect(yearCalendar(1900).days).toHaveLength(365);
		expect(yearCalendar(1900).days.some((day) => day.date === '1900-02-29')).toBe(false);
		expect(yearCalendar(1).days[0]).toEqual({ date: '0001-01-01', week: 0, weekday: 0 });
		expect(() => yearCalendar(0)).toThrow(RangeError);
	});
});
