import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import {
	addDays,
	barHeights,
	browserTimeZone,
	buildStatsPath,
	dayNumber,
	durationParts,
	fetchStats,
	formatCalendar,
	hasPositive,
	inclusiveDayCount,
	localDateString,
	MAX_RANGE_DAYS,
	rangeEndingToday,
	statsErrorKey,
	totals,
	validateRange
} from './api.js';

afterEach(() => vi.restoreAllMocks());

describe('stats date ranges', () => {
	it('sends inclusive local dates and the IANA timezone without converting to UTC', () => {
		const params = new URLSearchParams(buildStatsPath({ from: '2026-03-01', to: '2026-03-31' }, 'America/New_York').split('?')[1]);

		expect(buildStatsPath({ from: '2026-01-01', to: '2026-01-31' }, 'Asia/Shanghai')).toBe(
			'/stats?from=2026-01-01&to=2026-01-31&timezone=Asia%2FShanghai'
		);
		expect([...params.keys()]).toEqual(['from', 'to', 'timezone']);
		expect(params.get('from')).toBe('2026-03-01');
		expect(params.get('to')).toBe('2026-03-31');
		expect(params.get('timezone')).toBe('America/New_York');
	});

	it('uses the browser-resolved IANA timezone', () => {
		expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
			() => ({ resolvedOptions: () => ({ timeZone: 'Pacific/Apia' }) }) as unknown as Intl.DateTimeFormat
		);
		expect(browserTimeZone()).toBe('Pacific/Apia');
	});

	it('takes today from local calendar fields and counts back whole calendar days', () => {
		// 23:30 local time stays on the local date even when UTC has already moved on.
		const lateEvening = new Date(2026, 2, 8, 23, 30);
		expect(localDateString(lateEvening)).toBe('2026-03-08');
		expect(rangeEndingToday(30, lateEvening)).toEqual({ from: '2026-02-07', to: '2026-03-08' });
		expect(rangeEndingToday(1, lateEvening)).toEqual({ from: '2026-03-08', to: '2026-03-08' });
		expect(inclusiveDayCount('2026-02-07', '2026-03-08')).toBe(30);
	});

	it('does calendar arithmetic across DST changes, month ends, and leap days', () => {
		expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
		expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
		expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
		expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
		expect(addDays('0001-01-02', -1)).toBe('0001-01-01');
		expect(dayNumber('2026-02-30')).toBeNull();
		expect(dayNumber('2026-1-01')).toBeNull();
		expect(dayNumber('0000-01-01')).toBeNull();
	});

	it('enforces the 366-day inclusive limit and range order before submitting', () => {
		expect(validateRange({ from: '2024-01-01', to: '2024-12-31' })).toBeNull();
		expect(inclusiveDayCount('2024-01-01', '2024-12-31')).toBe(MAX_RANGE_DAYS);
		expect(validateRange({ from: '2025-01-01', to: '2026-01-01' })).toBeNull();
		expect(validateRange({ from: '2025-01-01', to: '2026-01-02' })).toBe('too_long');
		expect(validateRange({ from: '2026-01-02', to: '2026-01-01' })).toBe('reversed');
		expect(validateRange({ from: '2026-01-01', to: '2026-01-01' })).toBeNull();
		expect(validateRange({ from: '', to: '2026-01-01' })).toBe('invalid_from');
		expect(validateRange({ from: '2026-01-01', to: '2026-13-01' })).toBe('invalid_to');
		expect(rangeEndingToday(1000, new Date(2026, 0, 1))).toEqual({ from: '2025-01-01', to: '2026-01-01' });
	});

	it('requests stats through the shared client without caching', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({});
		const controller = new AbortController();
		await fetchStats({ from: '2026-01-01', to: '2026-01-02' }, 'UTC', controller.signal);

		expect(request).toHaveBeenCalledWith('/stats?from=2026-01-01&to=2026-01-02&timezone=UTC', {
			signal: controller.signal,
			cache: 'no-store'
		});
	});

	it('classifies validation, session, connection, and server failures', () => {
		const problem = (status: number) => new ApiError(status, '', '{}', { status, detail: 'Range too long.' });
		expect(statsErrorKey(problem(400))).toBe('stats.error.invalid');
		expect(statsErrorKey(problem(401))).toBe('stats.error.session');
		expect(statsErrorKey(problem(500))).toBe('stats.error.api');
		expect(statsErrorKey(new TypeError('offline'))).toBe('stats.error.connection');
	});
});

describe('stats display helpers', () => {
	it('formats seconds for display without changing the underlying value', () => {
		expect(durationParts(0)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
		expect(durationParts(59)).toEqual({ hours: 0, minutes: 0, seconds: 59 });
		expect(durationParts(3725)).toEqual({ hours: 1, minutes: 2, seconds: 5 });
		expect(durationParts(-5)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
	});

	it('keeps zero-filled days in totals and treats an all-zero series as empty', () => {
		const daily = [
			{ date: '2026-01-01', active_seconds: 0, session_count: 0 },
			{ date: '2026-01-02', active_seconds: 600, session_count: 2 },
			{ date: '2026-01-03', active_seconds: 0, session_count: 1 }
		];
		expect(totals(daily)).toEqual({ activeSeconds: 600, sessions: 3, activeDays: 1 });
		expect(totals([])).toEqual({ activeSeconds: 0, sessions: 0, activeDays: 0 });
		expect(hasPositive([0, 0, 0])).toBe(false);
		expect(hasPositive([])).toBe(false);
		expect(barHeights([0, 0, 0], 100)).toEqual([0, 0, 0]);
		expect(barHeights([], 100)).toEqual([]);
	});

	it('scales bars to the peak and keeps small positive values visible', () => {
		expect(barHeights([0, 50, 100], 100)).toEqual([0, 50, 100]);
		expect(barHeights([1, 1000], 100)).toEqual([2, 100]);
	});

	it('formats calendar dates and months in UTC so the label never shifts a day', () => {
		expect(formatCalendar('2026-01-01', 'en')).toBe('Jan 1, 2026');
		expect(formatCalendar('2026-02', 'en', true)).toBe('Feb 2026');
		expect(formatCalendar('not-a-date', 'en')).toBe('not-a-date');
	});

	it('defines the same stats and notes translations in English and Chinese', () => {
		const pick = (messages: Record<string, string>) =>
			Object.keys(messages).filter((key) => key.startsWith('stats.') || key.startsWith('notes.')).sort();
		const englishKeys = pick(en);

		expect(englishKeys.length).toBeGreaterThan(90);
		expect(pick(zh)).toEqual(englishKeys);
		for (const key of englishKeys) {
			const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
			expect(placeholders((zh as Record<string, string>)[key]), key).toEqual(placeholders((en as Record<string, string>)[key]));
			expect((zh as Record<string, string>)[key], key).not.toBe('');
		}
		for (const key of ['stats.error.invalid', 'stats.error.session', 'stats.error.api', 'stats.error.connection']) {
			expect(en).toHaveProperty([key]);
		}
	});
});
