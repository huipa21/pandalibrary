import { describe, expect, it } from 'vitest';
import type { JsonValue } from '#lib/api/client.js';
import { DEFAULT_SETTINGS, isReaderSettings, loadReaderSettings, mergeBookSettings } from '../settings.js';
import { clampRect, fromRotated, mergeLineRects, pointFromRotated, pointToRotated, toRotated } from './geometry.js';
import { layoutFromModes, layoutModes, spreadStart } from './layout.js';
import { formatPercent, fromFraction, toFraction } from './progress.js';
import { isPdfViewLocator } from './types.js';
import { pdfViewStatePatch, readPdfViewState } from './view-state.js';
import { clampScale, nextScale, presetValue, wheelFactor, ZOOM_STEPS } from './zoom.js';

describe('PDF progress (decision 6)', () => {
	it('round-trips page and offset, saturating the last page', () => {
		for (const pages of [2, 5, 200, 2001]) {
			for (let page = 1; page <= pages; page += Math.ceil(pages / 37)) {
				for (const offset of [0, 0.25, 0.5, 0.999]) {
					const back = fromFraction(toFraction(page, offset, pages), pages);
					if (page === pages) expect(back).toEqual({ page: pages, offset: 0 });
					else {
						expect(back.page).toBe(page);
						expect(back.offset).toBeCloseTo(offset, 6);
					}
				}
			}
		}
		expect(toFraction(200, 0, 200)).toBe(1);
		expect(fromFraction(1, 200)).toEqual({ page: 200, offset: 0 });
		expect(fromFraction(-1, 200)).toEqual({ page: 1, offset: 0 });
		expect(fromFraction(Number.NaN, 200)).toEqual({ page: 1, offset: 0 });
	});

	it('uses the offset alone for single-page files', () => {
		expect(toFraction(1, 0.4, 1)).toBe(0.4);
		expect(fromFraction(0.4, 1)).toEqual({ page: 1, offset: 0.4 });
	});

	it('formats two decimals, including 10.05%', () => {
		expect(formatPercent(toFraction(21, 0, 200), 'en')).toBe('10.05%');
		expect(formatPercent(1, 'en')).toBe('100.00%');
		expect(formatPercent(-3, 'en')).toBe('0.00%');
	});

	it('accepts view locators with offsets in [0, 1)', () => {
		expect(isPdfViewLocator({ type: 'pdf', page: 3 })).toBe(true);
		expect(isPdfViewLocator({ type: 'pdf', page: 3, offset: 0.5 })).toBe(true);
		for (const offset of [1, -0.1, Number.NaN, '0.5']) expect(isPdfViewLocator({ type: 'pdf', page: 3, offset } as JsonValue)).toBe(false);
		expect(isPdfViewLocator({ type: 'pdf', page: 0 })).toBe(false);
	});
});

describe('PDF geometry', () => {
	const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };

	it('rotates clockwise and inverts exactly', () => {
		expect(toRotated(rect, 90)).toEqual({ x: expect.closeTo(0.75), y: expect.closeTo(0.1), width: expect.closeTo(0.05), height: expect.closeTo(0.3) });
		for (const rotation of [0, 90, 180, 270, -90]) {
			const restored = fromRotated(toRotated(rect, rotation), rotation);
			for (const key of ['x', 'y', 'width', 'height'] as const) expect(restored[key]).toBeCloseTo(rect[key]);
			const point = pointFromRotated(pointToRotated({ x: 0.2, y: 0.7 }, rotation), rotation);
			expect(point.x).toBeCloseTo(0.2);
			expect(point.y).toBeCloseTo(0.7);
		}
		expect(toRotated({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, 180).x).toBeCloseTo(0);
	});

	it('clamps rects to the page and merges same-line fragments', () => {
		expect(clampRect({ x: -0.1, y: 0.95, width: 0.5, height: 0.2 })).toEqual({ x: 0, y: 0.95, width: 0.5, height: expect.closeTo(0.05) });
		const merged = mergeLineRects([
			{ x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
			{ x: 0.2, y: 0.101, width: 0.1, height: 0.02 },
			{ x: 0.1, y: 0.2, width: 0.1, height: 0.02 }
		]);
		expect(merged).toHaveLength(2);
		expect(merged[0].width).toBeCloseTo(0.2);
	});
});

describe('PDF layout modes', () => {
	it('maps the four layouts and cover-alone to pdf.js modes and back', () => {
		for (const layout of ['single', 'single-continuous', 'split', 'split-continuous'] as const) {
			for (const coverAlone of [false, true]) {
				const { scrollMode, spreadMode } = layoutModes(layout, coverAlone);
				const back = layoutFromModes(scrollMode, spreadMode);
				expect(back.layout).toBe(layout);
				expect(back.coverAlone).toBe(layout.startsWith('split') && coverAlone);
			}
		}
		expect(layoutModes('single-continuous')).toEqual({ scrollMode: 0, spreadMode: 0 });
		expect(layoutModes('split', true)).toEqual({ scrollMode: 3, spreadMode: 2 });
	});

	it('finds spread starts like pdf.js spreads', () => {
		expect([1, 2, 3, 4, 5].map((page) => spreadStart(page, 'split', false))).toEqual([1, 1, 3, 3, 5]);
		expect([1, 2, 3, 4, 5].map((page) => spreadStart(page, 'split-continuous', true))).toEqual([1, 2, 2, 4, 4]);
		expect(spreadStart(4, 'single', true)).toBe(4);
	});
});

describe('PDF zoom', () => {
	it('steps along the ladder and clamps', () => {
		expect(ZOOM_STEPS[0]).toBe(0.25);
		expect(nextScale(1, 1)).toBe(1.1);
		expect(nextScale(1, -1)).toBe(0.9);
		expect(nextScale(1.05, 1)).toBe(1.1);
		expect(nextScale(1.05, -1)).toBe(1);
		expect(nextScale(5, 1)).toBe(5);
		expect(nextScale(0.25, -1)).toBe(0.25);
		expect(clampScale(9)).toBe(5);
		expect(clampScale(0.01)).toBe(0.25);
		expect(presetValue('page-fit')).toBe('page-fit');
		expect(presetValue(1.5)).toBe('1.5');
	});

	it('normalizes wheel delta modes and caps each event', () => {
		expect(wheelFactor(16, 0)).toBeCloseTo(wheelFactor(1, 1));
		expect(wheelFactor(800, 0)).toBe(wheelFactor(1, 2));
		expect(wheelFactor(0, 0)).toBe(1);
		expect(wheelFactor(10, 0)).toBeLessThan(1);
		expect(wheelFactor(-10, 0)).toBeGreaterThan(1);
		expect(wheelFactor(10000, 0)).toBe(0.8);
		expect(wheelFactor(-10000, 0)).toBe(1.25);
	});
});

describe('PDF view settings', () => {
	it('reads merged settings with continuous/automatic defaults and patches them back', () => {
		expect(readPdfViewState({})).toEqual({ layout: 'single-continuous', zoom: 'auto', rotation: 0, coverAlone: false });
		const view = readPdfViewState({ pdfLayout: 'split', pdfZoom: 1.5, pdfRotation: 270, pdfCoverAlone: true });
		expect(pdfViewStatePatch(view)).toEqual({ pdfLayout: 'split', pdfZoom: 1.5, pdfRotation: 270, pdfCoverAlone: true });
	});

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
