import { describe, expect, it } from 'vitest';
import type { JsonValue } from '#lib/api/client.js';
import { pdfPageAtFraction, pdfPageFraction, rotatePdfRect } from './pdf-layout.js';
import { DEFAULT_SETTINGS, isReaderSettings, loadReaderSettings, mergeBookSettings } from './settings.js';

describe('PDF view geometry and progress', () => {
	it('round-trips every page fraction including 10.05%, endpoints and single-page files', () => {
		for (const pages of [1, 2, 5, 200, 2001]) {
			for (let page = 1; page <= pages; page++) {
				expect(pdfPageAtFraction(pdfPageFraction(page, pages), pages)).toBe(page);
			}
		}
		expect((pdfPageFraction(21, 200) * 100).toFixed(2)).toBe('10.05');
		expect(pdfPageAtFraction(0.1005, 200)).toBe(21);
		expect(pdfPageAtFraction(-1, 200)).toBe(1);
		expect(pdfPageAtFraction(2, 200)).toBe(200);
	});

	it('rotates canonical highlight rectangles and reverses the selection transform', () => {
		const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
		expect(rotatePdfRect(rect, 90)).toEqual({ x: 0.75, y: 0.1, width: 0.05, height: 0.3 });
		for (const rotation of [0, 90, 180, 270, -90]) {
			const restored = rotatePdfRect(rotatePdfRect(rect, rotation), -rotation);
			for (const key of ['x', 'y', 'width', 'height'] as const) expect(restored[key]).toBeCloseTo(rect[key]);
		}
		expect(rotatePdfRect({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, 180).x).toBe(0);
	});
});

describe('PDF view settings', () => {
	it('loads and persists all layouts, presets and arbitrary scales with book overrides', () => {
		for (const pdfLayout of ['single', 'single-continuous', 'split', 'split-continuous'] as const) {
			for (const pdfZoom of ['auto', 'page-width', 'page-fit', 'page-actual', 0.1, 1.375, 5] as const) {
				const settings = { ...DEFAULT_SETTINGS, pdfLayout, pdfZoom, pdfRotation: 270 as const, pdfCoverAlone: true };
				expect(isReaderSettings(settings)).toBe(true);
				const saved = mergeBookSettings({ future: true }, settings);
				const loaded = loadReaderSettings([
					{ key: 'reader.pdf', value: { pdfZoom: 'page-width' }, updated_at: '', rev: 1 },
					{ key: 'reader.book.7', value: saved, updated_at: '', rev: 1 }
				], 'pdf', 7);
				expect(loaded.invalid).toBe(false);
				expect(loaded.settings).toEqual(settings);
				expect(loaded.bookValue.future).toBe(true);
			}
		}
	});

	it('rejects invalid PDF settings explicitly without losing valid settings', () => {
		const invalidSettings: Record<string, JsonValue>[] = [
			{ pdfLayout: 'unknown' }, { pdfZoom: 0 }, { pdfZoom: 5.01 }, { pdfZoom: Number.NaN },
			{ pdfZoom: 'custom' }, { pdfRotation: 45 }, { pdfCoverAlone: 'true' }
		];
		for (const invalid of invalidSettings) {
			expect(isReaderSettings({ ...DEFAULT_SETTINGS, ...invalid } as typeof DEFAULT_SETTINGS)).toBe(false);
			const loaded = loadReaderSettings([
				{ key: 'reader.pdf', value: { ...invalid, theme: 'dark' }, updated_at: '', rev: 1 }
			], 'pdf', 7);
			expect(loaded.invalid).toBe(true);
			expect(loaded.settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
		}
	});
});
