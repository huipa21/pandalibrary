import type { Book } from './types.js';

/**
 * Fills metadata fields that books cached before they existed (e.g. offline downloads in
 * IndexedDB) lack, so display code can rely on the current `Book` shape.
 */
export function withBookDefaults(book: Book): Book {
	const legacy = book as Partial<Book> & Book;
	return {
		...book,
		genres: Array.isArray(legacy.genres) ? legacy.genres : [],
		moods: Array.isArray(legacy.moods) ? legacy.moods : [],
		age_rating: legacy.age_rating ?? null,
		content_rating: legacy.content_rating ?? null,
		ratings: Array.isArray(legacy.ratings) ? legacy.ratings : [],
		series: legacy.series ? { ...legacy.series, total: legacy.series.total ?? null } : null
	};
}
