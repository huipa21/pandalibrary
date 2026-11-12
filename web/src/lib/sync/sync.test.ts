import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '#lib/api/client.js';
import * as catalog from '#lib/catalog/api.js';
import type { Book } from '#lib/catalog/types.js';
import {
	activeViewer, AccountChangedError, cursorState, discardMutation, downloadedBooks, downloadedFile,
	enqueue, outbox, persistPull, recordResults, removeAllBooks, removeBook,
	retryFailed, rows, saveDownload, setActiveViewer
} from './db.js';
import { parsePullResponse, parsePushResponse, synchronize, type SyncTransport } from './engine.js';
import { cachedBook, loadBook, loadFile, loadReaderState, downloadForOffline } from './library.js';
import { readerState } from './state.js';
import type { OfflineViewer, PullResponse, SyncMutation } from './types.js';
import type { PageAnnotation } from '#lib/reader/types.js';

const viewer: OfflineViewer = { id: 1, username: 'reader', display_name: '', role: 'user', locale: 'en' };
const timestamp = '2026-11-03T00:00:00.000Z';
const file = {
	id: 31, format: 'fb2', size_bytes: 4, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}`,
	original_filename: 'book.fb2', created_at: '2026-11-01T00:00:00Z'
};
const book: Book = {
	id: 21, library_id: 1, title: 'Offline book', sort_title: 'Offline book', subtitle: null,
	description: null, language: 'en', publisher: null, published_date: null, page_count: null,
	cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
	files: [file], field_sources: [], created_at: timestamp, updated_at: timestamp
};
const pageAnnotation: PageAnnotation = {
	id: '018f0f7e-7b00-7000-8000-000000000001', book_id: 21, book_file_id: 31, kind: 'text',
	locator: { type: 'pdf', page: 1, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
	position: 0.3, data: { text: 'Saved', color: '#123abc', size: 0.02 },
	created_at: timestamp, updated_at: timestamp, deleted_at: null, rev: 2
};

async function setLegacyCursor(cursor: number, pulledAt: number): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open('pandalibrary-offline', 1);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = database.transaction('meta', 'readwrite');
			tx.objectStore('meta').put({ key: 'cursor:1', value: { cursor, pulledAt } });
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		database.close();
	}
}

function pull(cursor = 0): PullResponse {
	return { cursor, user_books: [], reading_progress: [], highlights: [], bookmarks: [], page_annotations: [], notes: [], user_settings: [] };
}

function progress(percentage = 0.5, book = 21): SyncMutation {
	return {
		entity: 'reading_progress', key: String(book), op: 'upsert', updated_at: Date.parse(timestamp),
		data: {
			book_id: book, book_file_id: 31, source: 'web', locator: { type: 'epub', cfi: 'position' },
			percentage, device: 'Web', device_id: 'device'
		}
	};
}

function transport(response = pull()): SyncTransport {
	return {
		push: vi.fn(async (mutations: SyncMutation[]) => ({
			results: mutations.map((_, index) => ({ index, status: 'applied' }))
		})),
		pull: vi.fn(async () => response)
	};
}

beforeEach(async () => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal('IDBKeyRange', IDBKeyRange);
	vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_name: string, action: () => Promise<unknown>) => action() } });
	vi.stubGlobal('window', { location: { origin: 'https://library.test' } });
	await setActiveViewer(viewer);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('durable R1 synchronization', () => {
	it('preserves pre-bookmark version-1 notes and reader settings when reopening the database', async () => {
		const { bookmarks: _bookmarks, ...oldSnapshot } = pull(2);
		oldSnapshot.notes.push({
			id: 'old-note', book_id: 21, highlight_id: null, body_md: 'Keep my note',
			created_at: timestamp, updated_at: timestamp, deleted_at: null, rev: 1
		});
		oldSnapshot.user_settings.push({ key: 'reader.pdf', value: { zoom: 1.5 }, updated_at: timestamp, rev: 2 });
		await persistPull(1, 0, parsePullResponse(oldSnapshot, 0), true);
		await setActiveViewer(null);
		await setActiveViewer(viewer);
		await persistPull(1, 2, pull(3), false);
		const state = (await readerState(1, 21)).state;
		expect(state.bookmarks).toEqual([]);
		expect(state.notes).toMatchObject([{ id: 'old-note', body_md: 'Keep my note' }]);
		expect(await rows(1)).toEqual(expect.arrayContaining([
			expect.objectContaining({ entity: 'user_settings', value: expect.objectContaining({ key: 'reader.pdf', value: { zoom: 1.5 } }) })
		]));
	});

	it('persists bookmark pulls, tombstones and queued offline edits without losing older rows', async () => {
		const bookmark = {
			id: '019a4d48-cc00-7000-8000-000000000001', book_id: 21, book_file_id: 31,
			locator: { type: 'cfi', value: 'epubcfi(/6/2)' }, position: 0.4, label: 'Saved',
			chapter: null, created_at: timestamp, updated_at: timestamp, deleted_at: null, rev: 2
		};
		const otherBookmark = {
			...bookmark, id: '019a4d48-cc00-7000-8000-000000000002', book_id: 22,
			book_file_id: 32, label: 'Other book', rev: 3
		};
		const old = pull(1);
		old.reading_progress.push({
			book_id: 21, book_file_id: 31, source: 'web', locator: null, percentage: 0.2,
			device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
		});
		await persistPull(1, 0, old, true);
		expect((await readerState(1, 21)).state.bookmarks).toEqual([]);
		const next = pull(3);
		next.bookmarks.push(bookmark, otherBookmark);
		await persistPull(1, 1, next, false);
		expect((await readerState(1, 21)).state).toMatchObject({
			progress: { percentage: 0.2 }, bookmarks: [{ id: bookmark.id, label: 'Saved' }]
		});
		expect((await readerState(1, 22)).state.bookmarks).toMatchObject([{ id: otherBookmark.id, label: 'Other book' }]);
		const edit: SyncMutation = {
			entity: 'bookmarks', id: bookmark.id, op: 'upsert', updated_at: Date.parse(timestamp) + 1,
			data: { book_id: 21, book_file_id: 31, locator: bookmark.locator, position: 0.4, label: 'Offline', chapter: null }
		};
		await enqueue(1, edit);
		await setActiveViewer(null);
		await setActiveViewer(viewer);
		expect((await readerState(1, 21)).state.bookmarks).toMatchObject([{ id: bookmark.id, label: 'Offline' }]);
		expect((await readerState(1, 22)).state.bookmarks).toMatchObject([{ id: otherBookmark.id, label: 'Other book' }]);
		await enqueue(1, { entity: 'bookmarks', id: bookmark.id, op: 'delete', data: {}, updated_at: edit.updated_at + 1 });
		expect((await readerState(1, 21)).state.bookmarks).toEqual([]);
		expect((await readerState(1, 22)).state.bookmarks).toMatchObject([{ id: otherBookmark.id, label: 'Other book' }]);
		await setActiveViewer({ ...viewer, id: 2 });
		expect((await readerState(2, 21)).state.bookmarks).toEqual([]);
		expect((await readerState(2, 22)).state.bookmarks).toEqual([]);
		await setActiveViewer(viewer);
		const tombstone = pull(4);
		tombstone.bookmarks.push({ ...bookmark, deleted_at: timestamp, rev: 4 });
		await persistPull(1, 3, tombstone, false);
		expect((await rows(1)).find((row) => row.entity === 'bookmarks' && row.value.id === bookmark.id)?.value)
			.toMatchObject({ deleted_at: timestamp });
		expect((await readerState(1, 21)).state.bookmarks).toEqual([]);
		expect((await readerState(1, 22)).state.bookmarks).toMatchObject([{ id: otherBookmark.id, label: 'Other book' }]);
	});

	it('accepts old pulls without bookmarks but rejects malformed bookmark revisions', () => {
		const { bookmarks: _bookmarks, ...old } = pull(0);
		expect(parsePullResponse(old, 0).bookmarks).toEqual([]);
		expect(() => parsePullResponse({ ...old, cursor: 1, bookmarks: [{ id: 'bad', rev: 2, updated_at: timestamp }] }, 0))
			.toThrow('invalid bookmarks revision');
		expect(() => parsePullResponse({ ...old, bookmarks: null }, 0)).toThrow('missing bookmarks');
	});

	it('stores, replays and tombstones page annotations in the offline reader', async () => {
		const initial = pull(2);
		initial.page_annotations.push(pageAnnotation);
		await persistPull(1, 0, initial, true);
		expect((await loadReaderState(1, 21, true)).state.page_annotations).toMatchObject([
			{ id: pageAnnotation.id, data: { text: 'Saved' } }
		]);
		const edit: SyncMutation = {
			entity: 'page_annotations', id: pageAnnotation.id, op: 'upsert', updated_at: Date.parse(timestamp) + 1000,
			data: {
				book_id: 21, book_file_id: 31, kind: 'text', locator: pageAnnotation.locator,
				position: 0.3, data: { text: 'Offline', color: '#123abc', size: 0.02 }
			}
		};
		await enqueue(1, edit);
		expect((await loadReaderState(1, 21, true)).state.page_annotations).toMatchObject([{ data: { text: 'Offline' } }]);
		await recordResults(1, await outbox(1), [{ index: 0, status: 'stale' }]);
		expect((await readerState(1, 21)).state.page_annotations).toMatchObject([{ data: { text: 'Saved' } }]);
		await enqueue(1, {
			entity: 'page_annotations', id: pageAnnotation.id, op: 'delete', data: {}, updated_at: edit.updated_at + 1000
		});
		expect((await readerState(1, 21)).state.page_annotations).toEqual([]);
		const tombstone = pull(3);
		const deletedAt = new Date(Date.parse(timestamp) + 1500).toISOString();
		tombstone.page_annotations.push({ ...pageAnnotation, updated_at: deletedAt, deleted_at: deletedAt, rev: 3 });
		await persistPull(1, 2, tombstone, false);
		await enqueue(1, edit);
		expect((await readerState(1, 21)).state.page_annotations).toEqual([]);
		await enqueue(1, { ...edit, updated_at: edit.updated_at + 3000 });
		expect((await readerState(1, 21)).state.page_annotations).toMatchObject([{ data: { text: 'Offline' } }]);
		expect(await rows(1)).toEqual(expect.arrayContaining([
			expect.objectContaining({ entity: 'page_annotations', value: expect.objectContaining({ deleted_at: deletedAt }) })
		]));
	});

	it('accepts old pulls without page annotations but rejects malformed new rows', () => {
		const { page_annotations: _pages, ...old } = pull(0);
		expect(parsePullResponse(old, 0).page_annotations).toEqual([]);
		expect(() => parsePullResponse({ ...old, page_annotations: null }, 0)).toThrow('missing page_annotations');
		expect(() => parsePullResponse({ ...old, cursor: 1, page_annotations: [pageAnnotation] }, 0))
			.toThrow('invalid page_annotations revision');
		expect(() => parsePullResponse({
			...old, cursor: 2, page_annotations: [{ ...pageAnnotation, kind: 'invalid' }]
		}, 0)).toThrow('invalid row');
	});

	it('performs one schema-upgrade full pull without discarding newly queued writes', async () => {
		await persistPull(1, 0, pull(10), true, 9000);
		await setLegacyCursor(10, 9000);
		const response = pull(11);
		response.page_annotations.push(pageAnnotation);
		const client = transport();
		vi.mocked(client.pull).mockImplementationOnce(async () => {
			await enqueue(1, progress());
			return response;
		}).mockResolvedValueOnce(pull(12));
		await synchronize(1, client, 10_000);
		expect(client.pull).toHaveBeenNthCalledWith(1, 0, 1);
		expect(await cursorState(1)).toMatchObject({ cursor: 11, schema: 2 });
		expect((await readerState(1, 21)).state.page_annotations).toMatchObject([{ id: pageAnnotation.id }]);
		expect(await outbox(1)).toMatchObject([{ status: 'pending', mutation: progress() }]);
		await synchronize(1, client, 11_000);
		expect(client.pull).toHaveBeenNthCalledWith(2, 11, 1);
		expect(client.push).toHaveBeenCalledOnce();
		expect((await readerState(1, 21)).state.page_annotations).toMatchObject([{ id: pageAnnotation.id }]);
	});

	it('reopens the outbox without changing UUIDs, natural keys, timestamps or tombstones', async () => {
		const mutations: SyncMutation[] = [
			progress(),
			{ entity: 'notes', id: '019a4d48-cc00-7000-8000-000000000001', op: 'delete', data: {}, updated_at: 123 },
			{ entity: 'user_settings', key: 'reader.book.21', op: 'upsert', data: { value: { theme: 'dark' } }, updated_at: 456 }
		];
		for (const mutation of mutations) await enqueue(1, mutation);
		expect((await outbox(1)).map((entry) => entry.mutation)).toEqual(mutations);
		await setActiveViewer(null);
		await setActiveViewer(viewer);
		expect((await outbox(1)).map((entry) => entry.mutation)).toEqual(mutations);
	});

	it('stores reactive reader locator proxies as plain JSON', async () => {
		const mutation = progress();
		mutation.data.locator = new Proxy({ type: 'pdf', page: 2 }, {});
		await enqueue(1, new Proxy(mutation, {}));
		expect((await outbox(1))[0].mutation.data.locator).toEqual({ type: 'pdf', page: 2 });
	});

	it('retains the exact mutation after a failed push and retries it', async () => {
		const mutation = progress();
		await enqueue(1, mutation);
		const client = transport();
		vi.mocked(client.push).mockRejectedValueOnce(new TypeError('Network interrupted'));
		await expect(synchronize(1, client)).rejects.toThrow('Network interrupted');
		expect(await outbox(1)).toMatchObject([{ mutation, status: 'pending' }]);
		expect(client.pull).not.toHaveBeenCalled();
		await expect(synchronize(1, client)).resolves.toEqual({ applied: 1, issues: 0 });
		expect(vi.mocked(client.push).mock.calls.map(([batch]) => batch)).toEqual([[mutation], [mutation]]);
		expect(await outbox(1)).toEqual([]);
	});

	it('pushes without pulling, makes no requests for an empty outbox, and pulls to reconcile new stale results', async () => {
		const client = transport();
		await expect(synchronize(1, client, 1, { pull: false })).resolves.toEqual({ applied: 0, issues: 0 });
		expect(client.push).not.toHaveBeenCalled();
		await enqueue(1, progress(0.6));
		await expect(synchronize(1, client, 2, { pull: false })).resolves.toEqual({ applied: 1, issues: 0 });
		await synchronize(1, client, 3, { pull: false });
		expect(client.push).toHaveBeenCalledOnce();
		expect(client.pull).not.toHaveBeenCalled();
		expect(await outbox(1)).toMatchObject([{ status: 'applied' }]);
		expect((await readerState(1, 21)).state.progress?.percentage).toBe(0.6);
		await synchronize(1, client, 4);
		expect(client.pull).toHaveBeenCalledOnce();
		expect(await outbox(1)).toEqual([]);

		await enqueue(1, progress(0.7));
		vi.mocked(client.push).mockResolvedValueOnce({ results: [{ index: 0, status: 'stale' }] });
		await synchronize(1, client, 5, { pull: false });
		expect(client.pull).toHaveBeenCalledTimes(2);
	});

	it('keeps only the latest pending position per book and tolerates a superseded in-flight one', async () => {
		await enqueue(1, progress(0.1));
		await enqueue(1, progress(0.2, 22));
		await enqueue(1, progress(0.3));
		expect((await outbox(1)).map((entry) => entry.mutation)).toEqual([progress(0.2, 22), progress(0.3)]);
		const client = transport();
		vi.mocked(client.push).mockImplementationOnce(async (mutations) => {
			await enqueue(1, progress(0.4));
			return { results: mutations.map((_, index) => ({ index, status: 'applied' })) };
		});
		await synchronize(1, client, 1, { pull: false });
		expect(vi.mocked(client.push).mock.calls.map(([batch]) => batch))
			.toEqual([[progress(0.2, 22), progress(0.3)], [progress(0.4)]]);
		expect(await outbox(1)).toMatchObject([
			{ mutation: progress(0.2, 22), status: 'applied' }, { mutation: progress(0.4), status: 'applied' }
		]);

		const otherFile = progress(0.5);
		(otherFile.data as { book_file_id: number }).book_file_id = 32;
		await enqueue(1, progress(0.45));
		await enqueue(1, otherFile);
		expect((await outbox(1)).slice(2).map((entry) => entry.mutation)).toEqual([progress(0.45), otherFile]);

		await enqueue(1, { entity: 'notes', id: 'note', op: 'upsert', updated_at: 1, data: { body_md: 'x' } });
		const entries = await outbox(1);
		await discardMutation(1, entries[4].sequence);
		await expect(recordResults(1, entries, [{ index: 4, status: 'applied' }])).rejects.toThrow('changed while synchronizing');
	});

	it('inspects mixed results and keeps rejected and stale writes for explicit retry', async () => {
		for (let i = 0; i < 3; i++) await enqueue(1, progress(i / 10, 21 + i));
		const client = transport(pull(10));
		vi.mocked(client.push).mockResolvedValue({
			results: [{ index: 2, status: 'rejected', reason: 'denied' }, { index: 0, status: 'applied' }, { index: 1, status: 'stale' }]
		});
		await expect(synchronize(1, client)).resolves.toEqual({ applied: 1, issues: 2 });
		expect(await outbox(1)).toMatchObject([{ status: 'stale' }, { status: 'rejected', reason: 'denied' }]);
		expect((await readerState(1, 21)).state.progress).toBeNull();
		await retryFailed(1);
		expect((await outbox(1)).map((entry) => entry.status)).toEqual(['pending', 'pending']);
	});

	it('reconciles lost acknowledgments against the saved state without reporting false conflicts', async () => {
		const setting: SyncMutation = {
			entity: 'user_settings', key: 'reader.pdf', op: 'upsert', updated_at: Date.parse(timestamp),
			data: { value: { layout: ['single', 'split'], theme: 'dark' } }
		};
		const note: SyncMutation = {
			entity: 'notes', id: '019a4d48-cc00-7000-8000-000000000001',
			op: 'upsert', updated_at: Date.parse(timestamp),
			data: { book_id: 21, highlight_id: null, body_md: 'Saved note' }
		};
		const session: SyncMutation = {
			entity: 'reading_sessions', id: '019a4d48-cc00-7000-8000-000000000002',
			op: 'upsert', updated_at: Date.parse(timestamp),
			data: { book_id: 21, source: 'web', started_at: 1, ended_at: 2, active_seconds: 1 }
		};
		for (const mutation of [progress(), setting, note, session]) await enqueue(1, mutation);
		const response = pull(3);
		response.reading_progress.push({
			book_id: 21, book_file_id: 31, source: 'web', locator: { cfi: 'position', type: 'epub' },
			percentage: 0.5, device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
		});
		response.user_settings.push({
			key: 'reader.pdf', value: { theme: 'dark', layout: ['single', 'split'] }, updated_at: timestamp, rev: 2
		});
		response.notes.push({
			id: '019a4d48-cc00-7000-8000-000000000001', book_id: 21, highlight_id: null,
			body_md: 'Saved note', created_at: timestamp, updated_at: timestamp, deleted_at: null, rev: 3
		});
		const client = transport(response);
		vi.mocked(client.push).mockResolvedValue({
			results: [0, 1, 2, 3].map((index) => ({ index, status: 'stale' }))
		});

		await expect(synchronize(1, client)).resolves.toEqual({ applied: 0, issues: 0 });
		expect(await outbox(1)).toEqual([]);
	});

	it('clears previously recorded false conflicts but retains different or rejected changes', async () => {
		const setting: SyncMutation = {
			entity: 'user_settings', key: 'reader.pdf', op: 'upsert', updated_at: Date.parse(timestamp),
			data: { value: { theme: 'dark' } }
		};
		const rejected: SyncMutation = {
			entity: 'notes', id: '019a4d48-cc00-7000-8000-000000000001',
			op: 'upsert', updated_at: Date.parse(timestamp),
			data: { book_id: 21, highlight_id: null, body_md: 'Unsent' }
		};
		for (const mutation of [setting, progress(0.7), rejected]) await enqueue(1, mutation);
		await recordResults(1, await outbox(1), [
			{ index: 0, status: 'stale' }, { index: 1, status: 'stale' },
			{ index: 2, status: 'rejected', reason: 'book is unavailable' }
		]);
		const response = pull(3);
		response.user_settings.push({ key: 'reader.pdf', value: { theme: 'dark' }, updated_at: timestamp, rev: 1 });
		response.reading_progress.push({
			book_id: 21, book_file_id: 31, source: 'web', locator: { type: 'epub', cfi: 'position' },
			percentage: 0.5, device: 'Web', device_id: 'device', updated_at: timestamp, rev: 2
		});
		response.notes.push({
			id: '019a4d48-cc00-7000-8000-000000000001', book_id: 21, highlight_id: null,
			body_md: 'Unsent', created_at: timestamp, updated_at: timestamp, deleted_at: null, rev: 3
		});
		const client = transport(response);
		vi.mocked(client.pull).mockRejectedValueOnce(new TypeError('Interrupted pull')).mockResolvedValueOnce(response);

		await expect(synchronize(1, client)).rejects.toThrow('Interrupted pull');
		expect(await outbox(1)).toHaveLength(3);
		await expect(synchronize(1, client)).resolves.toEqual({ applied: 0, issues: 2 });
		expect(client.push).not.toHaveBeenCalled();
		expect(await outbox(1)).toMatchObject([
			{ mutation: progress(0.7), status: 'stale' },
			{ mutation: rejected, status: 'rejected', reason: 'book is unavailable' }
		]);
	});

	it('reconciles a stale delete only when the pulled row is already deleted', async () => {
		const id = '019a4d48-cc00-7000-8000-000000000001';
		const deletion: SyncMutation = { entity: 'notes', id, op: 'delete', data: {}, updated_at: 123 };
		const edit: SyncMutation = {
			entity: 'notes', id, op: 'upsert', updated_at: 124,
			data: { book_id: 21, highlight_id: null, body_md: 'Keep this edit' }
		};
		await enqueue(1, deletion);
		await enqueue(1, edit);
		await recordResults(1, await outbox(1), [{ index: 0, status: 'stale' }, { index: 1, status: 'stale' }]);
		const response = pull(1);
		response.notes.push({
			id, book_id: 21, highlight_id: null, body_md: 'Old note', created_at: timestamp,
			updated_at: timestamp, deleted_at: timestamp, rev: 1
		});
		await expect(synchronize(1, transport(response))).resolves.toEqual({ applied: 0, issues: 1 });
		expect(await outbox(1)).toMatchObject([{ mutation: edit, status: 'stale' }]);
	});

	it('reconciles matching book and annotation writes without discarding a different edit', async () => {
		const highlightId = '019a4d48-cc00-7000-8000-000000000001';
		const bookmarkId = '019a4d48-cc00-7000-8000-000000000002';
		const locator = { type: 'pdf', page: 1 };
		const changes: SyncMutation[] = [
			{
				entity: 'user_books', key: '21', op: 'upsert', updated_at: 123,
				data: { book_id: 21, status: 'reading', rating: null, started_at: Date.parse(timestamp), finished_at: null }
			},
			{
				entity: 'highlights', id: highlightId, op: 'upsert', updated_at: 123,
				data: {
					book_id: 21, book_file_id: 31, locator, position: 0.3,
					text: 'Marked', color: 'yellow', style: 'underline', chapter: null
				}
			},
			{
				entity: 'bookmarks', id: bookmarkId, op: 'upsert', updated_at: 123,
				data: { book_id: 21, book_file_id: 31, locator, position: 0.3, label: 'Saved', chapter: null }
			},
			{
				entity: 'page_annotations', id: pageAnnotation.id, op: 'upsert', updated_at: 123,
				data: {
					book_id: 21, book_file_id: 31, kind: 'text', locator: pageAnnotation.locator,
					position: 0.3, data: pageAnnotation.data
				}
			}
		];
		const different: SyncMutation = {
			...changes[3], data: { ...changes[3].data, data: { text: 'Unsaved', color: '#123abc', size: 0.02 } }
		};
		for (const change of [...changes, different]) await enqueue(1, change);
		await recordResults(1, await outbox(1), [0, 1, 2, 3, 4].map((index) => ({ index, status: 'stale' })));
		const response = pull(4);
		response.user_books.push({
			book_id: 21, status: 'reading', rating: null, started_at: timestamp, finished_at: null,
			updated_at: timestamp, rev: 1
		});
		response.highlights.push({
			id: highlightId, book_id: 21, book_file_id: 31, locator, position: 0.3,
			text: 'Marked', color: 'yellow', style: 'underline', chapter: null, created_at: timestamp,
			updated_at: timestamp, deleted_at: null, rev: 2
		});
		response.bookmarks.push({
			id: bookmarkId, book_id: 21, book_file_id: 31, locator, position: 0.3, label: 'Saved',
			chapter: null, created_at: timestamp, updated_at: timestamp, deleted_at: null, rev: 3
		});
		response.page_annotations.push({ ...pageAnnotation, rev: 4 });

		await expect(synchronize(1, transport(response))).resolves.toEqual({ applied: 0, issues: 1 });
		expect(await outbox(1)).toMatchObject([{ mutation: different, status: 'stale' }]);
	});

	it('checks a fresh snapshot once and does not mistake an old cached row for confirmation', async () => {
		const initial = pull(10);
		initial.reading_progress.push({
			book_id: 21, book_file_id: 31, source: 'web', locator: { type: 'epub', cfi: 'position' },
			percentage: 0.5, device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
		});
		const now = Date.parse(timestamp);
		await persistPull(1, 0, initial, true, now);
		await enqueue(1, progress());
		await recordResults(1, await outbox(1), [{ index: 0, status: 'stale' }]);
		const later = pull(11);
		later.reading_progress.push({ ...initial.reading_progress[0], rev: 11 });
		const client = transport();
		vi.mocked(client.pull).mockResolvedValueOnce(pull(10)).mockResolvedValueOnce(pull(10))
			.mockResolvedValueOnce(pull(10)).mockResolvedValueOnce(later);

		await expect(synchronize(1, client, now + 1)).resolves.toEqual({ applied: 0, issues: 1 });
		expect(client.pull).toHaveBeenNthCalledWith(1, 0, 1);
		expect(await outbox(1)).toMatchObject([{ status: 'stale', conflictChecked: true }]);
		await expect(synchronize(1, client, now + 2)).resolves.toEqual({ applied: 0, issues: 1 });
		expect(client.pull).toHaveBeenNthCalledWith(2, 10, 1);
		await retryFailed(1);
		vi.mocked(client.push).mockResolvedValueOnce({ results: [{ index: 0, status: 'stale' }] });
		await expect(synchronize(1, client, now + 3)).resolves.toEqual({ applied: 0, issues: 1 });
		expect(client.pull).toHaveBeenNthCalledWith(3, 0, 1);
		await expect(synchronize(1, client, now + 4)).resolves.toEqual({ applied: 0, issues: 0 });
		expect(client.pull).toHaveBeenNthCalledWith(4, 10, 1);
		expect(await outbox(1)).toEqual([]);
	});

	it('retains stale mutations with unrecognized or missing fields', async () => {
		const id = '019a4d48-cc00-7000-8000-000000000001';
		const changes: SyncMutation[] = [
			{ entity: 'notes', id, op: 'upsert', updated_at: 123, data: { book_id: 21, body_md: 'Saved' } },
			{
				entity: 'notes', id, op: 'upsert', updated_at: 124,
				data: { book_id: 21, highlight_id: null, body_md: 'Saved', future_field: true }
			}
		];
		for (const change of changes) await enqueue(1, change);
		await recordResults(1, await outbox(1), [{ index: 0, status: 'stale' }, { index: 1, status: 'stale' }]);
		const response = pull(1);
		response.notes.push({
			id, book_id: 21, highlight_id: null, body_md: 'Saved', created_at: timestamp,
			updated_at: timestamp, deleted_at: null, rev: 1
		});
		await expect(synchronize(1, transport(response))).resolves.toEqual({ applied: 0, issues: 2 });
		expect((await outbox(1)).map((entry) => entry.mutation)).toEqual(changes);
	});

	it('retains all unsent or unacknowledged writes on malformed partial results', async () => {
		await enqueue(1, progress());
		await enqueue(1, progress(0.7, 22));
		const client = transport();
		vi.mocked(client.push).mockResolvedValue({ results: [{ index: 0, status: 'applied' }] });
		await expect(synchronize(1, client)).rejects.toThrow('invalid push response');
		expect((await outbox(1)).map((entry) => entry.status)).toEqual(['pending', 'pending']);
		expect(() => parsePushResponse({ results: [{ index: 0, status: 'applied' }, { index: 0, status: 'applied' }] }, 2))
			.toThrow('duplicate');
	});

	it('keeps confirmed edits replayable if pull fails, without pushing them twice', async () => {
		await enqueue(1, progress(0.8));
		const response = pull(10);
		response.reading_progress.push({
			book_id: 21, book_file_id: 31, source: 'web', locator: null, percentage: 0.8,
			device: 'Web', device_id: 'device', updated_at: timestamp, rev: 8
		});
		const client = transport(response);
		vi.mocked(client.pull).mockRejectedValueOnce(new TypeError('Interrupted pull'));
		await expect(synchronize(1, client)).rejects.toThrow('Interrupted pull');
		expect(await outbox(1)).toMatchObject([{ status: 'applied' }]);
		expect((await readerState(1, 21)).state.progress?.percentage).toBe(0.8);
		await retryFailed(1);
		await synchronize(1, client);
		expect(client.push).toHaveBeenCalledOnce();
		expect(await outbox(1)).toEqual([]);
		expect((await readerState(1, 21)).state.progress?.percentage).toBe(0.8);
	});

	it('bounds pushes to 500 mutations and pushes before pulling', async () => {
		for (let i = 0; i < 501; i++) await enqueue(1, progress(i / 501, i + 1));
		const client = transport();
		await synchronize(1, client);
		expect(vi.mocked(client.push).mock.calls.map(([batch]) => batch.length)).toEqual([500, 1]);
		expect(vi.mocked(client.push).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(client.pull).mock.invocationCallOrder[0]);
	});

	it('bounds encoded request bytes and retains oversized unsent writes', async () => {
		for (let i = 0; i < 3; i++) {
			await enqueue(1, {
				entity: 'notes', id: String(i), op: 'upsert', updated_at: 123,
				data: { book_id: 21, body_md: '书'.repeat(250_000) }
			});
		}
		const client = transport();
		await synchronize(1, client);
		const batches = vi.mocked(client.push).mock.calls.map(([batch]) => batch);
		expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
		for (const batch of batches) {
			expect(new TextEncoder().encode(JSON.stringify({ mutations: batch })).length).toBeLessThan(2 * 1024 * 1024);
		}
		await enqueue(1, { entity: 'notes', id: 'large', op: 'upsert', updated_at: 123, data: { body_md: 'x'.repeat(2_000_000) } });
		await expect(synchronize(1, client)).rejects.toThrow('size limit');
		expect(await outbox(1)).toMatchObject([{ mutation: { id: 'large' }, status: 'pending' }]);
	});

	it('accepts revision gaps and persists tombstones with the cursor', async () => {
		const response = pull(100);
		response.notes.push({
			id: 'note', book_id: 21, highlight_id: null, body_md: '', created_at: timestamp,
			updated_at: timestamp, deleted_at: timestamp, rev: 17
		});
		await persistPull(1, 0, parsePullResponse(response, 0), true);
		expect(await cursorState(1)).toMatchObject({ cursor: 100 });
		expect(await rows(1)).toMatchObject([{ entity: 'notes', value: { deleted_at: timestamp, rev: 17 } }]);
		expect((await readerState(1, 21)).state.notes).toEqual([]);
		expect(() => parsePullResponse({ ...response, cursor: 16 }, 0)).toThrow('revision');
	});

	it('rolls back the entire snapshot and cursor when persistence is interrupted', async () => {
		const original = pull(5);
		original.user_settings.push({ key: 'old', value: true, updated_at: timestamp, rev: 3 });
		await persistPull(1, 0, original, true);
		await enqueue(1, progress());
		const entries = await outbox(1);
		await recordResults(1, entries, [{ index: 0, status: 'applied' }]);
		const response = pull(20);
		response.user_settings.push(
			{ key: 'new', value: true, updated_at: timestamp, rev: 9 },
			{ key: 'fail', value: true, updated_at: timestamp, rev: 12 }
		);
		const put = IDBObjectStore.prototype.put;
		vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if (this.name === 'rows' && value.key === 'fail') throw new DOMException('Storage full', 'QuotaExceededError');
			return put.call(this, value, key);
		});
		await expect(persistPull(1, 5, response, true)).rejects.toThrow('Storage full');
		expect(await cursorState(1)).toMatchObject({ cursor: 5 });
		expect(await rows(1)).toMatchObject([{ key: 'old' }]);
		expect(await outbox(1)).toMatchObject([{ status: 'applied' }]);
		vi.restoreAllMocks();
		await persistPull(1, 5, response, true);
		expect(await cursorState(1)).toMatchObject({ cursor: 20 });
		expect(await outbox(1)).toEqual([]);
	});

	it('rejects concurrent cursor changes and requests a full resync after 180 days', async () => {
		await persistPull(1, 0, pull(5), true, 1);
		await expect(persistPull(1, 0, pull(8), false)).rejects.toThrow('cursor changed');
		const client = transport(pull(10));
		await synchronize(1, client, 181 * 24 * 60 * 60 * 1000);
		expect(client.pull).toHaveBeenCalledWith(0, 1);
	});
});

describe('account-scoped explicit downloads', () => {
	it('isolates private files, snapshots, cursors and outboxes across logout and account changes', async () => {
		await saveDownload(1, book, file, new Blob(['book']), new Blob(['cover']));
		await enqueue(1, progress());
		await persistPull(1, 0, pull(42), true);
		await setActiveViewer(null);
		expect(await activeViewer()).toBeNull();
		await expect(downloadedFile(1, 21, file)).rejects.toBeInstanceOf(AccountChangedError);
		await setActiveViewer({ ...viewer, id: 2 });
		expect(await downloadedBooks(2)).toEqual([]);
		expect(await outbox(2)).toEqual([]);
		expect(await cursorState(2)).toMatchObject({ cursor: 0 });
		await expect(outbox(1)).rejects.toBeInstanceOf(AccountChangedError);
		const client = transport();
		await expect(synchronize(1, client)).rejects.toBeInstanceOf(AccountChangedError);
		expect(client.push).not.toHaveBeenCalled();
		expect(client.pull).not.toHaveBeenCalled();
		await setActiveViewer(viewer);
		expect(await outbox(1)).toHaveLength(1);
		expect(await downloadedBooks(1)).toHaveLength(1);
	});

	it('scopes push and pull to the expected account without /auth/me and maps 409 to an account change', async () => {
		await enqueue(1, progress());
		const request = vi.spyOn(api, 'request')
			.mockResolvedValueOnce({ results: [{ index: 0, status: 'applied' }] })
			.mockResolvedValueOnce(pull(1));
		await synchronize(1);
		expect(request.mock.calls.map(([path, init]) => [path, new Headers(init?.headers).get('X-PandaLibrary-Account')]))
			.toEqual([['/sync/push', '1'], ['/sync/pull?cursor=0', '1']]);
		request.mockRejectedValueOnce(new ApiError(409, 'Conflict', ''));
		await expect(synchronize(1)).rejects.toBeInstanceOf(AccountChangedError);
		expect(request).toHaveBeenLastCalledWith('/sync/pull?cursor=1', expect.anything());
		await enqueue(1, progress(0.6));
		request.mockRejectedValueOnce(new ApiError(409, 'Conflict', ''));
		await expect(synchronize(1, undefined, Date.now(), { pull: false })).rejects.toBeInstanceOf(AccountChangedError);
		expect(request).toHaveBeenLastCalledWith('/sync/push', expect.anything());
		expect(await outbox(1)).toMatchObject([{ mutation: progress(0.6), status: 'pending' }]);
	});

	it('evicts files, book detail and cover without discarding queued edits', async () => {
		await enqueue(1, progress());
		await saveDownload(1, book, file, new Blob(['book']), new Blob(['cover']));
		await removeBook(1, 21);
		expect(await downloadedBooks(1)).toEqual([]);
		await expect(downloadedFile(1, 21, file)).rejects.toThrow('missing');
		await saveDownload(1, book, file, new Blob(['book']), null);
		await removeAllBooks(1);
		expect(await downloadedBooks(1)).toEqual([]);
		expect(await outbox(1)).toHaveLength(1);
	});

	it('opens only explicitly stored, matching hash-versioned files while offline', async () => {
		vi.stubGlobal('navigator', { onLine: false });
		await expect(cachedBook(1, 21)).rejects.toThrow('not available');
		await saveDownload(1, book, file, new Blob(['downloaded']), null);
		expect((await loadBook(1, 21)).offline).toBe(true);
		expect(await (await loadFile(1, 21, file, true)).text()).toBe('downloaded');
		await expect(downloadedFile(1, 21, { ...file, download_url: `${file.download_url}changed` }))
			.rejects.toThrow('no longer matches');
		await expect(loadFile(1, 21, { ...file, download_url: 'https://elsewhere.test/file' }, true))
			.rejects.toMatchObject({ name: 'InvalidFileUrlError' });
	});

	for (const status of [403, 404]) {
		it(`evicts an explicitly downloaded book on an authenticated ${status}`, async () => {
			await saveDownload(1, book, file, new Blob(['book']), new Blob(['cover']));
			vi.spyOn(catalog, 'getBook').mockRejectedValue(new ApiError(status, 'Denied', 'denied'));
			await expect(loadBook(1, 21)).rejects.toMatchObject({ status });
			expect(await downloadedBooks(1)).toEqual([]);
			await expect(downloadedFile(1, 21, file)).rejects.toThrow('missing');
		});
	}

	it('evicts on denied file downloads and never replaces an HTTP failure with cached content', async () => {
		await saveDownload(1, book, file, new Blob(['book']), null);
		vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
		await expect(loadFile(1, 21, file, false)).rejects.toMatchObject({ status: 403 });
		expect(await downloadedBooks(1)).toEqual([]);
	});

	it('does not download files outside the catalog book', async () => {
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		await expect(downloadForOffline(1, book, { ...file, id: 999 })).rejects.toThrow('not in this book');
		expect(fetcher).not.toHaveBeenCalled();
	});
});
