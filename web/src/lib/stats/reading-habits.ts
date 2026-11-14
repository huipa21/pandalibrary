import type { ReadingStats } from './reading-types.js';

/** Zero selects the whole year; calendar defaults use the statistics timezone. */
export function defaultReadingMonth(year: number, timezone: string, now = new Date()): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone, year: 'numeric', month: 'numeric'
	}).formatToParts(now);
	const currentYear = Number(parts.find((part) => part.type === 'year')?.value);
	const month = Number(parts.find((part) => part.type === 'month')?.value);
	return currentYear === year ? month : 0;
}

export function aggregateReadingHabits(
	data: Pick<ReadingStats, 'year' | 'daily' | 'hours'>,
	month: number
): { weekdays: number[]; hours: number[] } {
	const weekdays = Array<number>(7).fill(0);
	const hours = Array<number>(24).fill(0);
	for (const day of data.daily) {
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.date);
		if (!match || !Number.isFinite(day.active_seconds) || day.active_seconds <= 0) continue;
		const [year, localMonth, date] = match.slice(1).map(Number);
		if (year !== data.year || (month !== 0 && localMonth !== month)) continue;
		// Use UTC only as a calendar calculator, never as the timezone of the local date.
		const calendar = new Date(0);
		calendar.setUTCFullYear(year, localMonth - 1, date);
		if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== localMonth - 1 || calendar.getUTCDate() !== date) continue;
		weekdays[(calendar.getUTCDay() + 6) % 7] += day.active_seconds / 3600;
	}
	for (const bucket of data.hours) {
		if (!Number.isInteger(bucket.month) || bucket.month < 1 || bucket.month > 12 ||
			!Number.isInteger(bucket.hour) || bucket.hour < 0 || bucket.hour > 23 ||
			!Number.isFinite(bucket.active_seconds) || bucket.active_seconds <= 0 ||
			(month !== 0 && bucket.month !== month)) continue;
		hours[bucket.hour] += bucket.active_seconds / 3600;
	}
	return { weekdays, hours };
}
