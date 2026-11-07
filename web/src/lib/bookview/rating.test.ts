import { describe, expect, it } from 'vitest';
import { nextRating, ratingStars } from './rating.js';

describe('rating helpers', () => {
	it('maps the 1–10 scale to five full, half, or empty stars', () => {
		expect(ratingStars(null)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
		expect(ratingStars(1)).toEqual(['half', 'empty', 'empty', 'empty', 'empty']);
		expect(ratingStars(7)).toEqual(['full', 'full', 'full', 'half', 'empty']);
		expect(ratingStars(10)).toEqual(['full', 'full', 'full', 'full', 'full']);
		expect(() => ratingStars(0)).toThrow(RangeError);
		expect(() => ratingStars(1.5)).toThrow(RangeError);
	});

	it('moves half a star with arrow keys and supports Home and End', () => {
		expect(nextRating(null, 'ArrowRight')).toBe(1);
		expect(nextRating(null, 'ArrowLeft')).toBe(1);
		expect(nextRating(7, 'ArrowRight')).toBe(8);
		expect(nextRating(7, 'ArrowDown')).toBe(6);
		expect(nextRating(10, 'ArrowUp')).toBe(10);
		expect(nextRating(1, 'ArrowLeft')).toBe(1);
		expect(nextRating(5, 'Home')).toBe(1);
		expect(nextRating(5, 'End')).toBe(10);
		expect(nextRating(5, 'Tab')).toBeNull();
	});
});
