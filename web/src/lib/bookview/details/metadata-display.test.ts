import { describe, expect, it } from 'vitest';
import { contentRatingLabel, formatAgeRating, formatSeriesPosition, ratingSummaries } from './metadata-display.js';

describe('book metadata display', () => {
	it('formats age and content ratings', () => {
		expect(formatAgeRating(13, 'en')).toBe('13+');
		expect(formatAgeRating(0, 'en')).toBe('0+');
		expect(contentRatingLabel('teen')).toBe('Teen');
		expect(contentRatingLabel('adult')).toBe('Adult');
	});

	it('formats the series position from whatever index and total exist', () => {
		expect(formatSeriesPosition({ index: 2, total: 5 }, 'en')).toBe('#2 of 5');
		expect(formatSeriesPosition({ index: 1.5, total: null }, 'en')).toBe('#1.5');
		expect(formatSeriesPosition({ index: null, total: 3 }, 'en')).toBe('3 books');
		expect(formatSeriesPosition({ index: null, total: null }, 'en')).toBeNull();
	});

	it('summarizes scored provider ratings with names and counts', () => {
		const rows = ratingSummaries([
			{ provider: 'googlebooks', rating: 4.25, count: 1234 },
			{ provider: 'hardcover', rating: 3, count: null },
			{ provider: 'neodb', rating: null, count: 10 },
			{ provider: 'custom', rating: 5, count: 0 }
		], 'en');
		expect(rows).toEqual([
			{ provider: 'googlebooks', name: 'Google Books', rating: '4.3', count: '1,234', label: 'Google Books: 4.3 out of 5 from 1,234 ratings' },
			{ provider: 'hardcover', name: 'Hardcover', rating: '3.0', count: null, label: 'Hardcover: 3.0 out of 5' },
			{ provider: 'custom', name: 'custom', rating: '5.0', count: '0', label: 'custom: 5.0 out of 5 from 0 ratings' }
		]);
		expect(ratingSummaries(undefined)).toEqual([]);
	});
});
