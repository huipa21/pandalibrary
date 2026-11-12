import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxEntry, StoredRow } from '#lib/sync/types.js';

interface Status { syncing: boolean; error: boolean }

const mocks = vi.hoisted(() => {
	class AccountChangedError extends Error {}
	let status: Status = { syncing: false, error: false };
	const subscribers = new Set<(value: Status) => void>();
	return {
		request: vi.fn(),
		AccountChangedError,
		account: { current: 1 as number | null },
		offlineAvailable: vi.fn(() => false),
		rows: vi.fn(async (): Promise<StoredRow[]> => []),
		outbox: vi.fn(async (): Promise<OutboxEntry[]> => []),
		offlineStatus: {
			subscribe(run: (value: Status) => void) {
				subscribers.add(run);
				run(status);
				return () => subscribers.delete(run);
			},
			set(value: Status) {
				status = value;
				for (const run of subscribers) run(value);
			},
			reset() {
				subscribers.clear();
				status = { syncing: false, error: false };
			}
		}
	};
});

vi.mock('#lib/api/client.js', () => ({
	api: { request: mocks.request },
	ApiError: class ApiError extends Error {
		constructor(readonly status: number) {
			super(`HTTP ${status}`);
		}
	}
}));
vi.mock('#lib/sync/client.js', () => ({
	currentAccount: () => {
		if (mocks.account.current === null) throw new mocks.AccountChangedError('signed out');
		return mocks.account.current;
	},
	offlineAvailable: mocks.offlineAvailable,
	offlineStatus: mocks.offlineStatus
}));
vi.mock('#lib/sync/db.js', () => ({
	rows: mocks.rows,
	outbox: mocks.outbox,
	AccountChangedError: mocks.AccountChangedError,
	OfflineStorageError: class OfflineStorageError extends Error {}
}));

type Item = { book_id: number; status: string; percentage: number | null };

function idsOf(path: string): number[] {
	const match = /^\/me\/book-states\?ids=([\d,]+)$/.exec(path);
	if (!match) throw new Error(`unexpected path ${path}`);
	return match[1].split(',').map(Number);
}

