import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import * as catalog from '#lib/catalog/api.js';
import type { Book } from '#lib/catalog/types.js';
import { localBookmarks } from '#lib/bookmarks/offline.js';
import {
	activeViewer, AccountChangedError, cursorState, downloadedBooks, downloadedFile,
	enqueue, outbox, persistPull, recordResults, removeAllBooks, removeBook,
	retryFailed, rows, saveDownload, setActiveViewer
} from './db.js';
import { parsePullResponse, parsePushResponse, synchronize, type SyncTransport } from './engine.js';
import { cachedBook, loadBook, loadFile, downloadForOffline } from './library.js';
import { readerState } from './state.js';
import type { OfflineViewer, PullResponse, SyncMutation } from './types.js';

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

function pull(cursor = 0): PullResponse {
	return { cursor, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: [] };
}

function progress(percentage = 0.5): SyncMutation {
	return {
		entity: 'reading_progress', key: '21', op: 'upsert', updated_at: Date.parse(timestamp),
		data: {
			book_id: 21, book_file_id: 31, source: 'web', locator: { type: 'epub', cfi: 'position' },
			percentage, device: 'Web', device_id: 'device'
		}
	};
}

function transport(response = pull()): SyncTransport {
	return {
		viewer: vi.fn(async () => 1),
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
		const old = pull(1);
		old.reading_progress.push({
			book_id: 21, book_file_id: 31, source: 'web', locator: null, percentage: 0.2,
			device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
		});
		await persistPull(1, 0, old, true);
		expect((await readerState(1, 21)).state.bookmarks).toEqual([]);
		const next = pull(2);
		next.bookmarks.push(bookmark);
		await persistPull(1, 1, next, false);
		expect((await readerState(1, 21)).state).toMatchObject({
			progress: { percentage: 0.2 }, bookmarks: [{ id: bookmark.id, label: 'Saved' }]
		});
		const edit: SyncMutation = {
			entity: 'bookmarks', id: bookmark.id, op: 'upsert', updated_at: Date.parse(timestamp) + 1,
			data: { book_id: 21, book_file_id: 31, locator: bookmark.locator, position: 0.4, label: 'Offline', chapter: null }
		};
		await enqueue(1, edit);
		await setActiveViewer(null);
		await setActiveViewer(viewer);
		expect((await readerState(1, 21)).state.bookmarks[0].label).toBe('Offline');
		await saveDownload(1, book, file, new Blob(['book']), null);
		expect(await localBookmarks(1)).toMatchObject([{ id: bookmark.id, label: 'Offline', book: { title: book.title } }]);
		await enqueue(1, { entity: 'bookmarks', id: bookmark.id, op: 'delete', data: {}, updated_at: edit.updated_at + 1 });
		expect((await readerState(1, 21)).state.bookmarks).toEqual([]);
		await setActiveViewer({ ...viewer, id: 2 });
		expect((await readerState(2, 21)).state.bookmarks).toEqual([]);
		expect(await localBookmarks(2)).toEqual([]);
		await setActiveViewer(viewer);
		const tombstone = pull(3);
		tombstone.bookmarks.push({ ...bookmark, deleted_at: timestamp, rev: 3 });
		await persistPull(1, 2, tombstone, false);
		expect((await rows(1)).find((row) => row.entity === 'bookmarks')?.value).toMatchObject({ deleted_at: timestamp });
		expect((await readerState(1, 21)).state.bookmarks).toEqual([]);
	});

	it('accepts old pulls without bookmarks but rejects malformed bookmark revisions', () => {
		const { bookmarks: _bookmarks, ...old } = pull(0);
		expect(parsePullResponse(old, 0).bookmarks).toEqual([]);
		expect(() => parsePullResponse({ ...old, cursor: 1, bookmarks: [{ id: 'bad', rev: 2, updated_at: timestamp }] }, 0))
			.toThrow('invalid bookmarks revision');
		expect(() => parsePullResponse({ ...old, bookmarks: null }, 0)).toThrow('missing bookmarks');
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

	it('inspects mixed results and keeps rejected and stale writes for explicit retry', async () => {
		for (let i = 0; i < 3; i++) await enqueue(1, progress(i / 10));
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

	it('retains all unsent or unacknowledged writes on malformed partial results', async () => {
		await enqueue(1, progress());
		await enqueue(1, progress(0.7));
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
		for (let i = 0; i < 501; i++) await enqueue(1, progress(i / 501));
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
		expect(client.pull).toHaveBeenCalledWith(0);
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
		vi.mocked(client.viewer).mockResolvedValue(2);
		await expect(synchronize(1, client)).rejects.toBeInstanceOf(AccountChangedError);
		expect(client.push).not.toHaveBeenCalled();
		await setActiveViewer(viewer);
		await expect(synchronize(1, client)).rejects.toBeInstanceOf(AccountChangedError);
		expect(client.push).not.toHaveBeenCalled();
		expect(await outbox(1)).toHaveLength(1);
		expect(await downloadedBooks(1)).toHaveLength(1);
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
