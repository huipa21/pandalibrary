import * as m from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';

function nonNegative(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number.`);
	return value;
}

export function formatSize(bytes: number, locale: string = getLocale()): string {
	const value = nonNegative(bytes, 'Size');
	const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
	if (value < 1024) return `${value} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let size = value / 1024;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	return `${formatter.format(size)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
	const value = Math.floor(nonNegative(seconds, 'Duration'));
	const hours = Math.floor(value / 3600);
	const minutes = Math.floor((value % 3600) / 60);
	const formatter = new Intl.NumberFormat(getLocale());
	if (hours && minutes) return m['bv3.duration_hours_minutes']({
		hours: formatter.format(hours), minutes: formatter.format(minutes)
	});
	if (hours) return m['bv3.duration_hours']({ hours: formatter.format(hours) });
	if (minutes) return m['bv3.duration_minutes']({ minutes: formatter.format(minutes) });
	return m['bv3.duration_seconds']({ seconds: formatter.format(value) });
}

export function formatPercent(fraction: number, locale: string = getLocale()): string {
	if (!Number.isFinite(fraction)) throw new RangeError('Percentage must be a finite number.');
	return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(fraction);
}

export function parseDate(iso: string): Date {
	const day = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(iso)?.[1];
	if (!day) throw new RangeError('Invalid ISO date.');
	const calendar = new Date(`${day}T00:00:00.000Z`);
	if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) {
		throw new RangeError('Invalid ISO date.');
	}
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid ISO date.');
	return date;
}

export function formatRelative(date: Date | string | number, now = new Date(), locale: string = getLocale()): string {
	const time = (typeof date === 'string' ? parseDate(date) : new Date(date)).getTime();
	const current = now.getTime();
	if (!Number.isFinite(time) || !Number.isFinite(current)) throw new RangeError('Invalid relative date.');
	const seconds = (time - current) / 1000;
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		['year', 365.25 * 86400], ['month', 30.4375 * 86400], ['week', 7 * 86400],
		['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]
	];
	const [unit, divisor] = units.find(([, size]) => Math.abs(seconds) >= size) ?? units[units.length - 1];
	return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(seconds / divisor), unit);
}

export function formatDate(iso: string, locale: string = getLocale()): string {
	const date = parseDate(iso);
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
	return new Intl.DateTimeFormat(locale, {
		dateStyle: 'medium',
		...(dateOnly ? { timeZone: 'UTC' } : {})
	}).format(date);
}

export function formatPublicationDate(iso: string, locale: string = getLocale()): string {
	if (/^\d{4}(?:-\d{2})?$/.test(iso)) return iso;
	return formatDate(iso.split('T')[0], locale);
}
