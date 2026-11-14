import { api } from '#lib/api/client.js';
import { formatCalendar } from './api.js';
import type { BookBucket, BookStatsResponse, ChartDatum } from './book-types.js';

export function fetchBookStats(timeZone: string, signal?: AbortSignal): Promise<BookStatsResponse> {
	return api.request(`/stats/books?${new URLSearchParams({ timezone: timeZone })}`, { signal, cache: 'no-store' });
}

export function formatCount(value: number, locale: string): string {
	return new Intl.NumberFormat(locale).format(value);
}

export function formatBookShare(count: number, total: number, locale: string): string {
	const percentage = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(total > 0 ? count / total : 0);
	return `${formatCount(count, locale)} (${percentage})`;
}

export function bucketData(
	buckets: readonly BookBucket[],
	label: (key: string) => string,
	locale: string,
	total?: number
): ChartDatum[] {
	return buckets.map(({ key, count }) => ({
		key,
		label: label(key),
		value: count,
		display: total === undefined ? formatCount(count, locale) : formatBookShare(count, total, locale)
	}));
}

export function publicationTimeline(buckets: readonly BookBucket[]): BookBucket[] {
	return buckets.filter(({ key }) => /^\d+$/.test(key)).toSorted((a, b) => Number(a.key) - Number(b.key));
}

export function addedLabel(key: string, locale: string): string {
	return formatCalendar(key, locale, /^\d{4}-\d{2}$/.test(key));
}

export function languageLabel(key: string, locale: string): string {
	try {
		return new Intl.DisplayNames([locale], { type: 'language' }).of(key) ?? key;
	} catch {
		return key;
	}
}

export function topTwenty<T>(items: readonly T[], value: (item: T) => number): T[] {
	return items.toSorted((a, b) => value(b) - value(a)).slice(0, 20);
}
