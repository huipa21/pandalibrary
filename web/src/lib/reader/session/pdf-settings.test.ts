import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.js';
import { initialPdfSettings, pdfSettingsForScope } from './pdf-settings.js';

describe('PDF settings scopes', () => {
	it('preserves unknown JSON and keeps rotation and numeric zoom per book', () => {
		const original = { future: { keep: true }, pdfZoom: 'page-fit' };
		const settings = { ...DEFAULT_SETTINGS, pdfZoom: 1.75, pdfRotation: 90 as const };
		expect(pdfSettingsForScope(original, settings, 'book')).toMatchObject({ future: { keep: true }, pdfZoom: 1.75, pdfRotation: 90 });
		const format = pdfSettingsForScope(original, settings, 'format');
		expect(format).toMatchObject({ future: { keep: true }, pdfZoom: 'page-fit' });
		expect(format).not.toHaveProperty('pdfRotation');
		expect(pdfSettingsForScope({}, settings, 'format')).not.toHaveProperty('pdfZoom');
		expect(pdfSettingsForScope({ font: 'sans-serif', size: 125 }, settings, 'book')).toMatchObject({ font: 'sans-serif', size: 125 });
		expect(pdfSettingsForScope({}, settings, 'book')).not.toHaveProperty('font');
	});
	it('saves preset defaults but never format rotation', () => {
		const format = pdfSettingsForScope({ future: true }, { ...DEFAULT_SETTINGS, pdfZoom: 'auto', pdfRotation: 180 }, 'format');
		expect(format).toMatchObject({ future: true, pdfZoom: 'auto', theme: 'light' });
		expect(format).not.toHaveProperty('pdfRotation');
	});
	it('uses continuous/auto defaults and migrates legacy per-book size only when zoom is absent', () => {
		expect(initialPdfSettings(DEFAULT_SETTINGS, {}, undefined)).toMatchObject({ pdfLayout: 'single-continuous', pdfZoom: 'auto' });
		expect(initialPdfSettings(DEFAULT_SETTINGS, { size: 150 }, undefined).pdfZoom).toBe(1.5);
		expect(initialPdfSettings({ ...DEFAULT_SETTINGS, pdfZoom: 'page-fit' }, { size: 150, pdfZoom: 'page-fit' }, {}).pdfZoom).toBe('page-fit');
		expect(initialPdfSettings({ ...DEFAULT_SETTINGS, pdfLayout: 'split', pdfZoom: 'page-fit', pdfRotation: 90 }, {}, { pdfLayout: 'split', pdfZoom: 'page-fit', pdfRotation: 90 })).toMatchObject({ pdfLayout: 'split', pdfZoom: 'page-fit', pdfRotation: 0 });
	});
});
