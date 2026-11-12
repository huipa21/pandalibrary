import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import { getBook } from '#lib/catalog/api.js';
import { downloadBookFile, getBookState, getSettings } from '../api.js';
import { createReader } from '../index.js';
import { offlineAvailable, offlineStatus, saveMutation } from '#lib/sync/client.js';
import { readerState } from '#lib/sync/state.js';
import type { Book } from '#lib/catalog/types.js';
import type { BookState, PageAnnotationInput, ReaderEvents } from '../types.js';
import { createReaderController } from './reader-controller.svelte.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/catalog/api.js', () => ({ getBook: vi.fn() }));
vi.mock('../api.js', async (original) => ({
	...await original<typeof import('../api.js')>(),
	deviceId: () => 'test-device',
	downloadBookFile: vi.fn(),
	getBookState: vi.fn(),
	getSettings: vi.fn()
}));
vi.mock('../index.js', async () => ({
	createReader: vi.fn(),
	readerFormat: (await import('../types.js')).readerFormat
}));
vi.mock('#lib/sync/client.js', () => ({
	currentAccount: () => 1,
	offlineAvailable: vi.fn(() => false),
	offlineStatus: writable({ online: true, error: false, pending: 0, syncing: false }),
	readerOpened: () => () => {},
	saveMutation: vi.fn(),
	syncNow: vi.fn(),
	DurableProgressWriter: class {
		schedule() {}
		async flush() {}
	}
}));
vi.mock('#lib/sync/state.js', () => ({ readerState: vi.fn() }));

const book: Book = {
	id: 21, library_id: 1, title: 'PDF', sort_title: 'PDF', subtitle: null, description: null,
	language: 'en', publisher: null, published_date: null, page_count: null, cover_url: null,
	cover_source: null, authors: [], series: null, tags: [], identifiers: [], field_sources: [],
	files: [{ id: 31, format: 'pdf', size_bytes: 0, download_url: '/file', original_filename: 'book.pdf', created_at: '' }],
	created_at: '', updated_at: ''
};
const input: PageAnnotationInput = {
	kind: 'text', locator: { type: 'pdf', page: 1, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
	position: 0, data: { text: 'Note', color: '#112233', size: 0.02 }
};
const empty: BookState = { user_book: null, progress: null, highlights: [], notes: [], bookmarks: [], page_annotations: [] };
const params = () => ({ bookId: '21', fileId: '31', bookmarkId: null, highlightId: null });

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getBook).mockResolvedValue(book);
	vi.mocked(getBookState).mockResolvedValue(empty);
	vi.mocked(getSettings).mockResolvedValue([]);
	vi.mocked(downloadBookFile).mockResolvedValue(new Blob());
	vi.mocked(saveMutation).mockResolvedValue('applied');
	vi.mocked(offlineAvailable).mockReturnValue(false);
	offlineStatus.set({ account: 1, available: true, online: true, pending: 0, issues: 0, syncing: false, error: false });
});

afterEach(() => vi.unstubAllGlobals());

