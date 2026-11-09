import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '#lib/reader/settings.js';
import type { PdfViewState } from '#lib/reader/pdf/types.js';
import { storedTool, toolShortcut, viewSettings, viewSettingsChanged } from './pdf-view-state.js';

const state: PdfViewState = {
	page: 3, pageCount: 9, fraction: 0.25, offset: 0, layout: 'split', zoom: 1.375, scale: 1.375, rotation: 90, coverAlone: true
};
const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });

describe('viewSettings', () => {
	it('maps engine view state to persisted settings fields', () => {
		expect(viewSettings(state)).toEqual({ pdfLayout: 'split', pdfZoom: 1.375, pdfRotation: 90, pdfCoverAlone: true });
	});

	it('detects free-zoom and other engine-side changes, ignoring position and rendered scale', () => {
		const synced = { ...DEFAULT_SETTINGS, ...viewSettings(state) };
		expect(viewSettingsChanged(synced, { ...state, page: 4, fraction: 0.4, offset: 0.5, scale: 2 })).toBe(false);
		expect(viewSettingsChanged(synced, { ...state, zoom: 1.5 })).toBe(true);
		expect(viewSettingsChanged(synced, { ...state, zoom: 'auto' })).toBe(true);
		expect(viewSettingsChanged(synced, { ...state, layout: 'single' })).toBe(true);
		expect(viewSettingsChanged(synced, { ...state, rotation: 0 })).toBe(true);
		expect(viewSettingsChanged(synced, { ...state, coverAlone: false })).toBe(true);
	});
});

describe('tools', () => {
	it('restores only Hand or Select', () => {
		expect(storedTool('hand')).toBe('hand');
		for (const value of ['select', 'insert', null, 'x']) expect(storedTool(value)).toBe('select');
	});

	it('maps V/H/I without modifiers', () => {
		expect(toolShortcut(key('v'), null)).toBe('select');
		expect(toolShortcut(key('H'), null)).toBe('hand');
		expect(toolShortcut(key('i'), null)).toBe('insert');
		expect(toolShortcut(key('x'), null)).toBeNull();
		expect(toolShortcut(key('v', { ctrlKey: true }), null)).toBeNull();
		expect(toolShortcut(key('h', { metaKey: true }), null)).toBeNull();
		expect(toolShortcut(key('i', { altKey: true }), null)).toBeNull();
	});
});
