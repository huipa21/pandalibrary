import type { Book, BookFile } from '#lib/catalog/types.js';
import type { JsonValue } from '#lib/api/client.js';
import type {
	CursorState,
	DownloadedBook,
	MutationResult,
	OfflineViewer,
	OutboxEntry,
	PullResponse,
	StoredBook,
	StoredFile,
	StoredRow,
	SyncMutation
} from './types.js';

const DATABASE = 'pandalibrary-offline';
const VERSION = 1;
const ACTIVE = 'active-viewer';

interface Metadata<T> {
	key: string;
	value: T;
}

export class OfflineStorageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OfflineStorageError';
	}
}

export class AccountChangedError extends Error {
	constructor() {
		super('The active offline account has changed.');
		this.name = 'AccountChangedError';
	}
}

function openDatabase(): Promise<IDBDatabase> {
	if (typeof indexedDB === 'undefined') {
		return Promise.reject(new OfflineStorageError('IndexedDB is unavailable.'));
	}
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			database.createObjectStore('meta', { keyPath: 'key' });
			database.createObjectStore('books', { keyPath: ['account', 'bookId'] })
				.createIndex('account', 'account');
			database.createObjectStore('files', { keyPath: ['account', 'bookId', 'fileId'] })
				.createIndex('book', ['account', 'bookId']);
			database.createObjectStore('outbox', { keyPath: 'sequence', autoIncrement: true })
				.createIndex('account', 'account');
			database.createObjectStore('rows', { keyPath: ['account', 'entity', 'key'] })
				.createIndex('account', 'account');
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new OfflineStorageError('Could not open offline storage.'));
		request.onblocked = () => reject(new OfflineStorageError('Offline storage is blocked by another tab.'));
	});
}

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new OfflineStorageError('An offline storage request failed.'));
	});
}

async function transaction<T>(
	stores: string[],
	mode: IDBTransactionMode,
	action: (transaction: IDBTransaction) => Promise<T>
): Promise<T> {
	const database = await openDatabase();
	const tx = database.transaction(stores, mode);
	const complete = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new OfflineStorageError('The offline storage transaction was aborted.'));
		tx.onerror = () => { /* onabort reports the transaction failure */ };
	});
	try {
		const value = await action(tx);
		await complete;
		return value;
	} catch (error) {
		try {
			tx.abort();
		} catch (abortError) {
			if (!(abortError instanceof DOMException && abortError.name === 'InvalidStateError')) throw abortError;
		}
		await complete.catch(() => undefined);
		throw error;
	} finally {
		database.close();
	}
}

async function requireAccount(tx: IDBTransaction, account: number): Promise<void> {
	const entry = await result<Metadata<OfflineViewer> | undefined>(tx.objectStore('meta').get(ACTIVE));
	if (!entry || entry.value.id !== account) throw new AccountChangedError();
}

function cursorKey(account: number): string {
	return `cursor:${account}`;
}

export async function activeViewer(): Promise<OfflineViewer | null> {
	return transaction(['meta'], 'readonly', async (tx) => {
		const entry = await result<Metadata<OfflineViewer> | undefined>(tx.objectStore('meta').get(ACTIVE));
		return entry?.value ?? null;
	});
}

export async function setActiveViewer(viewer: OfflineViewer | null): Promise<void> {
	await transaction(['meta'], 'readwrite', async (tx) => {
		if (viewer) {
			if (!Number.isSafeInteger(viewer.id) || viewer.id < 1) throw new AccountChangedError();
			await result(tx.objectStore('meta').put({ key: ACTIVE, value: viewer }));
		} else {
			await result(tx.objectStore('meta').delete(ACTIVE));
		}
	});
}

export async function enqueue(account: number, mutation: SyncMutation): Promise<number> {
	function plain(value: JsonValue): JsonValue {
		if (Array.isArray(value)) return value.map(plain);
		if (value !== null && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
		}
		return value;
	}
	const stored: SyncMutation = {
		...mutation,
		data: Object.fromEntries(Object.entries(mutation.data).map(([key, value]) => [key, plain(value)]))
	};
	return transaction(['meta', 'outbox'], 'readwrite', async (tx) => {
		await requireAccount(tx, account);
		const sequence = await result(tx.objectStore('outbox').add({ account, mutation: stored, status: 'pending' }));
		if (typeof sequence !== 'number') throw new OfflineStorageError('The queued mutation has no sequence.');
		return sequence;
	});
}

