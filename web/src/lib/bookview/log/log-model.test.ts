import { describe, expect, it } from 'vitest';
import type { BookSession, ReadingDay } from '../log-api.js';
import {
	CHART, attemptDividers, changeTone, chartSeries, formatCalendarDay, groupSessionsByDay, sessionsToCsv
} from './log-model.js';

function session(id: string, started_at: string, attempt = 1, extra: Partial<BookSession> = {}): BookSession {
	return {
		id, started_at, ended_at: started_at, active_seconds: 300, start_percentage: 0.3,
		end_percentage: 0.2, change: -0.1, source: 'web', device: 'Reader', attempt, ...extra
	};
}

const day = (date: string, max_percentage: number | null, seconds = 600): ReadingDay =>
	({ date, max_percentage, seconds, sessions: 1 });

describe('session presentation', () => {
	it('groups local calendar days correctly across the spring DST transition', () => {
		const items = [
			session('1', '2026-03-09T03:30:00Z'),
			session('2', '2026-03-08T07:30:00Z'),
			session('3', '2026-03-08T06:30:00Z'),
			session('4', '2026-03-08T04:30:00Z')
		];
		const groups = groupSessionsByDay(items, 'America/New_York');
		expect(groups.map((group) => [group.date, group.sessions.map((item) => item.id)])).toEqual([
			['2026-03-08', ['1', '2', '3']], ['2026-03-07', ['4']]
		]);
		expect(groups[0].label).toBe('Mar 8 Sun');
		expect(groupSessionsByDay([], 'UTC')).toEqual([]);
		expect(groupSessionsByDay(items, 'UTC').map((group) => group.date)).toEqual([
			'2026-03-09', '2026-03-08'
		]);
	});

	it('keeps both occurrences of a repeated fall-back hour on the same local day', () => {
		const groups = groupSessionsByDay([
			session('1', '2026-11-01T06:30:00Z'),
			session('2', '2026-11-01T05:30:00Z'),
			session('3', '2026-11-01T03:30:00Z')
		], 'America/New_York');
		expect(groups.map((group) => [group.date, group.sessions.length]))
			.toEqual([['2026-11-01', 2], ['2026-10-31', 1]]);
	});

	it('marks an attempt at the boundary with the older attempt', () => {
		const items = [
			session('a', '2026-04-04T00:00:00Z', 3),
			session('b', '2026-04-03T00:00:00Z', 3),
			session('c', '2026-04-02T00:00:00Z', 2),
			session('d', '2026-04-01T00:00:00Z', 1)
		];
		expect(attemptDividers(items)).toEqual([
			{ kind: 'session', session: items[0] }, { kind: 'session', session: items[1] },
			{ kind: 'attempt', attempt: 3, startedAt: items[1].started_at },
			{ kind: 'session', session: items[2] },
			{ kind: 'attempt', attempt: 2, startedAt: items[2].started_at },
			{ kind: 'session', session: items[3] }
		]);
		expect(attemptDividers([])).toEqual([]);
	});

	it('distinguishes positive, backward and unknown changes', () => {
		expect([changeTone(0.01), changeTone(-0.2), changeTone(0), changeTone(null)])
			.toEqual(['positive', 'negative', 'neutral', 'neutral']);
	});

	it('writes RFC 4180 records, including quoted commas, quotes and line breaks', () => {
		const items = [session('1', '2026-01-02T03:00:00Z', 2, {
			device: 'Kobo, "bedroom"\r\nsecond line', start_percentage: null, change: null
		})];
		const header = 'started_at,ended_at,active_seconds,start_percentage,end_percentage,change,source,device,attempt';
		expect(sessionsToCsv(items)).toBe(`${header}\r\n` +
			'2026-01-02T03:00:00Z,2026-01-02T03:00:00Z,300,,0.2,,web,"Kobo, ""bedroom""\r\nsecond line",2\r\n');
		expect(sessionsToCsv([])).toBe(`${header}\r\n`);
	});
});

