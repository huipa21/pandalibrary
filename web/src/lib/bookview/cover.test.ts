import { afterEach, describe, expect, it, vi } from 'vitest';
import { coverTone, formatTone, preferredFormat, sortedFormats, truncateTitle } from './cover.js';

afterEach(() => vi.restoreAllMocks());

describe('cover helpers', () => {
	it('chooses a deterministic muted tone from all eight palettes', () => {
		const tones = new Set(Array.from({ length: 256 }, (_, id) => coverTone(id).bg));
		expect(tones.size).toBe(8);
		expect(coverTone(42)).toEqual(coverTone(42));
		expect(coverTone(-42)).toHaveProperty('spine');
		expect(coverTone(42)).toHaveProperty('text');
		expect(coverTone(42)).toHaveProperty('accent');
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
