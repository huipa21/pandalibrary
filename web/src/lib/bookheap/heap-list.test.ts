import { describe, expect, it, vi } from 'vitest';
import type { HeapPage } from './api.js';
import { HeapList } from './heap-list.svelte.js';
import { heapItem } from './test-fixtures.js';

function pagedFetcher(pages: Record<string, HeapPage>) {
	return vi.fn(async (cursor: string | null) => {
		const page = pages[cursor ?? ''];
		if (!page) throw new Error(`unexpected cursor ${cursor}`);
		return page;
	});
}

describe('HeapList', () => {
	it('loads the first page, then more pages without duplicates', async () => {
		const list = new HeapList();
		const fetcher = pagedFetcher({
			'': { items: [heapItem(3), heapItem(2)], next_cursor: 'c2', total: 3 },
			c2: { items: [heapItem(2), heapItem(1)], next_cursor: null, total: 3 }
		});
		await list.reset(fetcher);
		expect(list.status).toBe('ready');
		expect(list.hasMore).toBe(true);
		await list.loadMore();
		expect(list.items.map((item) => item.id)).toEqual([3, 2, 1]);
		expect(list.ended).toBe(true);
		expect(list.total).toBe(3);
	});

	it('keeps the list and reports failed Load more separately', async () => {
		const list = new HeapList();
		const fetcher = vi.fn(async (cursor: string | null): Promise<HeapPage> => {
			if (cursor) throw new Error('stale');
			return { items: [heapItem(1)], next_cursor: 'c2', total: 2 };
		});
		await list.reset(fetcher);
		await list.loadMore();
		expect(list.items).toHaveLength(1);
		expect(list.moreError).toBeInstanceOf(Error);
		expect(list.status).toBe('ready');
	});

	it('reports first-page errors and recovers on retry', async () => {
		const list = new HeapList();
		let fail = true;
		const fetcher = vi.fn(async (): Promise<HeapPage> => {
			if (fail) throw new Error('down');
			return { items: [], next_cursor: null, total: 0 };
		});
		await list.reset(fetcher);
		expect(list.status).toBe('error');
		fail = false;
		await list.retry();
		expect(list.empty).toBe(true);
	});

	it('refreshes the pages already shown in place and tells whether it reached the end', async () => {
		const list = new HeapList();
		const pages: Record<string, HeapPage> = {
			'': { items: [heapItem(3, { status: 'queued' }), heapItem(2)], next_cursor: 'c2', total: 3 },
			c2: { items: [heapItem(1)], next_cursor: null, total: 3 }
		};
		const fetcher = pagedFetcher(pages);
		await list.reset(fetcher);
		await list.loadMore();
		expect(list.hasActive).toBe(true);
		pages[''] = { items: [heapItem(2)], next_cursor: 'c2', total: 2 };
		pages.c2 = { items: [heapItem(1)], next_cursor: null, total: 2 };
		await expect(list.refresh()).resolves.toBe(true);
		expect(list.items.map((item) => item.id)).toEqual([2, 1]);
		expect(list.total).toBe(2);
		expect(list.hasActive).toBe(false);
	});

	it('keeps the current list when a refresh fails', async () => {
		const list = new HeapList();
		let fail = false;
		const fetcher = vi.fn(async (): Promise<HeapPage> => {
			if (fail) throw new Error('down');
			return { items: [heapItem(1)], next_cursor: null, total: 1 };
		});
		await list.reset(fetcher);
		fail = true;
		await expect(list.refresh()).resolves.toBe(false);
		expect(list.items.map((item) => item.id)).toEqual([1]);
		expect(list.refreshing).toBe(false);
	});

	it('discards responses superseded by a reset', async () => {
		const list = new HeapList();
		let resolveOld: (page: HeapPage) => void = () => {};
		const slow = vi.fn(() => new Promise<HeapPage>((resolve) => (resolveOld = resolve)));
		const pending = list.reset(slow);
		await list.reset(async () => ({ items: [heapItem(9)], next_cursor: null, total: 1 }));
		resolveOld({ items: [heapItem(1)], next_cursor: null, total: 1 });
		await pending;
		expect(list.items.map((item) => item.id)).toEqual([9]);
	});
});
