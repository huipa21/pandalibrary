import { describe, expect, it } from 'vitest';
import { withBookDefaults } from './book-defaults.js';
import type { Book } from './types.js';

describe('withBookDefaults', () => {
	it('fills metadata fields missing from books cached before they existed', () => {
		const legacy = { id: 1, title: 'Old', series: { id: 2, name: 'S', index: 1 } } as unknown as Book;
		expect(withBookDefaults(legacy)).toMatchObject({
			genres: [], moods: [], age_rating: null, content_rating: null, ratings: [],
			series: { id: 2, name: 'S', index: 1, total: null }
		});
		expect(withBookDefaults({ ...legacy, series: null }).series).toBeNull();
	});

	it('keeps metadata that is present', () => {
		const book = {
			id: 1, series: { id: 2, name: 'S', index: 1, total: 4 }, genres: ['Fantasy'], moods: ['Dark'],
			age_rating: 16, content_rating: 'mature', ratings: [{ provider: 'hardcover', rating: 4, count: 2 }]
		} as unknown as Book;
		expect(withBookDefaults(book)).toEqual(book);
	});
});
