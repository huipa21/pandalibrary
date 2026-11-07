import { afterEach, describe, expect, it, vi } from 'vitest';
import { coverCloth, formatTone, preferredFormat, sortedFormats, titleScale, truncateTitle } from './cover.js';

afterEach(() => vi.restoreAllMocks());

describe('cover helpers', () => {
	it('chooses deterministic cloth palettes across book IDs 1-1000', () => {
		const palettes = Array.from({ length: 1000 }, (_, index) => coverCloth(index + 1));
		expect(new Map(palettes.map(({ name, board }) => [name, board]))).toEqual(new Map([
			['navy', '#1f2f5c'], ['forest', '#24462a'], ['ochre', '#cbb153'],
			['khaki', '#c6b18f'], ['rust', '#8b3a17'], ['taupe', '#c7b495'],
			['burgundy', '#5e1f2a'], ['slate-teal', '#24494d']
		]));
		for (const palette of palettes) {
			expect(palette.plate).toBe('#f3eedf');
			expect(palette.author).toBe(
				['ochre', 'khaki', 'taupe'].includes(palette.name) ? '#120c06' : '#d9b768'
			);
			expect(palette).toHaveProperty('spine');
			expect(palette).toHaveProperty('frame');
			expect(palette).toHaveProperty('plateRule');
			expect(palette).toHaveProperty('ink');
		}
		expect(coverCloth(42)).toEqual(coverCloth(42));
		expect(coverCloth(-42)).toEqual(coverCloth(-42));
	});

	it('scales titles at grapheme boundaries for Latin, CJK, and combined emoji', () => {
		for (const [length, expected] of [[0, 'xl'], [6, 'xl'], [7, 'lg'], [14, 'lg'], [15, 'md'], [32, 'md'], [33, 'sm']] as const) {
			expect(titleScale('a'.repeat(length))).toBe(expected);
		}
		expect(titleScale('猫'.repeat(6))).toBe('xl');
		expect(titleScale('猫'.repeat(15))).toBe('md');
		expect(titleScale('👩🏽‍🚀'.repeat(6))).toBe('xl');
		expect(titleScale('👩🏽‍🚀'.repeat(7))).toBe('lg');
		expect(titleScale('e\u0301'.repeat(33))).toBe('sm');
	});

	it('limits titles by graphemes, including CJK and combined emoji', () => {
		expect(truncateTitle('猫')).toBe('猫');
		expect(truncateTitle('中文标题很长', 4)).toBe('中文标…');
		expect(truncateTitle('👩🏽‍🚀e\u0301🐼🌲', 3)).toBe('👩🏽‍🚀e\u0301…');
		expect(truncateTitle('abc', 1)).toBe('…');
		expect(truncateTitle('abc', 0)).toBe('');
		expect(truncateTitle('a'.repeat(81))).toBe(`${'a'.repeat(79)}…`);
		expect(() => truncateTitle('a', -1)).toThrow(RangeError);
	});

	it('falls back to code points when Intl.Segmenter is unavailable', () => {
		const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
		Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
		try {
			expect(truncateTitle('🐼猫书', 2)).toBe('🐼…');
			expect(titleScale('🐼'.repeat(7))).toBe('lg');
		} finally {
			if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
		}
	});

	it('deduplicates and sorts formats without mutating files', () => {
		const files = ['mobi', 'PDF', 'epub', 'EPUB', 'zip', 'cbz', 'azw3', 'fbz', 'fb2', 'abc', '']
			.map((format) => ({ format }));
		expect(sortedFormats(files)).toEqual(['epub', 'pdf', 'cbz', 'azw3', 'mobi', 'fb2', 'fbz', 'abc', 'zip']);
		expect(files[0].format).toBe('mobi');
		expect(preferredFormat(files)).toBe('epub');
		expect(preferredFormat([])).toBeNull();
		expect(sortedFormats([])).toEqual([]);
	});

	it('assigns the specified badge tones, including unknown formats', () => {
		expect(formatTone('EPUB')).toContain('emerald');
		expect(formatTone('pdf')).toContain('red');
		expect(formatTone('cbz')).toContain('amber');
		expect(formatTone('azw3')).toBe(formatTone('mobi'));
		expect(formatTone('fb2')).toBe(formatTone('fbz'));
		expect(formatTone('unknown')).toContain('slate');
	});
});
