import { ApiError } from '#lib/api/client.js';
import { getBook, getBookShelves } from '#lib/catalog/api.js';
import type { Book, BookFile } from '#lib/catalog/types.js';
import { getBookState } from '#lib/reader/api.js';
import type { BookState, Progress } from '#lib/reader/types.js';
import type { Shelf } from '#lib/shelves/types.js';
import { currentAccount, offlineAvailable } from '#lib/sync/client.js';
import { OfflineStorageError } from '#lib/sync/db.js';
import { loadBook as loadOfflineBook } from '#lib/sync/library.js';
import { preferredFormat } from '../cover.js';
import { isUserBook, type UserBook } from '../user-book.js';

export interface QuickViewData {
	book: Book;
	/** True when the book came from offline storage; per-user state and shelves are then skipped. */
	offline: boolean;
	userBook: UserBook | null;
	progress: Progress | null;
	/** `null` when the shelves could not be loaded (offline or failed request). */
	shelves: Shelf[] | null;
	primaryFile: BookFile | null;
}

export class QuickViewNotFoundError extends Error {
	constructor() {
		super('The book is unavailable or hidden from the viewer.');
		this.name = 'QuickViewNotFoundError';
	}
}

/** A seed from a list response carries the full `Book` DTO, including the BV1 file fields. */
export function isCompleteBook(seed: Book | undefined, bookId: number): seed is Book {
	if (!seed || seed.id !== bookId) return false;
	const arrays = [seed.authors, seed.tags, seed.identifiers, seed.files, seed.field_sources];
	if (!arrays.every(Array.isArray)) return false;
	if (!('description' in seed) || !('publisher' in seed) || !('published_date' in seed)) return false;
	return seed.files.every((file) => typeof file.original_filename === 'string' && typeof file.created_at === 'string');
}

/** The file the saved progress points at when it still exists, else the preferred-format file. */
export function choosePrimaryFile(book: Book, progress: Progress | null): BookFile | null {
	if (progress?.book_file_id != null) {
		const saved = book.files.find((file) => file.id === progress.book_file_id);
		if (saved) return saved;
	}
	const format = preferredFormat(book.files);
	if (format === null) return null;
	return book.files.find((file) => file.format.trim().toLowerCase() === format) ?? null;
}

/** Favorites first; the server order (name, then ID) is otherwise preserved. */
export function orderCollections(shelves: readonly Shelf[]): Shelf[] {
	return [...shelves].sort((left, right) =>
		Number(right.system_key === 'favorites') - Number(left.system_key === 'favorites'));
}

function isOffline(): boolean {
	return offlineAvailable() && typeof navigator !== 'undefined' && !navigator.onLine;
}

function aborted(signal: AbortSignal, error: unknown): boolean {
	return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

async function loadBookRecord(bookId: number, seed: Book | undefined, offline: boolean): Promise<Book> {
	try {
		if (offline) return (await loadOfflineBook(currentAccount(), bookId)).book;
		if (isCompleteBook(seed, bookId)) return seed;
		return await getBook(bookId);
	} catch (error) {
		if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
			throw new QuickViewNotFoundError();
		}
		if (error instanceof OfflineStorageError) throw new QuickViewNotFoundError();
		throw error;
	}
}

async function loadState(bookId: number, signal: AbortSignal): Promise<BookState | null> {
	try {
		return await getBookState(bookId);
	} catch (error) {
		if (!aborted(signal, error)) console.warn('Could not load the reading state for the quick view', error);
		return null;
	}
}

async function loadShelves(bookId: number, signal: AbortSignal): Promise<Shelf[] | null> {
	try {
		return orderCollections(await getBookShelves(bookId, signal));
	} catch (error) {
		if (!aborted(signal, error)) console.warn('Could not load the shelves for the quick view', error);
		return null;
	}
}

/**
 * Loads everything the quick view shows in parallel. Missing per-user state degrades to `null`;
 * a hidden or missing book rejects with `QuickViewNotFoundError`; an abort rejects with the
 * signal's reason so stale responses are never applied.
 */
export async function loadQuickView(bookId: number, seed: Book | undefined, signal: AbortSignal): Promise<QuickViewData> {
	signal.throwIfAborted();
	if (!Number.isSafeInteger(bookId) || bookId < 1) throw new QuickViewNotFoundError();
	const offline = isOffline();
	const [book, state, shelves] = await Promise.all([
		loadBookRecord(bookId, seed, offline),
		offline ? Promise.resolve(null) : loadState(bookId, signal),
		offline ? Promise.resolve(null) : loadShelves(bookId, signal)
	]);
	signal.throwIfAborted();
	const progress = state?.progress ?? null;
	return {
		book,
		offline,
		userBook: isUserBook(state?.user_book) ? state.user_book : null,
		progress,
		shelves,
		primaryFile: choosePrimaryFile(book, progress)
	};
}