describe('reader controller PDF extensions', () => {
	it('composes the panel draft guard with the active tool guard', async () => {
		const controller = createReaderController(params);
		const cancel = vi.fn();
		controller.setDraftGuard(() => false);
		const guard = vi.fn(() => true);
		const unregister = controller.registerDraftGuard(guard);
		controller.beforeNavigate({ cancel });
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(guard).not.toHaveBeenCalled();
		controller.setDraftGuard(() => true);
		guard.mockReturnValue(false);
		controller.beforeNavigate({ cancel });
		expect(cancel).toHaveBeenCalledTimes(2);
		unregister();
		controller.beforeNavigate({ cancel });
		expect(cancel).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	it('restores deleted marks with comments, bookmarks, notes and inserts through the outbox writer', async () => {
		let events: ReaderEvents;
		vi.mocked(createReader).mockImplementation(async (_format, _surface, next) => {
			events = next;
			return {
				open: vi.fn(), applySettings: vi.fn(), addAnnotation: vi.fn(), removeAnnotation: vi.fn(),
				destroy: vi.fn(async () => {}), previous: vi.fn(), next: vi.fn(),
				goTo: vi.fn(async () => events.relocate({ fraction: 0, locator: { type: 'pdf', page: 1 } }))
			};
		});
		const controller = createReaderController(params);
		await controller.retry();
		vi.stubGlobal('document', { hidden: true });
		const confirm = vi.fn(() => true);
		vi.stubGlobal('window', { confirm });
		await controller.attach({} as HTMLElement);
		await controller.addHighlight({ text: 'Mark', fraction: 0, locator: { type: 'pdf', page: 1 } }, 'green', 'strikeout');
		const mark = controller.highlights[0];
		await controller.saveNote({ id: 'comment', highlightId: mark.id, body: 'Comment', original: '', editing: false });
		const attached = controller.notes[0];
		expect(await controller.removeHighlight(mark)).toBe(true);
		expect(controller.notes).toEqual([]);
		expect(await controller.restoreDeletedAnnotation({ kind: 'mark', row: mark, notes: [attached] })).toBe(true);
		expect(controller.highlights[0]).toMatchObject({ id: mark.id, style: 'strikeout', color: 'green' });
		expect(controller.notes).toEqual([attached]);
		await controller.addBookmark({ label: 'Bookmark' });
		const bookmark = controller.bookmarks[0];
		expect(await controller.jumpToBookmark(bookmark)).toBe(true);
		await controller.removeBookmark(bookmark);
		expect(await controller.restoreDeletedAnnotation({ kind: 'bookmark', row: bookmark })).toBe(true);
		expect(controller.bookmarks).toEqual([bookmark]);
		confirm.mockClear();
		confirm.mockReturnValue(false);
		expect(await controller.removeBookmark(bookmark)).toBeUndefined();
		expect(controller.bookmarks).toEqual([bookmark]);
		expect(confirm).toHaveBeenCalledTimes(1);
		confirm.mockClear();
		expect(await controller.removeBookmark(bookmark, { confirm: false })).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
		expect(controller.bookmarks).toEqual([]);
		expect(await controller.restoreDeletedAnnotation({ kind: 'bookmark', row: bookmark })).toBe(true);
		confirm.mockReturnValue(true);
		await controller.deleteNote(attached);
		expect(await controller.restoreDeletedAnnotation({ kind: 'note', row: attached })).toBe(true);
		expect(controller.notes).toEqual([attached]);
		await controller.addPageAnnotation(input);
		const insert = controller.pageAnnotations[0];
		await controller.removePageAnnotation(insert);
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(saveMutation).mockRejectedValueOnce(new Error('Restore failed'));
		expect(await controller.restoreDeletedAnnotation({ kind: 'insert', row: insert })).toBe(false);
		expect(controller.pageAnnotations).toEqual([]);
		expect(controller.actionError).not.toBe('');
		expect(await controller.restoreDeletedAnnotation({ kind: 'insert', row: insert })).toBe(true);
		expect(controller.pageAnnotations).toEqual([insert]);
		expect(await controller.restoreDeletedAnnotation({ kind: 'insert', row: { ...insert, book_file_id: 32 } })).toBe(false);
		log.mockRestore();
		controller.dispose();
	});
	it('optimistically adds page annotations and rolls back failed writes', async () => {
		const controller = createReaderController(params);
		await controller.retry();
		let reject!: (error: Error) => void;
		vi.mocked(saveMutation).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
		const pending = controller.addPageAnnotation(input);
		expect(controller.pageAnnotations).toHaveLength(1);
		expect(controller.pageAnnotations[0]).toMatchObject({ ...input, book_id: 21, book_file_id: 31 });
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		reject(new Error('Rejected write'));
		expect(await pending).toBe(false);
		expect(controller.pageAnnotations).toEqual([]);
		expect(controller.actionError).not.toBe('');
		log.mockRestore();
		controller.dispose();
	});

	it('updates and deletes annotations with rollback, and rejects kind changes', async () => {
		const controller = createReaderController(params);
		await controller.retry();
		expect(await controller.addPageAnnotation(input)).toBe(true);
		const row = controller.pageAnnotations[0];
		expect(await controller.updatePageAnnotation(row, { data: { ...input.data, text: 'Edited' } })).toBe(true);
		const edited = controller.pageAnnotations[0];
		expect(edited.data).toMatchObject({ text: 'Edited' });
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(saveMutation).mockRejectedValueOnce(new Error('Rejected update'));
		expect(await controller.updatePageAnnotation(edited, { position: 0.5 })).toBe(false);
		expect(controller.pageAnnotations).toEqual([edited]);
		vi.mocked(saveMutation).mockRejectedValueOnce(new Error('Rejected delete'));
		expect(await controller.removePageAnnotation(edited)).toBe(false);
		expect(controller.pageAnnotations).toEqual([edited]);
		expect(await controller.updatePageAnnotation(edited, { kind: 'ink' })).toBe(false);
		expect(controller.pageAnnotations).toEqual([edited]);
		log.mockRestore();
		expect(await controller.removePageAnnotation(edited)).toBe(true);
		expect(controller.pageAnnotations).toEqual([]);
		expect(await controller.restorePageAnnotation(edited)).toBe(true);
		expect(controller.pageAnnotations[0]).toMatchObject({ id: edited.id, created_at: edited.created_at, deleted_at: null });
		expect(saveMutation).toHaveBeenLastCalledWith(expect.objectContaining({ id: edited.id, op: 'upsert', entity: 'page_annotations' }));
		controller.dispose();
	});

	it('reports a settings failure without discarding the view or unknown fields', async () => {
		const controller = createReaderController(params);
		await controller.retry();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(saveMutation).mockRejectedValueOnce(new Error('Settings rejected'));
		expect(await controller.saveSettings({ pdfLayout: 'split' }, { scope: 'both' })).toBe(false);
		expect(controller.settings.pdfLayout).toBe('split');
		expect(controller.settingsWarning).not.toBe('');
		expect(controller.actionError).not.toBe('');
		expect(await controller.saveSettings({}, { scope: 'both' })).toBe(true);
		expect(controller.settingsWarning).toBe('');
		log.mockRestore();
		controller.dispose();
	});

	it('loads only live page annotations for the current file', async () => {
		const row = { ...input, id: '019a501b-2c3d-7e4f-8a5b-6c7d8e9f0011', book_id: 21, book_file_id: 31, created_at: '', updated_at: '', deleted_at: null, rev: 1 };
		vi.mocked(getBookState).mockResolvedValue({ ...empty, page_annotations: [row, { ...row, id: 'other', book_file_id: 32 }, { ...row, id: 'deleted', deleted_at: 'today' }] });
		const controller = createReaderController(params);
		await controller.retry();
		expect(controller.pageAnnotations).toEqual([row]);
		controller.dispose();
	});

	it('refreshes current-file annotations after sync without replacing an in-flight local edit', async () => {
		const controller = createReaderController(params);
		await controller.retry();
		vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
		vi.stubGlobal('document', { hidden: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
		vi.mocked(offlineAvailable).mockReturnValue(true);
		const release = controller.mount();
		let resolve!: (outcome: 'applied') => void;
		vi.mocked(saveMutation).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
		const saving = controller.addPageAnnotation(input);
		const row = controller.pageAnnotations[0];
		vi.mocked(readerState).mockResolvedValue({ state: { ...empty, page_annotations: [row] }, settings: [] });
		offlineStatus.update((status) => ({ ...status, syncing: true }));
		offlineStatus.update((status) => ({ ...status, syncing: false }));
		expect(readerState).not.toHaveBeenCalled();
		expect(controller.pageAnnotations).toEqual([row]);
		resolve('applied');
		await saving;
		await expect.poll(() => vi.mocked(readerState).mock.calls.length).toBe(1);
		expect(controller.pageAnnotations).toEqual([row]);
		release();
		controller.dispose();
	});

	it('clears a sync-status save alert once the outbox drains', async () => {
		const controller = createReaderController(params);
		await controller.retry();
		vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
		vi.stubGlobal('document', { hidden: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
		const release = controller.mount();
		offlineStatus.update((status) => ({ ...status, error: true, pending: 1 }));
		expect(controller.pendingError).not.toBe('');
		offlineStatus.update((status) => ({ ...status, syncing: true, error: false }));
		expect(controller.pendingError).not.toBe('');
		offlineStatus.update((status) => ({ ...status, syncing: false, pending: 0 }));
		expect(controller.pendingError).toBe('');
		release();
		controller.dispose();
	});

	it('does not replace or clear an independent close failure when sync recovers', async () => {
		const controller = createReaderController(params);
		await controller.retry();
		vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
		vi.stubGlobal('document', { hidden: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
		const release = controller.mount();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		controller.setViewSave(async () => { throw new Error('View save failed'); });
		await controller.close();
		const closeError = controller.pendingError;
		expect(closeError).not.toBe('');
		offlineStatus.update((status) => ({ ...status, error: true, pending: 1 }));
		expect(controller.pendingError).toBe(closeError);
		offlineStatus.update((status) => ({ ...status, error: false, pending: 0 }));
		expect(controller.pendingError).toBe(closeError);
		log.mockRestore();
		release();
		controller.dispose();
	});

	it('persists book and format settings without losing unknown JSON', async () => {
		vi.mocked(getSettings).mockResolvedValue([
			{ key: 'reader.book.21', value: { futureBook: { keep: true } }, updated_at: '', rev: 1 },
			{ key: 'reader.pdf', value: { futureFormat: true, pdfZoom: 'page-fit' }, updated_at: '', rev: 1 }
		]);
		const controller = createReaderController(params);
		await controller.retry();
		await controller.saveSettings({ pdfZoom: 1.5, pdfRotation: 90, pdfLayout: 'split' }, { scope: 'both' });
		expect(saveMutation).toHaveBeenNthCalledWith(1, expect.objectContaining({
			key: 'reader.book.21', data: { value: expect.objectContaining({ futureBook: { keep: true }, pdfZoom: 1.5, pdfRotation: 90, pdfLayout: 'split' }) }
		}));
		const format = vi.mocked(saveMutation).mock.calls[1][0];
		expect(format).toMatchObject({ key: 'reader.pdf', data: { value: expect.objectContaining({ futureFormat: true, pdfZoom: 'page-fit', pdfLayout: 'split' }) } });
		expect(format.data.value).not.toHaveProperty('pdfRotation');
		controller.dispose();
	});

	it('passes highlight styles through creation and updates', async () => {
		let events: ReaderEvents;
		const reader = {
			open: vi.fn(), applySettings: vi.fn(), addAnnotation: vi.fn(), removeAnnotation: vi.fn(), destroy: vi.fn(async () => {}),
			goTo: vi.fn(async () => events.relocate({ fraction: 0, locator: { type: 'pdf', page: 1 } })),
			previous: vi.fn(), next: vi.fn()
		};
		vi.mocked(createReader).mockImplementation(async (_format, _surface, next) => { events = next; return reader; });
		const controller = createReaderController(params);
		await controller.retry();
		// attach only passes the surface through to the mocked engine.
		vi.stubGlobal('document', { hidden: true });
		await controller.attach({} as HTMLElement);
		await controller.addHighlight({ text: 'Text', fraction: 0, locator: { type: 'pdf', page: 1 } }, 'green', 'underline');
		expect(saveMutation).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ style: 'underline' }) }));
		expect(controller.highlights[0].style).toBe('underline');
		await controller.updateHighlight(controller.highlights[0], { style: 'strikeout' });
		expect(saveMutation).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ color: 'green', style: 'strikeout' }) }));
		expect(controller.highlights[0].style).toBe('strikeout');
		controller.dispose();
	});
});