export async function outbox(account: number): Promise<OutboxEntry[]> {
	return transaction(['meta', 'outbox'], 'readonly', async (tx) => {
		await requireAccount(tx, account);
		return result<OutboxEntry[]>(tx.objectStore('outbox').index('account').getAll(IDBKeyRange.only(account)));
	});
}

export async function recordResults(
	account: number,
	entries: OutboxEntry[],
	results: MutationResult[]
): Promise<void> {
	await transaction(['meta', 'outbox'], 'readwrite', async (tx) => {
		await requireAccount(tx, account);
		const store = tx.objectStore('outbox');
		for (const item of results) {
			const entry = entries[item.index];
			const current = await result<OutboxEntry | undefined>(store.get(entry.sequence));
			if (!current || current.account !== account) {
				throw new OfflineStorageError('A queued mutation changed while synchronizing.');
			}
			// Keep confirmed writes available for offline replay until their pull is durable.
			await result(store.put({ ...current, status: item.status, reason: item.reason }));
		}
	});
}

export async function retryFailed(account: number): Promise<void> {
	await transaction(['meta', 'outbox'], 'readwrite', async (tx) => {
		await requireAccount(tx, account);
		const store = tx.objectStore('outbox');
		const entries = await result<OutboxEntry[]>(store.index('account').getAll(IDBKeyRange.only(account)));
		for (const entry of entries) {
			if (entry.status === 'stale' || entry.status === 'rejected') {
				await result(store.put({ ...entry, status: 'pending', reason: undefined }));
			}
		}
	});
}

export async function discardMutation(account: number, sequence: number): Promise<void> {
	await transaction(['meta', 'outbox'], 'readwrite', async (tx) => {
		await requireAccount(tx, account);
		const store = tx.objectStore('outbox');
		const entry = await result<OutboxEntry | undefined>(store.get(sequence));
		if (!entry || entry.account !== account) throw new OfflineStorageError('The queued mutation was not found.');
		await result(store.delete(sequence));
	});
}

export async function cursorState(account: number): Promise<CursorState> {
	return transaction(['meta'], 'readonly', async (tx) => {
		await requireAccount(tx, account);
		const entry = await result<Metadata<CursorState> | undefined>(tx.objectStore('meta').get(cursorKey(account)));
		return entry?.value ?? { cursor: 0, pulledAt: 0 };
	});
}

export async function rows(account: number): Promise<StoredRow[]> {
	return transaction(['meta', 'rows'], 'readonly', async (tx) => {
		await requireAccount(tx, account);
		return result<StoredRow[]>(tx.objectStore('rows').index('account').getAll(IDBKeyRange.only(account)));
	});
}

function deleteMatching(index: IDBIndex, key: IDBValidKey): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = index.openCursor(IDBKeyRange.only(key));
		request.onerror = () => reject(request.error ?? new OfflineStorageError('Could not remove offline data.'));
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve();
				return;
			}
			cursor.delete();
			cursor.continue();
		};
	});
}

