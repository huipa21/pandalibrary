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
import { SYNC_SCHEMA } from './types.js';

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
		const store = tx.objectStore('outbox');
		if (stored.entity === 'reading_progress' && stored.op === 'upsert' && 'key' in stored) {
			// Only the latest unsent position per book file matters; older pending positions are superseded.
			const fileId = (stored.data as { book_file_id?: unknown }).book_file_id;
			const queued = await result<OutboxEntry[]>(store.index('account').getAll(IDBKeyRange.only(account)));
			for (const entry of queued) {
				if (entry.status === 'pending' && entry.mutation.entity === 'reading_progress' &&
					entry.mutation.op === 'upsert' && 'key' in entry.mutation && entry.mutation.key === stored.key &&
					(entry.mutation.data as { book_file_id?: unknown }).book_file_id === fileId) {
					await result(store.delete(entry.sequence));
				}
			}
		}
		const sequence = await result(store.add({ account, mutation: stored, status: 'pending' }));
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
			if (!current && entry.mutation.entity === 'reading_progress' && entry.mutation.op === 'upsert') {
				// enqueue() replaced this in-flight position with a newer pending one.
				continue;
			}
			if (!current || current.account !== account) {
				throw new OfflineStorageError('A queued mutation changed while synchronizing.');
			}
			// Keep confirmed writes available for offline replay until their pull is durable.
			await result(store.put({ ...current, status: item.status, reason: item.reason, conflictChecked: false }));
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
				await result(store.put({ ...entry, status: 'pending', reason: undefined, conflictChecked: false }));
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

function equalJson(left: JsonValue, right: JsonValue): boolean {
	if (left === right) return true;
	if (Array.isArray(left)) {
		return Array.isArray(right) && left.length === right.length &&
			left.every((item, index) => equalJson(item, right[index]));
	}
	if (Array.isArray(right) || left === null || right === null ||
		typeof left !== 'object' || typeof right !== 'object') return false;
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length &&
		keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}

function matchesData(
	data: SyncMutation['data'],
	required: Record<string, JsonValue>,
	optional: Record<string, JsonValue> = {}
): boolean {
	return Object.entries(required).every(([key, value]) => Object.hasOwn(data, key) && equalJson(data[key], value)) &&
		Object.keys(data).every((key) => Object.hasOwn(required, key) ||
			(Object.hasOwn(optional, key) && equalJson(data[key], optional[key])));
}

function matchesSavedState(mutation: SyncMutation, row: StoredRow): boolean {
	if (mutation.entity !== row.entity) return false;
	if (mutation.op === 'delete') {
		return (row.entity === 'highlights' || row.entity === 'bookmarks' ||
			row.entity === 'page_annotations' || row.entity === 'notes') && row.value.deleted_at !== null;
	}
	const data = mutation.data;
	switch (row.entity) {
		case 'user_books':
			return matchesData(data, {
				book_id: row.value.book_id, status: row.value.status, rating: row.value.rating,
				started_at: row.value.started_at === null ? null : Date.parse(row.value.started_at),
				finished_at: row.value.finished_at === null ? null : Date.parse(row.value.finished_at)
			});
		case 'reading_progress':
			return matchesData(data, {
				book_id: row.value.book_id, book_file_id: row.value.book_file_id, source: row.value.source,
				locator: row.value.locator, percentage: row.value.percentage, device: row.value.device,
				device_id: row.value.device_id
			});
		case 'user_settings':
			return matchesData(data, { value: row.value.value }, { key: row.value.key });
		case 'highlights':
			return row.value.deleted_at === null && matchesData(data, {
				book_id: row.value.book_id, book_file_id: row.value.book_file_id, locator: row.value.locator,
				position: row.value.position, text: row.value.text, color: row.value.color, chapter: row.value.chapter
			}, { style: row.value.style ?? 'highlight', created_at: Date.parse(row.value.created_at) });
		case 'bookmarks':
			return row.value.deleted_at === null && matchesData(data, {
				book_id: row.value.book_id, book_file_id: row.value.book_file_id, locator: row.value.locator,
				position: row.value.position, label: row.value.label, chapter: row.value.chapter
			}, { created_at: Date.parse(row.value.created_at) });
		case 'page_annotations':
			return row.value.deleted_at === null && matchesData(data, {
				book_id: row.value.book_id, book_file_id: row.value.book_file_id, kind: row.value.kind,
				locator: row.value.locator, position: row.value.position, data: row.value.data
			}, { created_at: Date.parse(row.value.created_at) });
		case 'notes':
			return row.value.deleted_at === null && matchesData(data, {
				book_id: row.value.book_id, highlight_id: row.value.highlight_id, body_md: row.value.body_md
			}, { created_at: Date.parse(row.value.created_at) });
	}
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
		for (const value of response.page_annotations) {
			await result(store.put({ account, entity: 'page_annotations', key: value.id, value } satisfies StoredRow));
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
			// A stale append-only session ID has already been recorded by the server.
			if (entry.status === 'applied' ||
				(entry.status === 'stale' && entry.mutation.entity === 'reading_sessions' && entry.mutation.op === 'upsert')) {
				await result(queue.delete(entry.sequence));
			} else if (entry.status === 'stale' && entry.mutation.entity !== 'reading_sessions') {
				const key = 'id' in entry.mutation ? entry.mutation.id : entry.mutation.key;
				const row = await result<StoredRow | undefined>(store.get([account, entry.mutation.entity, key]));
				// A full pull or a row in this incremental pull verifies the current server state.
				if (row && (full || row.value.rev > expectedCursor) && matchesSavedState(entry.mutation, row)) {
					await result(queue.delete(entry.sequence));
				} else if (full && !entry.conflictChecked) {
					await result(queue.put({ ...entry, conflictChecked: true }));
				}
			}
		}
		await result(meta.put({
			key: cursorKey(account),
			value: { cursor: response.cursor, pulledAt, schema: full ? SYNC_SCHEMA : (previous?.value.schema ?? 1) }
		}));
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