function respond(items: (id: number) => Item | null) {
	mocks.request.mockImplementation(async (path: string) => ({
		items: idsOf(path).map(items).filter((item) => item !== null)
	}));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

async function settle() {
	for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let store: typeof import('./book-states.svelte.js');
let online = true;

beforeEach(async () => {
	vi.resetModules();
	online = true;
	mocks.account.current = 1;
	mocks.offlineAvailable.mockReturnValue(false);
	mocks.offlineStatus.reset();
	mocks.rows.mockResolvedValue([]);
	mocks.outbox.mockResolvedValue([]);
	vi.stubGlobal('window', new EventTarget());
	vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
	vi.stubGlobal('navigator', { get onLine() { return online; } });
	respond((id) => (id % 2 === 1 ? { book_id: id, status: 'reading', percentage: id / 1000 } : null));
	store = await import('./book-states.svelte.js');
});

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('bookState', () => {
	it('coalesces calls from the same microtask into one request', async () => {
		const states = [1, 2, 3].map((id) => store.bookState(id));
		expect(states.every((state) => state.loading)).toBe(true);
		expect(store.bookState(1)).toBe(states[0]);
		await settle();
		expect(mocks.request).toHaveBeenCalledTimes(1);
		expect(mocks.request.mock.calls[0][0]).toBe('/me/book-states?ids=1,2,3');
		expect(states.map(({ status, percentage, loading }) => ({ status, percentage, loading }))).toEqual([
			{ status: 'reading', percentage: 0.001, loading: false },
			{ status: 'unread', percentage: null, loading: false },
			{ status: 'reading', percentage: 0.003, loading: false }
		]);
		store.bookState(1);
		await settle();
		expect(mocks.request).toHaveBeenCalledTimes(1);
	});

	it('uses one request for a page of 50 covers and chunks at 100 IDs', async () => {
		for (let id = 1; id <= 50; id += 1) store.bookState(id);
		await settle();
		expect(mocks.request).toHaveBeenCalledTimes(1);
		for (let id = 51; id <= 200; id += 1) store.bookState(id);
		store.bookState(201);
		await settle();
		const sizes = mocks.request.mock.calls.slice(1).map(([path]) => idsOf(path as string).length);
		expect(sizes).toEqual([100, 51]);
	});

	it('coalesces independently rendered dashboard rows until all loads settle', async () => {
		const releaseFirst = store.holdBookStateBatch();
		const releaseSecond = store.holdBookStateBatch();
		const first = store.bookState(1);
		await settle();
		expect(mocks.request).not.toHaveBeenCalled();
		releaseFirst();
		const second = store.bookState(2);
		await settle();
		expect(mocks.request).not.toHaveBeenCalled();
		releaseSecond();
		await settle();
		expect(mocks.request).toHaveBeenCalledTimes(1);
		expect(mocks.request.mock.calls[0][0]).toBe('/me/book-states?ids=1,2');
		expect(first.loading || second.loading).toBe(false);
	});

	it('releases a stalled row hold after a bounded wait', async () => {
		vi.useFakeTimers();
		const release = store.holdBookStateBatch();
		const state = store.bookState(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(mocks.request).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(mocks.request).toHaveBeenCalledTimes(1);
		expect(state).toMatchObject({ status: 'reading', loading: false, error: false });
		release();
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.request).toHaveBeenCalledTimes(1);
	});

	it('bounds the batch wait even when another row starts later', async () => {
		vi.useFakeTimers();
		const releaseFirst = store.holdBookStateBatch();
		const state = store.bookState(1);
		await vi.advanceTimersByTimeAsync(500);
		const releaseSecond = store.holdBookStateBatch();
		await vi.advanceTimersByTimeAsync(500);
		expect(mocks.request).toHaveBeenCalledTimes(1);
		expect(state.loading).toBe(false);
		releaseFirst();
		releaseSecond();
	});

	it('discards held requests from a previous account', async () => {
		const release = store.holdBookStateBatch();
		const previous = store.bookState(1);
		await settle();
		mocks.account.current = 2;
		const current = store.bookState(2);
		release();
		await settle();
		expect(mocks.request).toHaveBeenCalledTimes(1);
		expect(mocks.request.mock.calls[0][0]).toBe('/me/book-states?ids=2');
		expect(current.loading).toBe(false);
		expect(previous.loading).toBe(true);
	});

	it('coalesces the initial page request with a synchronization already in progress', async () => {
		mocks.offlineStatus.set({ syncing: true, error: false });
		const states = [1, 2, 3].map((id) => store.bookState(id));
		await settle();
		expect(states.every((state) => state.loading)).toBe(true);
		expect(mocks.request).not.toHaveBeenCalled();

		mocks.offlineStatus.set({ syncing: false, error: false });
		await settle();
		expect(mocks.request).toHaveBeenCalledTimes(1);
		expect(mocks.request.mock.calls[0][0]).toBe('/me/book-states?ids=1,2,3');
		expect(states.every((state) => !state.loading && !state.error)).toBe(true);
	});

	it('loads after a bounded wait if synchronization takes too long', async () => {
		vi.useFakeTimers();
		mocks.offlineStatus.set({ syncing: true, error: false });
		const state = store.bookState(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.request).toHaveBeenCalledTimes(1);
		expect(state).toMatchObject({ status: 'reading', loading: false, error: false });
		mocks.offlineStatus.set({ syncing: false, error: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.request).toHaveBeenCalledTimes(2);
	});

	it('discards a pending batch when the account changes during synchronization', async () => {
		mocks.offlineStatus.set({ syncing: true, error: false });
		const previous = store.bookState(1);
		mocks.account.current = 2;
		respond((id) => ({ book_id: id, status: 'on_hold', percentage: 0.42 }));
		const current = store.bookState(1);
		expect(current).not.toBe(previous);
		mocks.offlineStatus.set({ syncing: false, error: false });
		await settle();
		expect(mocks.request).toHaveBeenCalledTimes(1);
		expect(current).toMatchObject({ status: 'on_hold', percentage: 0.42, loading: false });
		expect(previous.loading).toBe(true);
	});

	it('treats unknown statuses and invalid percentages as unread and no progress', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		respond((id) => ({ book_id: id, status: 'mystery', percentage: 7 }));
		const state = store.bookState(9);
		await settle();
		expect(state).toMatchObject({ status: 'unread', percentage: null, loading: false });
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it('reports malformed IDs instead of treating an invalid response as unread', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		mocks.request.mockResolvedValue({ items: [{ book_id: 0, status: 'reading', percentage: 0.4 }] });
		const state = store.bookState(9);
		await settle();
		expect(state).toMatchObject({ loading: false, error: true });
		expect(warn).toHaveBeenCalled();
		expect(() => store.bookState(0)).toThrow(RangeError);
	});

	it('refreshes one book on a book-state change and everything after a sync', async () => {
		const first = store.bookState(1);
		const second = store.bookState(2);
		await settle();
		respond((id) => ({ book_id: id, status: 'finished', percentage: 1 }));
		window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 2 } }));
		await settle();
		expect(mocks.request).toHaveBeenLastCalledWith('/me/book-states?ids=2', expect.anything());
		expect(second.status).toBe('finished');
		expect(first.status).toBe('reading');

		mocks.offlineStatus.set({ syncing: true, error: false });
		mocks.offlineStatus.set({ syncing: false, error: false });
		await settle();
		expect(mocks.request).toHaveBeenLastCalledWith('/me/book-states?ids=1,2', expect.anything());
		expect(first).toMatchObject({ status: 'finished', percentage: 1 });
		expect(mocks.request).toHaveBeenCalledTimes(3);
	});

	it('refreshes on return to the tab only without offline storage', async () => {
		store.bookState(1);
		await settle();
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(mocks.request).toHaveBeenCalledTimes(2);
		mocks.offlineAvailable.mockReturnValue(true);
		window.dispatchEvent(new Event('online'));
		await settle();
		expect(mocks.request).toHaveBeenCalledTimes(2);
	});

	it('clears the cache when the account changes', async () => {
		const before = store.bookState(1);
		await settle();
		mocks.account.current = 2;
		respond((id) => ({ book_id: id, status: 'abandoned', percentage: null }));
		const after = store.bookState(1);
		expect(after).not.toBe(before);
		expect(after.loading).toBe(true);
		await settle();
		expect(after.status).toBe('abandoned');
		expect(before.status).toBe('reading');
		expect(mocks.request).toHaveBeenCalledTimes(2);
	});

	it('drops stale responses', async () => {
		const slow = deferred<unknown>();
		mocks.request.mockImplementationOnce(() => slow.promise);
		const state = store.bookState(5);
		await settle();
		respond((id) => ({ book_id: id, status: 'finished', percentage: 1 }));
		await store.refreshBookStates([5]);
		expect(state.status).toBe('finished');
		slow.resolve({ items: [{ book_id: 5, status: 'reading', percentage: 0.2 }] });
		await settle();
		expect(state).toMatchObject({ status: 'finished', percentage: 1, loading: false });
	});

	it('resolves offline from synchronized rows with queued writes replayed', async () => {
		online = false;
		mocks.offlineAvailable.mockReturnValue(true);
		mocks.rows.mockResolvedValue([
			{ account: 1, entity: 'user_books', key: '1', value: {
				book_id: 1, status: 'reading', rating: null, started_at: null, finished_at: null,
				updated_at: '2026-01-01T00:00:00Z', rev: 3
			} },
			{ account: 1, entity: 'reading_progress', key: '1', value: {
				book_id: 1, book_file_id: 7, source: 'web', locator: null, percentage: 0.3,
				device: '', device_id: '', updated_at: '2026-01-01T00:00:00Z', rev: 4
			} },
			{ account: 1, entity: 'user_books', key: '2', value: {
				book_id: 2, status: 'want_to_read', rating: null, started_at: null, finished_at: null,
				updated_at: '2026-01-01T00:00:00Z', rev: 5
			} }
		]);
		mocks.outbox.mockResolvedValue([
			{ sequence: 1, account: 1, status: 'pending', mutation: {
				entity: 'user_books', key: '1', op: 'upsert', updated_at: Date.UTC(2026, 1, 1),
				data: { book_id: 1, status: 'finished', rating: null, started_at: null, finished_at: null }
			} },
			{ sequence: 2, account: 1, status: 'rejected', mutation: {
				entity: 'user_books', key: '2', op: 'upsert', updated_at: Date.UTC(2026, 1, 1),
				data: { book_id: 2, status: 'abandoned', rating: null, started_at: null, finished_at: null }
			} }
		]);
		const states = [1, 2, 3].map((id) => store.bookState(id));
		await settle();
		expect(mocks.request).not.toHaveBeenCalled();
		expect(states.map(({ status, percentage }) => ({ status, percentage }))).toEqual([
			{ status: 'finished', percentage: 1 },
			{ status: 'want_to_read', percentage: null },
			{ status: 'unread', percentage: null }
		]);
		expect(mocks.rows).toHaveBeenCalledWith(1);
	});

	it('falls back to offline rows when the network request fails', async () => {
		mocks.offlineAvailable.mockReturnValue(true);
		mocks.request.mockRejectedValue(new TypeError('Failed to fetch'));
		mocks.rows.mockResolvedValue([{ account: 1, entity: 'reading_progress', key: '4', value: {
			book_id: 4, book_file_id: null, source: 'koreader', locator: null, percentage: 0.5,
			device: '', device_id: '', updated_at: '2026-01-01T00:00:00Z', rev: 1
		} }]);
		const state = store.bookState(4);
		await settle();
		expect(state).toMatchObject({ status: 'unread', percentage: 0.5, loading: false });
	});

	it('shows reading for queued first progress on an unread book offline', async () => {
		online = false;
		mocks.offlineAvailable.mockReturnValue(true);
		mocks.rows.mockResolvedValue([{ account: 1, entity: 'user_books', key: '1', value: {
			book_id: 1, status: 'unread', rating: null, started_at: null, finished_at: null,
			updated_at: '2026-01-01T00:00:00Z', rev: 1
		} }]);
		mocks.outbox.mockResolvedValue([{ sequence: 1, account: 1, status: 'pending', mutation: {
			entity: 'reading_progress', key: '1', op: 'upsert', updated_at: Date.UTC(2026, 1, 1),
			data: { book_id: 1, book_file_id: null, source: 'web', percentage: 0.4,
				locator: null, device: '', device_id: '' }
		} }]);
		const state = store.bookState(1);
		await settle();
		expect(state).toMatchObject({ status: 'reading', percentage: 0.4, loading: false, error: false });
		expect(mocks.request).not.toHaveBeenCalled();
	});

	it('reports unavailable state instead of claiming unread when offline without storage', async () => {
		online = false;
		const warn = vi.spyOn(console, 'warn');
		const state = store.bookState(1);
		await settle();
		expect(state).toMatchObject({ loading: false, error: true });
		expect(mocks.request).not.toHaveBeenCalled();
		expect(mocks.rows).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});

	it('keeps the previous state on request failure and clears the error after a successful refresh', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const state = store.bookState(1);
		await settle();
		mocks.request.mockRejectedValue(new Error('Unavailable'));
		await store.refreshBookStates([1]);
		expect(state).toMatchObject({ status: 'reading', percentage: 0.001, loading: false, error: true });
		expect(warn).toHaveBeenCalled();

		respond((id) => ({ book_id: id, status: 'on_hold', percentage: 0.42 }));
		await store.refreshBookStates([1]);
		expect(state).toMatchObject({ status: 'on_hold', percentage: 0.42, loading: false, error: false });
	});
});

describe('getBookStates', () => {
	it('validates the batch before requesting', async () => {
		await expect(store.getBookStates([])).resolves.toEqual([]);
		await expect(store.getBookStates([0])).rejects.toThrow(RangeError);
		await expect(store.getBookStates(Array.from({ length: 101 }, (_, i) => i + 1))).rejects.toThrow(RangeError);
		expect(mocks.request).not.toHaveBeenCalled();
		const signal = new AbortController().signal;
		await expect(store.getBookStates([1, 3], signal)).resolves.toMatchObject([
			{ book_id: 1, status: 'reading' }, { book_id: 3, status: 'reading' }
		]);
		expect(mocks.request).toHaveBeenCalledWith('/me/book-states?ids=1,3', { signal });
	});
});