export async function persistPull(
	account: number,
	expectedCursor: number,
	response: PullResponse,
	full: boolean,
	pulledAt = Date.now()
): Promise<void> {
	await transaction(['meta', 'rows', 'outbox'], 'readwrite', async (tx) => {
		await requireAccount(tx, account);
		const meta = tx.objectStore('meta');
		const previous = await result<Metadata<CursorState> | undefined>(meta.get(cursorKey(account)));
		if ((previous?.value.cursor ?? 0) !== expectedCursor) {
			throw new OfflineStorageError('The pull cursor changed during synchronization.');
		}
		const store = tx.objectStore('rows');
		if (full) await deleteMatching(store.index('account'), account);
		for (const value of response.user_books) {
			await result(store.put({ account, entity: 'user_books', key: String(value.book_id), value } satisfies StoredRow));
		}
		for (const value of response.reading_progress) {
			await result(store.put({ account, entity: 'reading_progress', key: String(value.book_id), value } satisfies StoredRow));
		}
		for (const value of response.highlights) {
			await result(store.put({ account, entity: 'highlights', key: value.id, value } satisfies StoredRow));
		}
		for (const value of response.bookmarks) {
			await result(store.put({ account, entity: 'bookmarks', key: value.id, value } satisfies StoredRow));
		}
		for (const value of response.notes) {
			await result(store.put({ account, entity: 'notes', key: value.id, value } satisfies StoredRow));
		}
		for (const value of response.user_settings) {
			await result(store.put({ account, entity: 'user_settings', key: value.key, value } satisfies StoredRow));
		}
		const queue = tx.objectStore('outbox');
		const entries = await result<OutboxEntry[]>(queue.index('account').getAll(IDBKeyRange.only(account)));
		for (const entry of entries) {
			if (entry.status === 'applied') await result(queue.delete(entry.sequence));
		}
		await result(meta.put({ key: cursorKey(account), value: { cursor: response.cursor, pulledAt } }));
	});
}

export async function saveDownload(
	account: number,
	book: Book,
	file: BookFile,
	blob: Blob,
	cover: Blob | null
): Promise<void> {
	await transaction(['meta', 'books', 'files'], 'readwrite', async (tx) => {
		await requireAccount(tx, account);
		const files = tx.objectStore('files');
		const saved = await result<StoredFile[]>(files.index('book').getAll(IDBKeyRange.only([account, book.id])));
		for (const item of saved) {
			if (!book.files.some((candidate) => candidate.id === item.fileId && candidate.download_url === item.url)) {
				await result(files.delete([account, book.id, item.fileId]));
			}
		}
		await result(tx.objectStore('books').put({ account, bookId: book.id, book, cover } satisfies StoredBook));
		await result(files.put({
			account, bookId: book.id, fileId: file.id, url: file.download_url, blob
		} satisfies StoredFile));
	});
}

export async function downloadedBooks(account: number): Promise<DownloadedBook[]> {
	return transaction(['meta', 'books', 'files'], 'readonly', async (tx) => {
		await requireAccount(tx, account);
		const books = await result<StoredBook[]>(tx.objectStore('books').index('account').getAll(IDBKeyRange.only(account)));
		const files = tx.objectStore('files').index('book');
		const downloaded: DownloadedBook[] = [];
		for (const item of books) {
			const saved = await result<StoredFile[]>(files.getAll(IDBKeyRange.only([account, item.bookId])));
			downloaded.push({
				book: item.book,
				cover: item.cover,
				fileIds: saved.filter((file) =>
					file.blob instanceof Blob &&
					item.book.files.some((candidate) => candidate.id === file.fileId && candidate.download_url === file.url)
				).map((file) => file.fileId)
			});
		}
		return downloaded;
	});
}

export async function downloadedFile(account: number, bookId: number, file: BookFile): Promise<Blob> {
	return transaction(['meta', 'files'], 'readonly', async (tx) => {
		await requireAccount(tx, account);
		const saved = await result<StoredFile | undefined>(tx.objectStore('files').get([account, bookId, file.id]));
		if (!saved || saved.url !== file.download_url || !(saved.blob instanceof Blob)) {
			throw new OfflineStorageError('The downloaded file is missing or no longer matches the book.');
		}
		return saved.blob;
	});
}

export async function removeBook(account: number, bookId: number): Promise<void> {
	await transaction(['meta', 'books', 'files'], 'readwrite', async (tx) => {
		await requireAccount(tx, account);
		await result(tx.objectStore('books').delete([account, bookId]));
		await deleteMatching(tx.objectStore('files').index('book'), [account, bookId]);
	});
}

export async function removeAllBooks(account: number): Promise<void> {
	await transaction(['meta', 'books', 'files'], 'readwrite', async (tx) => {
		await requireAccount(tx, account);
		const books = tx.objectStore('books');
		const all = await result<StoredBook[]>(books.index('account').getAll(IDBKeyRange.only(account)));
		for (const book of all) {
			await result(books.delete([account, book.bookId]));
			await deleteMatching(tx.objectStore('files').index('book'), [account, book.bookId]);
		}
	});
}
