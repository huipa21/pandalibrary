import { api } from '#lib/api/client.js';
import type { BookState } from '#lib/reader/types.js';
import { currentAccount, offlineAvailable, offlineStatus } from '#lib/sync/client.js';
import { AccountChangedError, outbox, rows } from '#lib/sync/db.js';
import { replayMutations } from '#lib/sync/state.js';
import type { ProgressRow, UserBookRow } from '#lib/sync/types.js';
import { BOOK_STATE_CHANGED_EVENT } from './events.js';
import { READ_STATUSES, type ReadStatus } from './user-book.js';

/** The server rejects larger batches; the store chunks its requests to this size. */
export const BOOK_STATES_BATCH = 100;
const SYNC_WAIT_MS = 1000;
const BATCH_HOLD_MS = 1000;

export interface BookStateItem {
	book_id: number;
	status: ReadStatus;
	percentage: number | null;
	book_file_id: number | null;
	updated_at: string;
}

export interface CoverBookState {
	status: ReadStatus;
	percentage: number | null;
	loading: boolean;
	error: boolean;
}

function readStatus(value: unknown): ReadStatus {
	const status = READ_STATUSES.find((candidate) => candidate === value);
	if (status) return status;
	console.warn('Unknown book-state reading status', value);
	return 'unread';
}

function percentage(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value;
	console.warn('Invalid book-state progress percentage', value);
	return null;
}

