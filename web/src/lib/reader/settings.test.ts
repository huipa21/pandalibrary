import { describe, expect, it } from 'vitest';
import type { JsonValue } from '#lib/api/client.js';
import { BACKGROUNDS, backgroundFor, withBackground } from './appearance.js';
import { DEFAULT_SETTINGS, isReaderSettings, loadReaderSettings, mergeBookSettings } from './settings.js';
import type { ReaderSettings, Setting } from './types.js';
import { layoutModes } from './pdf/layout.js';
import { readPdfViewState } from './pdf/view-state.js';

function setting(key: string, value: JsonValue): Setting {
	return { key, value, updated_at: '', rev: 1 };
}

describe('reader background settings', () => {
	it('ignores retired cover-alone values, preserving them as unknown keys on save', () => {
		for (const pdfCoverAlone of [true, false, 'retired', null]) {
			const loaded = loadReaderSettings([
				setting('reader.book.7', { pdfLayout: 'split', pdfCoverAlone })
			], 'pdf', 7);
			expect(loaded.invalid).toBe(false);
			expect(loaded.settings).not.toHaveProperty('pdfCoverAlone');
			expect(layoutModes(readPdfViewState(loaded.settings).layout).spreadMode).toBe(1);
			expect(mergeBookSettings(loaded.bookValue, loaded.settings)).toMatchObject({ pdfCoverAlone });
		}
	});
	it('round trips each preset and preserves unknown settings', () => {
		for (const preset of BACKGROUNDS) {
			const initial = loadReaderSettings([
				setting('reader.epub', { font: 'system', background: 'cream', theme: 'sepia' }),
				setting('reader.book.7', { futureOption: { value: 4 } })
			], 'epub', 7);
			expect(initial.invalid).toBe(false);
			expect(backgroundFor(initial.settings).id).toBe('cream');
			const updated = withBackground(initial.settings, preset.id);
			const saved = mergeBookSettings(initial.bookValue, updated);
			expect(saved).toMatchObject({ futureOption: { value: 4 }, background: preset.id, theme: updated.theme });
			const loaded = loadReaderSettings([
				setting('reader.epub', { background: 'cream', theme: 'sepia' }),
				setting('reader.book.7', saved)
			], 'epub', 7);
			expect(loaded.invalid).toBe(false);
			expect(loaded.canSave).toBe(true);
			expect(loaded.settings).toEqual(updated);
			expect(backgroundFor(loaded.settings).id).toBe(preset.id);
		}
	});

	it('marks invalid format and book backgrounds invalid without applying them', () => {
		for (const invalid of ['unknown', '', 'WHITE', null, false, 12, [], {}]) {
			const format = loadReaderSettings([
				setting('reader.pdf', { background: invalid, theme: 'dark' })
			], 'pdf', 7);
			expect(format.invalid).toBe(true);
			expect(format.settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
			expect(backgroundFor(format.settings).id).toBe('night');

			const book = loadReaderSettings([
				setting('reader.pdf', { background: 'cream', theme: 'sepia' }),
				setting('reader.book.7', { background: invalid, future: true })
			], 'pdf', 7);
			expect(book.invalid).toBe(true);
			expect(book.canSave).toBe(true);
			expect(book.settings.background).toBe('cream');
			expect(book.bookValue.future).toBe(true);

			const malformed = JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, background: invalid })) as ReaderSettings;
			expect(isReaderSettings(malformed)).toBe(false);
			expect(() => mergeBookSettings({}, malformed)).toThrow('Invalid reader settings.');
		}
	});

	it('keeps legacy theme-only settings without adding a background', () => {
		const loaded = loadReaderSettings([
			setting('reader.pdf', { theme: 'dark' }),
			setting('reader.book.7', { future: 'keep' })
		], 'pdf', 7);
		expect(loaded.invalid).toBe(false);
		expect(loaded.settings).not.toHaveProperty('background');
		expect(backgroundFor(loaded.settings).id).toBe('night');
		expect(mergeBookSettings(loaded.bookValue, loaded.settings)).toMatchObject({ future: 'keep', theme: 'dark' });
	});
});
