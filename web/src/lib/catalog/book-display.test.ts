import { describe, expect, it } from 'vitest';
import { BOOK_DISPLAY_PRESETS, bookDisplay } from './book-display.svelte.js';

describe('book display presets', () => {
	it('offers four increasing cover sizes with matching spacing', () => {
		expect(BOOK_DISPLAY_PRESETS.map(({ id, size, spacing }) => ({ id, size, spacing }))).toEqual([
			{ id: 'small', size: 120, spacing: 8 },
			{ id: 'medium', size: 160, spacing: 12 },
			{ id: 'big', size: 208, spacing: 20 },
			{ id: 'large', size: 240, spacing: 24 }
		]);
	});

	it('starts from the default big preset', () => {
		expect(bookDisplay).toMatchObject({ size: 208, spacing: 20 });
	});
});
