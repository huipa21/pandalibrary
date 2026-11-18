import { describe, expect, it } from 'vitest';
import { BOOK_DISPLAY_PRESETS, bookDisplay, nextBookDisplayPresetId } from './book-display.svelte.js';

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

	it('cycles through every preset and wraps around', () => {
		expect(nextBookDisplayPresetId(120)).toBe('medium');
		expect(nextBookDisplayPresetId(160)).toBe('big');
		expect(nextBookDisplayPresetId(208)).toBe('large');
		expect(nextBookDisplayPresetId(240)).toBe('small');
	});

	it('moves custom appearance sizes to the next larger preset', () => {
		expect(nextBookDisplayPresetId(200)).toBe('big');
		expect(nextBookDisplayPresetId(100)).toBe('small');
		expect(nextBookDisplayPresetId(260)).toBe('small');
	});
});
