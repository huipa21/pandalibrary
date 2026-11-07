import { describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { annotationForReader, deleteAnnotation, makeHighlight, makeNote } from './annotations.js';
import { createReader, readerFormat } from './index.js';
import { fraction, progressMutation, ProgressWriter, restorePosition } from './progress.js';
import { DEFAULT_SETTINGS, loadReaderSettings, mergeBookSettings } from './settings.js';
import type { Highlight, Progress, Reader, ReaderEvents, ReaderFormat, ReaderSelection, Setting } from './types.js';

const events: ReaderEvents = {
	relocate: vi.fn(),
	selection: vi.fn(),
	activity: vi.fn(),
	keyboard: vi.fn(),
	error: vi.fn()
};

function mockReader(): Reader {
	return {
		open: vi.fn(),
		goTo: vi.fn().mockResolvedValue(undefined),
		previous: vi.fn(),
		next: vi.fn(),
		applySettings: vi.fn(),
		addAnnotation: vi.fn(),
		removeAnnotation: vi.fn(),
		destroy: vi.fn()
	};
}

const savedProgress: Progress = {
	book_file_id: 3,
	source: 'web',
	locator: { type: 'cfi', value: 'epubcfi(/6/2!/4/2)' },
	percentage: 0.6,
	device: 'reader',
	device_id: 'device',
	updated_at: '2026-11-03T00:00:00Z',
	rev: 1
};

describe('reader selection and progress', () => {
	// Cold-imports foliate-js and pdf.js, which can exceed the default timeout under full-suite load.
	it('selects the PDF adapter only for PDF and foliate for each supported book format', async () => {
		const container = {} as HTMLElement;
		for (const format of ['epub', 'mobi', 'azw3', 'fb2', 'fbz', 'cbz'] as ReaderFormat[]) {
			expect(readerFormat(format.toUpperCase())).toBe(format);
			expect((await createReader(format, container, events)).constructor.name).toBe('FoliateReader');
		}
		expect((await createReader('pdf', container, events)).constructor.name).toBe('PdfReader');
		expect(readerFormat('txt')).toBeNull();
	}, 30_000);

	it('restores a compatible locator, falling back to percentage for another file, source, type or broken locator', async () => {
		const reader = mockReader();
		expect(await restorePosition(reader, savedProgress, 3, 'epub')).toBe('locator');
		expect(reader.goTo).toHaveBeenLastCalledWith(savedProgress.locator);
		expect(await restorePosition(reader, savedProgress, 4, 'epub')).toBe('fraction');
		expect(reader.goTo).toHaveBeenLastCalledWith(0.6);
		await restorePosition(reader, { ...savedProgress, source: 'koreader' }, 3, 'epub');
		expect(reader.goTo).toHaveBeenLastCalledWith(0.6);
		await restorePosition(reader, savedProgress, 3, 'pdf');
		expect(reader.goTo).toHaveBeenLastCalledWith(0.6);
		vi.mocked(reader.goTo).mockRejectedValueOnce(new Error('outdated CFI'));
		expect(await restorePosition(reader, savedProgress, 3, 'epub')).toBe('fraction');
		expect(reader.goTo).toHaveBeenLastCalledWith(0.6);
		await restorePosition(reader, null, 3, 'pdf');
		expect(reader.goTo).toHaveBeenLastCalledWith(0);
	});

	it('creates the exact R1 progress envelope and bounds the fraction', () => {
		const locator = { type: 'pdf' as const, page: 2 };
		expect(progressMutation(2, 3, 'browser-id', { fraction: 1.4, locator }, 1234)).toEqual({
			entity: 'reading_progress',
			key: '2',
			op: 'upsert',
			data: {
				book_id: 2, book_file_id: 3, source: 'web', locator, percentage: 1,
				device: 'PandaLibrary Web', device_id: 'browser-id'
			},
			updated_at: 1234
		});
		expect(fraction(Number.NaN)).toBe(0);
		expect(fraction(-2)).toBe(0);
	});

	it('debounces progress, serializes writes, and retains the latest failed position for retry', async () => {
		vi.useFakeTimers();
		try {
			const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
			const onError = vi.fn();
			const writer = new ProgressWriter(onError, send, 1000);
			const first = progressMutation(2, 3, 'id', { fraction: 0.1, locator: { type: 'pdf', page: 1 } }, 1);
			const latest = progressMutation(2, 3, 'id', { fraction: 0.4, locator: { type: 'pdf', page: 2 } }, 2);
			writer.schedule(first);
			writer.schedule(latest);
			await vi.advanceTimersByTimeAsync(1000);
			expect(send).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledWith(latest, { keepalive: true });
			expect(onError).toHaveBeenCalledOnce();
			await writer.flush();
			expect(send).toHaveBeenCalledTimes(2);
			expect(send).toHaveBeenLastCalledWith(latest, { keepalive: true });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('reader settings and annotations', () => {
	it('merges valid format and book settings while preserving unknown book settings', () => {
		const rows: Setting[] = [
			{ key: 'reader.epub', value: { font: 'sans-serif', spacing: 1.8, future: 'keep' }, updated_at: '', rev: 1 },
			{ key: 'reader.book.7', value: { size: 130, theme: 'dark', futureOption: { value: 4 } }, updated_at: '', rev: 2 }
		];
		const result = loadReaderSettings(rows, 'epub', 7);
		expect(result.settings).toEqual({ ...DEFAULT_SETTINGS, font: 'sans-serif', spacing: 1.8, size: 130, theme: 'dark' });
		expect(result.invalid).toBe(false);
		expect(mergeBookSettings(result.bookValue, result.settings)).toMatchObject({ futureOption: { value: 4 }, size: 130 });
	});

	it('ignores invalid known settings and refuses to overwrite a non-object book setting', () => {
		const result = loadReaderSettings([
			{ key: 'reader.pdf', value: { size: 10000, theme: 'neon' }, updated_at: '', rev: 1 },
			{ key: 'reader.book.7', value: 'foreign format', updated_at: '', rev: 1 }
		], 'pdf', 7);
		expect(result.invalid).toBe(true);
		expect(result.canSave).toBe(false);
		expect(result.settings).toEqual(DEFAULT_SETTINGS);
		expect(() => mergeBookSettings({}, { ...DEFAULT_SETTINGS, spacing: 0 })).toThrow();
	});

	it('uses UUIDv7 and validates the server byte limits for highlights and notes', () => {
		const selection: ReaderSelection = {
			text: 'A selected passage',
			fraction: 0.25,
			locator: { type: 'cfi', value: 'epubcfi(/6/2!/4/2)' }
		};
		const highlight = makeHighlight(7, 3, selection, 'blue');
		expect(highlight).toMatchObject({
			entity: 'highlights',
			op: 'upsert',
			data: { book_id: 7, book_file_id: 3, text: selection.text, position: 0.25, color: 'blue' }
		});
		expect('id' in highlight && highlight.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const note = makeNote(7, '**Markdown**', 'highlight');
		expect(note).toMatchObject({ entity: 'notes', data: { book_id: 7, highlight_id: 'highlight', body_md: '**Markdown**' } });
		expect(() => makeNote(7, '中'.repeat(21846), null)).toThrow();
		expect(() => makeHighlight(7, 3, { ...selection, text: '中'.repeat(11000) }, 'yellow')).toThrow();
		expect(deleteAnnotation('notes', 'id')).toMatchObject({ entity: 'notes', id: 'id', op: 'delete', data: {} });
	});

	it('renders only compatible highlights for the selected file', () => {
		const highlight: Highlight = {
			id: 'one', book_id: 7, book_file_id: 3,
			locator: { type: 'pdf', page: 2, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] },
			position: 0.5, text: 'text', color: 'blue', chapter: null,
			created_at: '', updated_at: '', deleted_at: null, rev: 1
		};
		expect(annotationForReader(highlight, 3, 'pdf')).toMatchObject({ id: 'one', color: 'blue' });
		expect(annotationForReader(highlight, 4, 'pdf')).toBeNull();
		expect(annotationForReader(highlight, 3, 'epub')).toBeNull();
	});

	it('defines the same reader translations in English and Chinese', () => {
		const english = Object.keys(en).filter((key) => key.startsWith('reader.')).sort();
		const chinese = Object.keys(zh).filter((key) => key.startsWith('reader.')).sort();
		expect(english.length).toBeGreaterThan(50);
		expect(chinese).toEqual(english);
	});
});
