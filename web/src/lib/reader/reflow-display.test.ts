import { describe, expect, it } from 'vitest';
import { REFLOW_PAGE, reflowLayout, reflowScale, reflowZoom, stepReflowZoom } from './reflow-display.js';
import { DEFAULT_SETTINGS, isReaderSettings, loadReaderSettings, mergeBookSettings } from './settings.js';
import type { PdfLayout, Setting } from './types.js';

describe('non-PDF display settings', () => {
	it('migrates legacy flow and image magnification without coupling text zoom to typography', () => {
		expect(reflowLayout(DEFAULT_SETTINGS)).toBe('single');
		expect(reflowLayout({ ...DEFAULT_SETTINGS, flow: 'scrolled' })).toBe('single-continuous');
		expect(reflowZoom({ ...DEFAULT_SETTINGS, size: 150 })).toBe('auto');
		expect(reflowZoom({ ...DEFAULT_SETTINGS, size: 150 }, true)).toBe(1.5);
		expect(reflowLayout({ ...DEFAULT_SETTINGS, flow: 'scrolled', reflowLayout: 'split' })).toBe('split');
		expect(reflowZoom({ ...DEFAULT_SETTINGS, size: 150, reflowZoom: 'page-actual' }, true)).toBe('page-actual');
	});

	it('round trips independent zoom/layout and unknown settings through format/book precedence', () => {
		const settings: Setting[] = [
			{ key: 'reader.epub', value: { reflowLayout: 'split', reflowZoom: 'page-fit' }, updated_at: '', rev: 1 },
			{ key: 'reader.book.7', value: { reflowZoom: 1.75, future: true }, updated_at: '', rev: 1 }
		];
		const loaded = loadReaderSettings(settings, 'epub', 7);
		expect(loaded.invalid).toBe(false);
		expect(loaded.settings).toMatchObject({ reflowLayout: 'split', reflowZoom: 1.75, size: 100, pdfZoom: 'page-width' });
		expect(mergeBookSettings(loaded.bookValue, loaded.settings)).toMatchObject({
			reflowLayout: 'split', reflowZoom: 1.75, future: true
		});
	});

	it('rejects unsupported layouts and non-finite/out-of-range magnification without losing valid settings', () => {
		for (const reflowZoom of [0, 5.1, 'fit-width', null]) {
			const loaded = loadReaderSettings([
				{ key: 'reader.book.7', value: { reflowZoom, reflowLayout: 'columns', size: 140 }, updated_at: '', rev: 1 }
			], 'cbz', 7);
			expect(loaded.invalid).toBe(true);
			expect(loaded.settings.size).toBe(140);
			expect(loaded.settings.reflowZoom).toBeUndefined();
			expect(loaded.settings.reflowLayout).toBeUndefined();
		}
		expect(isReaderSettings({ ...DEFAULT_SETTINGS, reflowZoom: Number.NaN })).toBe(false);
	});
});

describe('non-PDF magnification', () => {
	for (const layout of ['single', 'single-continuous', 'split', 'split-continuous'] as PdfLayout[]) {
		it(`fits the actual ${layout} surface and keeps numeric/actual-size modes independent of viewport`, () => {
			const columns = layout.startsWith('split') ? 2 : 1;
			expect(reflowScale('page-actual', layout, 360, 480)).toBe(1);
			expect(reflowScale(1.75, layout, 360, 480)).toBe(1.75);
			expect(reflowScale('page-width', layout, 1440, 480)).toBe(2 / columns);
			expect(reflowScale('page-fit', layout, 1440, 480)).toBe(0.5);
			expect(reflowScale('auto', layout, 14400, 9600)).toBe(1.25);
			expect(reflowScale('page-fit', layout, 360, 480, { width: 360, height: 480 })).toBe(1 / columns);
		});
	}

	it('steps from the resolved fit scale and clamps at the shared zoom limits', () => {
		expect(stepReflowZoom(reflowScale('page-fit', 'single', REFLOW_PAGE.width / 2, REFLOW_PAGE.height / 2), 1)).toBe(0.6);
		expect(stepReflowZoom(0.1, -1)).toBe(0.1);
		expect(stepReflowZoom(5, 1)).toBe(5);
	});
});
