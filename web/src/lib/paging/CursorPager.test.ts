import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import type { Page } from '#lib/catalog/types.js';
import { CursorPager } from './CursorPager.svelte.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const page = <T>(items: T[], next_cursor: string | null): Page<T> => ({ items, next_cursor });

describe('CursorPager', () => {
	it('moves from loading to ready and passes the server cursor back verbatim', async () => {
		const cursor = 'opaque/+cursor==';
		const fetcher = vi
			.fn<(cursor: string | null, signal: AbortSignal) => Promise<Page<number>>>()
			.mockResolvedValueOnce(page([1, 2], cursor))
			.mockResolvedValueOnce(page([3], null));
		const pager = new CursorPager<number>();

		const first = pager.reset(fetcher);
		expect(pager.status).toBe('loading');
		await first;
		expect(pager.status).toBe('ready');
		expect(pager.hasMore).toBe(true);

		await pager.loadMore();
		expect(fetcher.mock.calls.map(([value]) => value)).toEqual([null, cursor]);
		expect(pager.items).toEqual([1, 2, 3]);
		expect(pager.ended).toBe(true);
		expect(pager.hasMore).toBe(false);
	});

	it('reports an empty first page distinctly from the end of a populated list', async () => {
		const pager = new CursorPager<number>();
		await pager.reset(async () => page([], null));
		expect(pager.empty).toBe(true);
		expect(pager.ended).toBe(true);
	});

	it('never issues a duplicate request while one is pending', async () => {
		const pending = deferred<Page<number>>();
		const more = deferred<Page<number>>();
		const fetcher = vi.fn((cursor: string | null) => (cursor === null ? pending.promise : more.promise));
		const pager = new CursorPager<number>();

		void pager.reset(fetcher);
		void pager.retry();
		void pager.loadMore();
		expect(fetcher).toHaveBeenCalledTimes(1);

		pending.resolve(page([1], 'next'));
		await pending.promise;
		await Promise.resolve();
		void pager.loadMore();
		void pager.loadMore();
		expect(pager.loadingMore).toBe(true);
		expect(fetcher).toHaveBeenCalledTimes(2);
		more.resolve(page([2], null));
		await pager.loadMore();
		expect(pager.items).toEqual([1, 2]);
	});

	it('discards responses from a superseded query and aborts its request', async () => {
		const stale = deferred<Page<string>>();
		let staleSignal: AbortSignal | undefined;
		const pager = new CursorPager<string>();

		const old = pager.reset((_cursor, signal) => {
			staleSignal = signal;
			return stale.promise;
		});
		await pager.reset(async () => page(['fresh'], null));
		stale.resolve(page(['stale'], 'stale-cursor'));
		await old;

		expect(staleSignal?.aborted).toBe(true);
		expect(pager.items).toEqual(['fresh']);
		expect(pager.nextCursor).toBeNull();
	});

	it('resets pagination state when the source changes or is cleared', async () => {
		const pager = new CursorPager<number>();
		await pager.reset(async () => page([1], 'first-query-cursor'));
		const second = vi.fn(async () => page([9], null));

		await pager.reset(second);
		expect(second).toHaveBeenCalledWith(null, expect.any(AbortSignal));
		expect(pager.items).toEqual([9]);

		await pager.reset(null);
		expect(pager.status).toBe('idle');
		expect(pager.items).toEqual([]);
		expect(pager.nextCursor).toBeNull();
	});

	it('keeps loaded items when a later page fails and restarts after a stale cursor', async () => {
		const stale = new ApiError(400, 'Bad Request', '{}', { status: 400 });
		const fetcher = vi
			.fn<(cursor: string | null) => Promise<Page<number>>>()
			.mockResolvedValueOnce(page([1], 'c1'))
			.mockRejectedValueOnce(stale)
			.mockResolvedValueOnce(page([1, 2], null));
		const pager = new CursorPager<number>();
		await pager.reset(fetcher);

		await pager.loadMore();
		expect(pager.moreError).toBe(stale);
		expect(pager.items).toEqual([1]);
		expect(pager.loadingMore).toBe(false);

		await pager.reload();
		expect(fetcher.mock.calls.at(-1)?.[0]).toBeNull();
		expect(pager.moreError).toBeNull();
		expect(pager.items).toEqual([1, 2]);
	});

	it('exposes first-page failures and recovers on retry', async () => {
		const fetcher = vi
			.fn<() => Promise<Page<number>>>()
			.mockRejectedValueOnce(new TypeError('offline'))
			.mockResolvedValueOnce(page([4], null));
		const pager = new CursorPager<number>();

		await pager.reset(fetcher);
		expect(pager.status).toBe('error');
		expect(pager.error).toBeInstanceOf(TypeError);

		await pager.retry();
		expect(pager.status).toBe('ready');
		expect(pager.error).toBeNull();
		expect(pager.items).toEqual([4]);
	});
});
