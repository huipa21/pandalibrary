import type { ContentRating, ProviderRating, Series } from '#lib/catalog/types.js';
import * as m from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';

export function formatAgeRating(age: number, locale: string = getLocale()): string {
	return m['bm8.age_rating_value']({ age: new Intl.NumberFormat(locale).format(age) });
}

export function contentRatingLabel(rating: ContentRating): string {
	switch (rating) {
		case 'everyone': return m['bm8.content_rating_everyone']();
		case 'teen': return m['bm8.content_rating_teen']();
		case 'mature': return m['bm8.content_rating_mature']();
		case 'adult': return m['bm8.content_rating_adult']();
		default: return rating;
	}
}

/** "#2 of 5", "#2", "5 books", or null when the series carries no position. */
export function formatSeriesPosition(series: Pick<Series, 'index' | 'total'>, locale: string = getLocale()): string | null {
	const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
	const total = series.total ?? null;
	if (series.index !== null && total !== null) {
		return m['bm8.series_position']({ index: number.format(series.index), total: number.format(total) });
	}
	if (series.index !== null) return m['bm8.series_index']({ index: number.format(series.index) });
	if (total !== null) return m['bm8.series_total']({ total: number.format(total) });
	return null;
}

export function ratingProviderName(provider: string): string {
	switch (provider.trim().toLowerCase()) {
		case 'googlebooks': return m['admin.providers.name.googlebooks']();
		case 'openlibrary': return m['admin.providers.name.openlibrary']();
		case 'neodb': return m['admin.providers.name.neodb']();
		case 'hardcover': return m['admin.providers.name.hardcover']();
		case 'douban': return m['bm8.provider_douban']();
		case 'goodreads': return m['bm8.provider_goodreads']();
		case 'amazon': return m['bm8.provider_amazon']();
		default: return provider;
	}
}

export interface RatingSummary {
	readonly provider: string;
	readonly name: string;
	readonly rating: string;
	readonly count: string | null;
	readonly label: string;
}

/** Display rows for provider ratings that carry a score; ratings without one are omitted. */
export function ratingSummaries(ratings: readonly ProviderRating[] | null | undefined, locale: string = getLocale()): RatingSummary[] {
	const score = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
	const integer = new Intl.NumberFormat(locale);
	return (ratings ?? []).flatMap((item) => {
		if (item.rating === null || !Number.isFinite(item.rating)) return [];
		const name = ratingProviderName(item.provider);
		const rating = score.format(item.rating);
		const count = item.count === null || !Number.isFinite(item.count) ? null : integer.format(item.count);
		const label = count === null
			? m['bm8.provider_rating']({ provider: name, rating })
			: m['bm8.provider_rating_count']({ provider: name, rating, count });
		return [{ provider: item.provider, name, rating, count, label }];
	});
}
