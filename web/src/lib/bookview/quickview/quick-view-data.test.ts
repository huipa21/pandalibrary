import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import { getBook, getBookShelves } from '#lib/catalog/api.js';
import type { Book } from '#lib/catalog/types.js';
import { getBookState } from '#lib/reader/api.js';
import type { BookState, Progress } from '#lib/reader/types.js';
import type { Shelf } from '#lib/shelves/types.js';
import { currentAccount, offlineAvailable } from '#lib/sync/client.js';
import { OfflineStorageError } from '#lib/sync/db.js';
import { loadBook as loadOfflineBook } from '#lib/sync/library.js';
import {
	choosePrimaryFile, isCompleteBook, loadQuickView, orderCollections, QuickViewNotFoundError
} from './quick-view-data.js';

vi.mock('#lib/catalog/api.js', () => ({ getBook: vi.fn(), getBookShelves: vi.fn() }));
vi.mock('#lib/reader/api.js', () => ({ getBookState: vi.fn() }));
vi.mock('#lib/sync/client.js', () => ({ currentAccount: vi.fn(), offlineAvailable: vi.fn() }));
vi.mock('#lib/sync/library.js', () => ({ loadBook: vi.fn() }));
vi.mock('#lib/sync/db.js', () => ({
	OfflineStorageError: class OfflineStorageError extends Error {}
}));

const timestamp = '2026-11-07T00:00:00Z';
const file = (id: number, format: string) => ({
	id, format, size_bytes: 1024, download_url: `/api/v1/books/5/files/${id}`,
	original_filename: `book-${id}.${format}`, created_at: timestamp
});
const book: Book = {
	owner_id: null, visibility: 'library', can_manage_visibility: false,
	id: 5, library_id: 1, title: 'Seeded', sort_title: 'Seeded', subtitle: null, description: 'About',
	language: 'en', publisher: 'Press', published_date: '2020-01-02', page_count: 120, cover_url: null,
	cover_source: null, authors: [], series: null, tags: [], identifiers: [], field_sources: [],
	files: [file(51, 'pdf'), file(52, 'epub'), file(53, 'zip')],
	created_at: timestamp, updated_at: timestamp
};
const userBook = {
	status: 'reading', rating: 6, started_at: timestamp, finished_at: null, updated_at: timestamp, rev: 2
};
const progress = (fileId: number | null): Progress => ({
	book_file_id: fileId, source: 'web', locator: null, percentage: 0.4,
	device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
} as Progress);
const state = (overrides: Partial<BookState> = {}): BookState => ({
	user_book: userBook, progress: progress(51), highlights: [], bookmarks: [], notes: [], ...overrides
});
const shelf = (id: number, name: string, systemKey: string | null = null): Shelf => ({
	id, kind: 'private', owner_id: 1, name, description: null, created_by: 1, visible_book_count: 1,
	created_at: timestamp, updated_at: timestamp, mode: 'manual', system_key: systemKey
});

beforeEach(() => {
	vi.mocked(offlineAvailable).mockReturnValue(false);
	vi.mocked(currentAccount).mockReturnValue(9);
	vi.mocked(getBook).mockResolvedValue({ ...book, title: 'Fetched' });
	vi.mocked(getBookState).mockResolvedValue(state());
	vi.mocked(getBookShelves).mockResolvedValue([shelf(3, 'Alpha'), shelf(9, 'Favorites', 'favorites')]);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetAllMocks();
	vi.restoreAllMocks();
});

