import { ApiError } from '#lib/api/client.js';
import { getBook } from '#lib/catalog/api.js';
import type { Book, BookFile } from '#lib/catalog/types.js';
import { downloadBookFile, getBookState, getSettings, validatedBookFileUrl } from '#lib/reader/api.js';
import type { BookState, Setting } from '#lib/reader/types.js';
import { downloadedBooks, downloadedFile, OfflineStorageError, removeBook, saveDownload } from './db.js';
import { synchronize } from './engine.js';
import { readerState } from './state.js';

function isOffline(): boolean {
	return typeof navigator !== 'undefined' && !navigator.onLine;
}

function networkFailure(error: unknown): boolean {
	return error instanceof TypeError;
}

async function evictOnDenial(account: number, bookId: number, error: unknown): Promise<void> {
	if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
		await removeBook(account, bookId);
	}
}

export async function cachedBook(account: number, bookId: number): Promise<Book> {
	const cached = (await downloadedBooks(account)).find((item) => item.book.id === bookId);
	if (!cached || cached.fileIds.length === 0) {
		throw new OfflineStorageError('This book is not available in offline storage.');
	}
	return { ...cached.book, files: cached.book.files.filter((file) => cached.fileIds.includes(file.id)) };
}

export async function loadBook(
	account: number,
	bookId: number
): Promise<{ book: Book; offline: boolean }> {
	if (isOffline()) return { book: await cachedBook(account, bookId), offline: true };
	try {
		return { book: await getBook(bookId), offline: false };
	} catch (error) {
		await evictOnDenial(account, bookId, error);
		if (networkFailure(error)) return { book: await cachedBook(account, bookId), offline: true };
		throw error;
	}
}

export async function loadFile(
	account: number,
	bookId: number,
	file: BookFile,
	offline: boolean
): Promise<Blob> {
	validatedBookFileUrl(bookId, file, window.location.origin);
	if (offline || isOffline()) return downloadedFile(account, bookId, file);
	try {
		return await downloadBookFile(bookId, file);
	} catch (error) {
		await evictOnDenial(account, bookId, error);
		if (networkFailure(error)) return downloadedFile(account, bookId, file);
		throw error;
	}
}

export async function loadReaderState(
	account: number,
	bookId: number,
	offline: boolean
): Promise<{ state: BookState; settings: Setting[] }> {
	if (offline || isOffline()) return readerState(account, bookId);
	try {
		const [state, settings] = await Promise.all([getBookState(bookId), getSettings()]);
		return readerState(account, bookId, { state, settings });
	} catch (error) {
		await evictOnDenial(account, bookId, error);
		if (networkFailure(error)) {
			await cachedBook(account, bookId);
			return readerState(account, bookId);
		}
		throw error;
	}
}

function coverUrl(book: Book, origin: string): URL | null {
	if (!book.cover_url) return null;
	let url: URL;
	try {
		url = new URL(book.cover_url, origin);
	} catch {
		throw new OfflineStorageError('The catalog returned an invalid cover URL.');
	}
	if (url.origin !== origin || url.pathname !== `/api/v1/books/${book.id}/cover` ||
		url.username !== '' || url.password !== '') {
		throw new OfflineStorageError('The catalog returned an invalid cover URL.');
	}
	return url;
}

export async function loadCover(account: number, book: Book, offline: boolean): Promise<Blob | null> {
	if (!book.cover_url) return null;
	if (offline || isOffline()) {
		const cached = (await downloadedBooks(account)).find((item) => item.book.id === book.id);
		if (!cached || !cached.cover) throw new OfflineStorageError('The downloaded cover is missing.');
		return cached.cover;
	}
	const url = coverUrl(book, window.location.origin);
	if (!url) return null;
	try {
		const response = await fetch(url.href, { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
		if (!response.ok) throw new ApiError(response.status, response.statusText, await response.text());
		return await response.blob();
	} catch (error) {
		await evictOnDenial(account, book.id, error);
		if (networkFailure(error)) {
			const cached = (await downloadedBooks(account)).find((item) => item.book.id === book.id);
			if (cached?.cover) return cached.cover;
		}
		throw error;
	}
}

export async function downloadForOffline(account: number, book: Book, file: BookFile): Promise<void> {
	if (isOffline()) throw new OfflineStorageError('A network connection is required to download a book.');
	if (!book.files.some((item) => item.id === file.id && item.download_url === file.download_url)) {
		throw new OfflineStorageError('The selected file is not in this book.');
	}
	try {
		const [blob, cover] = await Promise.all([
			downloadBookFile(book.id, file),
			loadCover(account, book, false)
		]);
		await synchronize(account);
		await saveDownload(account, book, file, blob, cover);
		if (navigator.storage?.persist) await navigator.storage.persist();
	} catch (error) {
		await evictOnDenial(account, book.id, error);
		throw error;
	}
}