function validBookId(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function parseItems(value: unknown): BookStateItem[] {
	if (typeof value !== 'object' || value === null || !('items' in value) || !Array.isArray(value.items)) {
		throw new Error('The book-states response is invalid.');
	}
	const items: BookStateItem[] = [];
	for (const item of value.items as unknown[]) {
		if (typeof item !== 'object' || item === null || !('book_id' in item) || !validBookId(item.book_id)) {
			throw new Error('The book-states response contains an invalid book ID.');
		}
		const record = item as Record<string, unknown>;
		items.push({
			book_id: item.book_id,
			status: readStatus(record.status),
			percentage: percentage(record.percentage),
			book_file_id: validBookId(record.book_file_id) ? record.book_file_id : null,
			updated_at: typeof record.updated_at === 'string' ? record.updated_at : ''
		});
	}
	return items;
}

/** Fetches up to 100 books' status and progress in one request (the raw typed client). */
export async function getBookStates(ids: number[], signal?: AbortSignal): Promise<BookStateItem[]> {
	if (ids.length === 0) return [];
	if (ids.length > BOOK_STATES_BATCH || !ids.every(validBookId)) {
		throw new RangeError('Book-state lookups need 1 to 100 positive book IDs.');
	}
	const response = await api.request<unknown>(`/me/book-states?ids=${ids.join(',')}`, { signal });
	return parseItems(response);
}

type Summary = Omit<CoverBookState, 'loading' | 'error'>;

const UNREAD: Summary = { status: 'unread', percentage: null };

function isOnline(): boolean {
	return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function viewerAccount(): number | null {
	try {
		return currentAccount();
	} catch (error) {
		if (error instanceof AccountChangedError) return null;
		throw error;
	}
}

/** Reads the synchronized rows and replays queued writes, like the reader's offline state. */
async function offlineSummaries(account: number, ids: number[]): Promise<Map<number, Summary>> {
	const [saved, queued] = await Promise.all([rows(account), outbox(account)]);
	const wanted = new Set(ids);
	const userBooks = new Map<number, UserBookRow>();
	const progress = new Map<number, ProgressRow>();
	for (const row of saved) {
		if (row.entity === 'user_books' && wanted.has(row.value.book_id)) userBooks.set(row.value.book_id, row.value);
		if (row.entity === 'reading_progress' && wanted.has(row.value.book_id)) progress.set(row.value.book_id, row.value);
	}
	const relevant = queued.filter(({ mutation }) =>
		(mutation.entity === 'user_books' || mutation.entity === 'reading_progress') &&
		typeof mutation.data.book_id === 'number' && wanted.has(mutation.data.book_id));
	const result = new Map<number, Summary>();
	for (const id of ids) {
		const base: BookState = {
			user_book: userBooks.get(id) ?? null,
			progress: progress.get(id) ?? null,
			highlights: [],
			bookmarks: [],
			notes: []
		};
		const { state } = replayMutations(id, base, [], relevant);
		const userBook = state.user_book;
		const status = typeof userBook === 'object' && userBook !== null && 'status' in userBook
			? readStatus(userBook.status)
			: 'unread';
		result.set(id, { status, percentage: percentage(state.progress?.percentage) });
	}
	return result;
}

class BookStatesStore {
	#account: number | null | undefined = undefined;
	#entries = new Map<number, CoverBookState>();
	#tokens = new Map<number, number>();
	#sequence = 0;
	#pending = new Set<number>();
	#flush: Promise<void> | null = null;
	#controller = new AbortController();
	#listening = false;
	#syncing = false;
	#syncSettled: Promise<void> | null = null;
	#endSync: (() => void) | null = null;
	#batchHolds = new Set<Promise<void>>();

	get(bookId: number): CoverBookState {
		if (!validBookId(bookId)) throw new RangeError('The book-state ID must be a positive integer.');
		this.#listen();
		this.#syncAccount();
		let entry = this.#entries.get(bookId);
		if (!entry) {
			const created = $state<CoverBookState>({ ...UNREAD, loading: true, error: false });
			entry = created;
			this.#entries.set(bookId, entry);
			void this.#schedule([bookId]);
		}
		return entry;
	}

	refresh(ids?: number[]): Promise<void> {
		this.#syncAccount();
		const cached = (ids ?? [...this.#entries.keys()]).filter((id) => this.#entries.has(id) && validBookId(id));
		return cached.length === 0 ? Promise.resolve() : this.#schedule(cached);
	}

	holdBatch(): () => void {
		let resolve!: () => void;
		const pending = new Promise<void>((done) => { resolve = done; });
		this.#batchHolds.add(pending);
		const release = () => {
			if (!this.#batchHolds.delete(pending)) return;
			clearTimeout(timeout);
			resolve();
		};
		const timeout = setTimeout(release, BATCH_HOLD_MS);
		return release;
	}

	/** Drops the cache when the signed-in account changes. */
	#syncAccount(): void {
		const account = viewerAccount();
		if (account === this.#account) return;
		if (this.#account !== undefined) {
			this.#controller.abort();
			this.#controller = new AbortController();
			this.#entries = new Map();
			this.#tokens = new Map();
			this.#pending = new Set();
			this.#flush = null;
		}
		this.#account = account;
	}

	/** Coalesces every request made in the same microtask into one batch. */
	#schedule(ids: number[]): Promise<void> {
		for (const id of ids) this.#pending.add(id);
		const pending = this.#pending;
		this.#flush ??= Promise.resolve().then(async () => {
			if (this.#syncSettled) {
				// Fold a quick sync refresh into the first batch without blocking on a stalled sync.
				let timeout: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					this.#syncSettled,
					new Promise<void>((resolve) => { timeout = setTimeout(resolve, SYNC_WAIT_MS); })
				]);
				if (timeout !== undefined) clearTimeout(timeout);
			}
			const deadline = Date.now() + BATCH_HOLD_MS;
			while (this.#batchHolds.size > 0) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				let timeout: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					Promise.all([...this.#batchHolds]),
					new Promise<void>((resolve) => { timeout = setTimeout(resolve, remaining); })
				]);
				if (timeout !== undefined) clearTimeout(timeout);
			}
			if (pending !== this.#pending) return;
			const batch = [...this.#pending];
			this.#pending = new Set();
			this.#flush = null;
			await this.#load(batch);
		});
		return this.#flush;
	}

	async #load(ids: number[]): Promise<void> {
		if (ids.length === 0) return;
		const account = this.#account ?? null;
		const entries = this.#entries;
		const tokens = this.#tokens;
		const signal = this.#controller.signal;
		const token = ++this.#sequence;
		for (const id of ids) tokens.set(id, token);
		const chunks: number[][] = [];
		for (let index = 0; index < ids.length; index += BOOK_STATES_BATCH) {
			chunks.push(ids.slice(index, index + BOOK_STATES_BATCH));
		}
		await Promise.all(chunks.map(async (chunk) => {
			const summaries = await this.#resolve(account, chunk, signal);
			if (signal.aborted || entries !== this.#entries) return;
			for (const id of chunk) {
				const entry = entries.get(id);
				if (!entry || tokens.get(id) !== token) continue;
				if (summaries === null) {
					entry.loading = false;
					entry.error = true;
					continue;
				}
				const summary = summaries.get(id) ?? UNREAD;
				entry.status = summary.status;
				entry.percentage = summary.percentage;
				entry.loading = false;
				entry.error = false;
			}
		}));
	}

	/** Resolves the summaries of one chunk; books missing from the result are unread. */
	async #resolve(account: number | null, ids: number[], signal: AbortSignal): Promise<Map<number, Summary> | null> {
		const durableAccount = account !== null && offlineAvailable() ? account : null;
		if (isOnline()) {
			try {
				const items = await getBookStates(ids, signal);
				return new Map(items.map((item) => [item.book_id, item]));
			} catch (error) {
				if (signal.aborted) return null;
				console.warn('Could not load book states', error);
				if (!(error instanceof TypeError) || durableAccount === null) return null;
			}
		} else if (durableAccount === null) {
			console.warn('Could not load book states while offline: offline storage is unavailable.');
			return null;
		}
		try {
			return await offlineSummaries(durableAccount, ids);
		} catch (error) {
			console.warn('Could not read offline book states', error);
			return null;
		}
	}

	#listen(): void {
		if (this.#listening || typeof window === 'undefined') return;
		this.#listening = true;
		window.addEventListener(BOOK_STATE_CHANGED_EVENT, (event) => {
			const bookId = (event as CustomEvent<{ bookId?: unknown } | null>).detail?.bookId;
			if (validBookId(bookId)) void this.refresh([bookId]);
		});
		offlineStatus.subscribe((status) => {
			if (status.syncing && !this.#syncing) {
				this.#syncing = true;
				this.#syncSettled = new Promise<void>((resolve) => { this.#endSync = resolve; });
			} else if (!status.syncing && this.#syncing) {
				this.#syncing = false;
				this.#endSync?.();
				this.#endSync = null;
				this.#syncSettled = null;
				if (!status.error) void this.refresh();
			}
		});
		// Without offline storage there is no sync pass, so refresh when the tab comes back.
		window.addEventListener('online', () => {
			if (!offlineAvailable()) void this.refresh();
		});
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', () => {
				if (!document.hidden && !offlineAvailable()) void this.refresh();
			});
		}
	}
}

const store = new BookStatesStore();

/**
 * Returns the reactive status and reading percentage of a book for cover grids.
 * Calls made in the same microtask share one request per 100 IDs; results are
 * cached per account and refreshed on book-state changes and sync completion.
 */
export function bookState(bookId: number): CoverBookState {
	return store.get(bookId);
}

/** Refetches the given cached books, or every cached book when no IDs are given. */
export function refreshBookStates(ids?: number[]): Promise<void> {
	return store.refresh(ids);
}

/** Coalesces independently loaded rows; releases automatically if one stalls. */
export function holdBookStateBatch(): () => void {
	return store.holdBatch();
}