describe('loadQuickView', () => {
	it('merges the book, per-user state and shelves, skipping the fetch for a complete seed', async () => {
		const data = await loadQuickView(5, book, new AbortController().signal);
		expect(getBook).not.toHaveBeenCalled();
		expect(getBookShelves).toHaveBeenCalledWith(5, expect.any(AbortSignal));
		expect(data.book).toBe(book);
		expect(data.offline).toBe(false);
		expect(data.userBook).toEqual(userBook);
		expect(data.progress?.book_file_id).toBe(51);
		expect(data.primaryFile?.id).toBe(51);
		expect(data.shelves?.map((item) => item.id)).toEqual([9, 3]);
	});

	it('fetches the book when the seed is missing, incomplete or for another book', async () => {
		const legacy = { ...book, files: [{ id: 1, format: 'epub', size_bytes: 1, download_url: '' }] } as unknown as Book;
		for (const seed of [undefined, legacy, { ...book, id: 6 }]) {
			vi.mocked(getBook).mockClear();
			const data = await loadQuickView(5, seed, new AbortController().signal);
			expect(getBook).toHaveBeenCalledWith(5);
			expect(data.book.title).toBe('Fetched');
		}
	});

	it('degrades failed per-user state and shelves to null without failing', async () => {
		vi.mocked(getBookState).mockRejectedValue(new ApiError(503, 'Unavailable', ''));
		vi.mocked(getBookShelves).mockRejectedValue(new TypeError('network'));
		const data = await loadQuickView(5, book, new AbortController().signal);
		expect(data).toMatchObject({ userBook: null, progress: null, shelves: null });
		expect(data.primaryFile?.id).toBe(52);
	});

	it('ignores a malformed user_book payload', async () => {
		vi.mocked(getBookState).mockResolvedValue(state({ user_book: { status: 'bogus' } }));
		const data = await loadQuickView(5, book, new AbortController().signal);
		expect(data.userBook).toBeNull();
	});

	it.each([403, 404])('maps a %i book response to not found', async (status) => {
		vi.mocked(getBook).mockRejectedValue(new ApiError(status, 'Denied', ''));
		await expect(loadQuickView(5, undefined, new AbortController().signal))
			.rejects.toBeInstanceOf(QuickViewNotFoundError);
	});

	it('propagates other book failures for the retry state', async () => {
		vi.mocked(getBook).mockRejectedValue(new ApiError(500, 'Server error', ''));
		await expect(loadQuickView(5, undefined, new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
	});

	it('rejects invalid IDs as not found without requests', async () => {
		await expect(loadQuickView(0, undefined, new AbortController().signal))
			.rejects.toBeInstanceOf(QuickViewNotFoundError);
		expect(getBook).not.toHaveBeenCalled();
	});

	it('loads offline from storage and skips the per-user requests', async () => {
		vi.mocked(offlineAvailable).mockReturnValue(true);
		vi.stubGlobal('navigator', { onLine: false });
		vi.mocked(loadOfflineBook).mockResolvedValue({ book: { ...book, title: 'Cached' }, offline: true });
		const data = await loadQuickView(5, book, new AbortController().signal);
		expect(loadOfflineBook).toHaveBeenCalledWith(9, 5);
		expect(getBook).not.toHaveBeenCalled();
		expect(getBookState).not.toHaveBeenCalled();
		expect(getBookShelves).not.toHaveBeenCalled();
		expect(data).toMatchObject({ offline: true, userBook: null, shelves: null });
		expect(data.book.title).toBe('Cached');
	});

	it('maps a book missing from offline storage to not found', async () => {
		vi.mocked(offlineAvailable).mockReturnValue(true);
		vi.stubGlobal('navigator', { onLine: false });
		vi.mocked(loadOfflineBook).mockRejectedValue(new OfflineStorageError('missing'));
		await expect(loadQuickView(5, undefined, new AbortController().signal))
			.rejects.toBeInstanceOf(QuickViewNotFoundError);
	});

	it('rejects when aborted before or during the load', async () => {
		const before = new AbortController();
		before.abort();
		await expect(loadQuickView(5, book, before.signal)).rejects.toMatchObject({ name: 'AbortError' });
		expect(getBookState).not.toHaveBeenCalled();

		const during = new AbortController();
		let release: (value: BookState) => void = () => undefined;
		vi.mocked(getBookState).mockReturnValue(new Promise((resolve) => { release = resolve; }));
		const pending = loadQuickView(5, book, during.signal);
		during.abort();
		release(state());
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(console.warn).not.toHaveBeenCalled();
	});
});

describe('choosePrimaryFile', () => {
	it('uses the progress file when it still exists, else the preferred format', () => {
		expect(choosePrimaryFile(book, progress(53))?.id).toBe(53);
		expect(choosePrimaryFile(book, progress(99))?.id).toBe(52);
		expect(choosePrimaryFile(book, progress(null))?.id).toBe(52);
		expect(choosePrimaryFile(book, null)?.id).toBe(52);
		expect(choosePrimaryFile({ ...book, files: [] }, null)).toBeNull();
	});
});

describe('isCompleteBook and orderCollections', () => {
	it('requires the matching ID and full DTO fields', () => {
		expect(isCompleteBook(book, 5)).toBe(true);
		expect(isCompleteBook(book, 4)).toBe(false);
		expect(isCompleteBook(undefined, 5)).toBe(false);
		expect(isCompleteBook({ ...book, tags: undefined } as unknown as Book, 5)).toBe(false);
	});

	it('puts Favorites first and keeps the server order otherwise', () => {
		const ordered = orderCollections([shelf(1, 'B'), shelf(2, 'A'), shelf(3, 'Fav', 'favorites')]);
		expect(ordered.map((item) => item.id)).toEqual([3, 1, 2]);
	});
});
