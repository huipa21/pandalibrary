import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import * as m from '#lib/paraglide/messages.js';
import type { Book } from '#lib/catalog/types.js';

const mocks = vi.hoisted(() => ({
	getBook: vi.fn(),
	getSessionViewer: vi.fn(),
	offlineAvailable: vi.fn(() => false),
	downloadedBooks: vi.fn(async () => [] as { book: { id: number }; fileIds: number[] }[]),
	loadOfflineBook: vi.fn(),
	loadCover: vi.fn()
}));

vi.mock('#lib/catalog/api.js', () => ({ getBook: mocks.getBook }));
vi.mock('#lib/shelves/api.js', () => ({ getSessionViewer: mocks.getSessionViewer }));
vi.mock('#lib/sync/client.js', () => ({ currentAccount: () => 1, offlineAvailable: mocks.offlineAvailable }));
vi.mock('#lib/sync/db.js', () => ({
	downloadedBooks: mocks.downloadedBooks,
	OfflineStorageError: class OfflineStorageError extends Error {}
}));
vi.mock('#lib/sync/library.js', () => ({ loadBook: mocks.loadOfflineBook, loadCover: mocks.loadCover }));

const { BookContext } = await import('./book-context.svelte.js');
const { OfflineStorageError } = await import('#lib/sync/db.js');

function makeBook(id: number, cover_url: string | null = null): Book {
	return { id, title: `Book ${id}`, cover_url } as Book;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

beforeEach(() => {
	mocks.getBook.mockImplementation(async (id: number) => makeBook(id, `/api/v1/books/${id}/cover`));
	mocks.getSessionViewer.mockResolvedValue({ id: 1, username: 'admin', display_name: 'Admin', role: 'admin' });
	mocks.offlineAvailable.mockReturnValue(false);
	mocks.downloadedBooks.mockResolvedValue([]);
});

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe('BookContext', () => {
	it('rejects invalid IDs without a request', async () => {
		const context = new BookContext();
		await context.load('abc');
		expect(context.error).toBe(m['catalog.error.not_found']());
		expect(context.bookId).toBeNull();
		expect(context.loading).toBe(false);
		expect(mocks.getBook).not.toHaveBeenCalled();
	});

	it('loads online once per ID and detects administrators', async () => {
		const context = new BookContext();
		await context.load('21');
		await Promise.resolve();
		expect(context.book?.title).toBe('Book 21');
		expect(context.coverSource).toBe('/api/v1/books/21/cover');
		expect(context.offline).toBe(false);
		expect(context.canEditMetadata).toBe(true);
		await context.load('21');
		expect(mocks.getBook).toHaveBeenCalledTimes(1);
	});

	it('suppresses stale responses', async () => {
		const first = deferred<Book>();
		mocks.getBook.mockImplementationOnce(() => first.promise);
		const context = new BookContext();
		const pending = context.load('1');
		await context.load('2');
		first.resolve(makeBook(1));
		await pending;
		expect(context.book?.id).toBe(2);
		expect(context.bookId).toBe(2);
	});

	it('keeps the book visible during a reload and maps errors', async () => {
		const context = new BookContext();
		await context.load('5');
		const next = deferred<Book>();
		mocks.getBook.mockImplementationOnce(() => next.promise);
		const reloading = context.reload();
		expect(context.book?.id).toBe(5);
		expect(context.loading).toBe(true);
		next.resolve({ ...makeBook(5), title: 'Renamed' });
		await reloading;
		expect(context.book?.title).toBe('Renamed');

		mocks.getBook.mockRejectedValueOnce(new ApiError(404, 'Not Found', ''));
		await context.reload();
		expect(context.book).toBeNull();
		expect(context.error).toBe(m['catalog.error.not_found']());
		mocks.getBook.mockRejectedValueOnce(new TypeError('offline'));
		await context.reload();
		expect(context.error).toBe(m['catalog.error.connection']());
	});

	it('loads offline books with object URL covers and revokes them', async () => {
		mocks.offlineAvailable.mockReturnValue(true);
		mocks.loadOfflineBook.mockImplementation(async (_account: number, id: number) => ({ book: makeBook(id, '/cover'), offline: true }));
		mocks.loadCover.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
		mocks.downloadedBooks.mockResolvedValue([{ book: { id: 7 }, fileIds: [70] }]);
		const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:one').mockReturnValueOnce('blob:two');
		const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
		const context = new BookContext();
		await context.load('7');
		expect(context.offline).toBe(true);
		expect(context.coverSource).toBe('blob:one');
		expect(context.savedFileIds).toEqual([70]);
		expect(context.canEditMetadata).toBe(false);
		await context.reload();
		expect(context.coverSource).toBe('blob:two');
		expect(revoke).toHaveBeenCalledWith('blob:one');
		context.destroy();
		expect(revoke).toHaveBeenCalledWith('blob:two');
		expect(create).toHaveBeenCalledTimes(2);

		mocks.loadOfflineBook.mockRejectedValueOnce(new OfflineStorageError('missing'));
		await context.reload();
		expect(context.error).toBe(m['offline.missing']());
	});

	it('reloads on matching book-state and shelf events only', async () => {
		const target = new EventTarget();
		const context = new BookContext();
		await context.load('3');
		const stop = context.listen(target as unknown as Window);
		target.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 4 } }));
		expect(mocks.getBook).toHaveBeenCalledTimes(1);
		target.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 3 } }));
		target.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
		expect(mocks.getBook).toHaveBeenCalledTimes(3);
		stop();
		target.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
		expect(mocks.getBook).toHaveBeenCalledTimes(3);
	});
});