describe('progress chart', () => {
	it('uses calendar-day spacing across DST and produces different smooth and step paths', () => {
		const days = [
			day('2026-03-07', 0.1, 120), day('2026-03-08', 0.5, 600), day('2026-03-09', 0.25, 300)
		];
		const curve = chartSeries(days, 'curve');
		const trace = chartSeries(days, 'trace');
		expect(curve.path).toContain(' C ');
		expect(trace.path).toContain(' H ');
		expect(trace.path).toContain(' V ');
		expect(curve.path).not.toBe(trace.path);
		expect(curve.points[1].x - curve.points[0].x).toBe(curve.points[2].x - curve.points[1].x);
		expect(curve.points.map((point) => point.minutes)).toEqual([2, 10, 5]);
		expect(curve.percentTicks.map((tick) => tick.value)).toEqual([0, 25, 50, 75, 100]);
		expect(curve.minuteTicks.at(-1)?.value).toBe(10);
		expect(chartSeries([day('2026-03-07', 0.1, 1)], 'curve').minuteTicks.map((tick) => tick.value))
			.toEqual([0, 0.01, 0.02]);
	});

	it('does not overshoot a monotonic segment when smoothing uneven data', () => {
		const result = chartSeries([
			day('2026-01-01', 0.05), day('2026-01-02', 0.9), day('2026-01-20', 0.91)
		], 'curve');
		const segments = result.path.split(' C ').slice(1);
		for (let index = 0; index < segments.length; index += 1) {
			const values = segments[index].split(' ').map(Number);
			const [start, end] = [result.points[index].y!, result.points[index + 1].y!].sort((a, b) => a - b);
			expect(values[1]).toBeGreaterThanOrEqual(start - 0.01);
			expect(values[1]).toBeLessThanOrEqual(end + 0.01);
			expect(values[3]).toBeGreaterThanOrEqual(start - 0.01);
			expect(values[3]).toBeLessThanOrEqual(end + 0.01);
		}
	});

	it('keeps bars for nearby days separate even when the time span is long', () => {
		const result = chartSeries([
			day('2026-01-01', 0.1), day('2026-01-02', 0.2), day('2026-12-31', 0.3)
		], 'curve');
		expect(result.barWidth * 1.5).toBeLessThan(result.points[1].x - result.points[0].x);
		expect(result.dateTicks.map((tick) => tick.date)).toEqual(['2026-01-01', '2026-12-31']);
	});

	it('sizes the plot and spaces date labels for a narrow chart', () => {
		const days = Array.from({ length: 20 }, (_, index) =>
			day(`2026-01-${String(index + 1).padStart(2, '0')}`, 0.5));
		const result = chartSeries(days, 'curve', 300);
		expect(result.points[0].x).toBe(CHART.left);
		expect(result.points.at(-1)?.x).toBe(300 - CHART.right);
		expect(result.dateTicks.length).toBeGreaterThanOrEqual(2);
		expect(result.dateTicks.length).toBeLessThan(8);
		for (let index = 1; index < result.dateTicks.length; index += 1) {
			expect(result.dateTicks[index].x - result.dateTicks[index - 1].x).toBeGreaterThanOrEqual(72);
		}
		expect(() => chartSeries(days, 'curve', CHART.left + CHART.right)).toThrow(RangeError);
	});

	it('handles missing progress, an empty chart, a single day and at most eight labels', () => {
		const empty = chartSeries([], 'curve');
		expect(empty.path).toBe('');
		expect(empty.points).toEqual([]);
		expect(empty.dateTicks).toEqual([]);
		const missing = chartSeries([day('2026-01-01', null), day('2026-01-02', 0.5)], 'trace');
		expect(missing.points[0].y).toBeNull();
		expect(missing.path).toMatch(/^M /);
		expect(missing.path).not.toContain(' H ');
		const single = chartSeries([day('2026-01-01', 1)], 'curve');
		expect(single.points[0].x).toBe(CHART.width / 2);
		expect(single.points[0].y).toBe(CHART.top);
		const many = Array.from({ length: 20 }, (_, index) => day(`2026-01-${String(index + 1).padStart(2, '0')}`, 0.5));
		const labels = chartSeries(many, 'curve').dateTicks;
		expect(labels.length).toBeGreaterThanOrEqual(2);
		expect(labels.length).toBeLessThanOrEqual(8);
		expect(formatCalendarDay('2026-03-08', 'en-US')).toContain('Mar 8, 2026');
		expect(() => chartSeries([day('2026-02-31', 0)], 'curve')).toThrow(RangeError);
		expect(() => chartSeries([day('2026-02-02', 0), day('2026-02-01', 0)], 'curve')).toThrow(RangeError);
	});
});
