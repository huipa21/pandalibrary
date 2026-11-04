import { api } from '#lib/api/client.js';
import { requestErrorKind } from '#lib/paging/errors.js';
import * as m from '#lib/paraglide/messages.js';
import type { DateRange, StatsDay, StatsResponse } from './types.js';

/** ST1 accepts at most 366 inclusive local calendar dates. */
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;
export const RANGE_PRESETS = [7, 30, 90, 365] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** The browser's IANA zone; ST1 buckets sessions into local days for this zone. */
export function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

function pad(value: number, length = 2): string {
	return String(value).padStart(length, '0');
}

/** Today's (or the given instant's) calendar date in the browser's local time. */
export function localDateString(now: Date = new Date()): string {
	return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Maps a canonical `YYYY-MM-DD` date to a proleptic day number. Calendar arithmetic is
 * done on day numbers only, so local DST transitions never shift a date.
 */
export function dayNumber(value: string): number | null {
	const match = DATE_PATTERN.exec(value);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (year < 1 || month < 1 || month > 12 || day < 1) return null;
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return null;
	}
	return Math.round(date.getTime() / MS_PER_DAY);
}

function fromDayNumber(days: number): string {
	const date = new Date(days * MS_PER_DAY);
	return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Adds whole calendar days to a canonical date. */
export function addDays(value: string, days: number): string {
	const base = dayNumber(value);
	if (base === null) throw new RangeError(`Invalid calendar date: ${value}`);
	return fromDayNumber(base + days);
}

/** Number of dates in an inclusive range, or null if either date is invalid. */
export function inclusiveDayCount(from: string, to: string): number | null {
	const start = dayNumber(from);
	const end = dayNumber(to);
	return start === null || end === null ? null : end - start + 1;
}

/** An inclusive range of `days` local dates ending today. */
export function rangeEndingToday(days: number, now: Date = new Date()): DateRange {
	const to = localDateString(now);
	return { from: addDays(to, -(Math.max(1, Math.min(days, MAX_RANGE_DAYS)) - 1)), to };
}

export type RangeIssue = 'invalid_from' | 'invalid_to' | 'reversed' | 'too_long';

/** Mirrors ST1's range rules so obviously invalid requests are never sent. */
export function validateRange({ from, to }: DateRange): RangeIssue | null {
	const start = dayNumber(from);
	if (start === null) return 'invalid_from';
	const end = dayNumber(to);
	if (end === null) return 'invalid_to';
	if (end < start) return 'reversed';
	if (end - start + 1 > MAX_RANGE_DAYS) return 'too_long';
	return null;
}

/** Sends all three required parameters verbatim; dates are never converted to UTC. */
export function buildStatsPath({ from, to }: DateRange, timeZone: string): string {
	return `/stats?${new URLSearchParams({ from, to, timezone: timeZone })}`;
}

export function fetchStats(range: DateRange, timeZone: string, signal?: AbortSignal): Promise<StatsResponse> {
	return api.request(buildStatsPath(range, timeZone), { signal, cache: 'no-store' });
}

export function statsErrorKey(error: unknown): string {
	switch (requestErrorKind(error)) {
		case 'invalid':
			return 'stats.error.invalid';
		case 'connection':
			return 'stats.error.connection';
		case 'unauthorized':
			return 'stats.error.session';
		default:
			return 'stats.error.api';
	}
}

export interface DurationParts {
	hours: number;
	minutes: number;
	seconds: number;
}

/** Splits a non-negative second count for display; the source value is never altered. */
export function durationParts(totalSeconds: number): DurationParts {
	const value = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
	return { hours: Math.floor(value / 3600), minutes: Math.floor((value % 3600) / 60), seconds: value % 60 };
}

export function formatDuration(totalSeconds: number): string {
	const { hours, minutes, seconds } = durationParts(totalSeconds);
	if (hours > 0) return m['stats.duration.hours_minutes']({ hours, minutes });
	if (minutes > 0 || seconds === 0) return m['stats.duration.minutes']({ minutes });
	return m['stats.duration.seconds']({ seconds });
}

export interface StatsTotals {
	activeSeconds: number;
	sessions: number;
	activeDays: number;
}

export function totals(daily: readonly StatsDay[]): StatsTotals {
	return daily.reduce(
		(sum, day) => ({
			activeSeconds: sum.activeSeconds + day.active_seconds,
			sessions: sum.sessions + day.session_count,
			activeDays: sum.activeDays + (day.active_seconds > 0 ? 1 : 0)
		}),
		{ activeSeconds: 0, sessions: 0, activeDays: 0 }
	);
}

/**
 * Scales values to bar heights within `[0, max]`. An all-zero (or empty) series yields
 * zero heights rather than dividing by zero; any positive value gets a visible bar.
 */
export function barHeights(values: readonly number[], max: number, minVisible = 2): number[] {
	const peak = values.reduce((highest, value) => (value > highest ? value : highest), 0);
	if (peak <= 0) return values.map(() => 0);
	return values.map((value) => (value > 0 ? Math.max(minVisible, (value / peak) * max) : 0));
}

export function hasPositive(values: readonly number[]): boolean {
	return values.some((value) => value > 0);
}

/** Formats a calendar date or month for display without reinterpreting it in another zone. */
export function formatCalendar(value: string, locale: string, month = false): string {
	const days = dayNumber(month ? `${value}-01` : value);
	if (days === null) return value;
	const options: Intl.DateTimeFormatOptions = month
		? { year: 'numeric', month: 'short', timeZone: 'UTC' }
		: { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' };
	return new Intl.DateTimeFormat(locale, options).format(new Date(days * MS_PER_DAY));
}
