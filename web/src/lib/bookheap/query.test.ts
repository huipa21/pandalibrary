import { describe, expect, it, vi } from 'vitest';
import type { HeapListOptions, HeapPage } from './api.js';
import { fetchHeapPage, heapQueryFromSearch, heapQueryKey, heapQueryToSearch, isFiltered } from './query.js';
import { heapItem } from './test-fixtures.js';

describe('heap query URL sync', () => {
	it('reads status and search from the URL and ignores unknown statuses', () => {
		expect(heapQueryFromSearch(new URLSearchParams('status=duplicate&q=%20dune%20'))).toEqual({ status: 'duplicate', q: 'dune' });
		expect(heapQueryFromSearch(new URLSearchParams('status=active'))).toEqual({ status: 'active', q: '' });
		expect(heapQueryFromSearch(new URLSearchParams('status=bogus'))).toEqual({ status: '', q: '' });
		expect(heapQueryFromSearch(new URLSearchParams(`q=${'x'.repeat(250)}`)).q).toHaveLength(200);
	});

	it('writes non-empty values and keeps unrelated parameters', () => {
		const params = heapQueryToSearch({ status: 'ready', q: ' tolkien ' }, new URLSearchParams('other=1&status=failed'));
		expect(params.get('other')).toBe('1');
		expect(params.get('status')).toBe('ready');
		expect(params.get('q')).toBe('tolkien');
		expect(heapQueryToSearch({ status: '', q: ' ' }, params).toString()).toBe('other=1');
	});

	it('round-trips and keys queries', () => {
		const query = { status: 'invalid', q: 'a b' } as const;
		expect(heapQueryFromSearch(heapQueryToSearch(query))).toEqual(query);
		expect(heapQueryKey({ status: '', q: ' x ' })).toBe(heapQueryKey({ status: '', q: 'x' }));
		expect(isFiltered({ status: '', q: '' })).toBe(false);
		expect(isFiltered({ status: '', q: 'x' })).toBe(true);
	});
});

describe('fetchHeapPage', () => {
	it('passes a single status, search and cursor straight through', async () => {
		const list = vi.fn(async (): Promise<HeapPage> => ({ items: [heapItem(1)], next_cursor: 'n', total: 3 }));
		const page = await fetchHeapPage({ status: 'ready', q: ' dune ' }, 'c1', undefined, list, 10);
		expect(page.total).toBe(3);
		expect(list).toHaveBeenCalledWith({ status: 'ready', q: 'dune', cursor: 'c1', limit: 10, signal: undefined });
	});

	it('merges queued and importing pages for the combined filter until both are exhausted', async () => {
		const pages: Record<string, HeapPage> = {
			'queued:': { items: [heapItem(5, { status: 'queued' }), heapItem(3, { status: 'queued' })], next_cursor: 'q2', total: 3 },
			'importing:': { items: [heapItem(4, { status: 'importing' })], next_cursor: null, total: 1 },
			'queued:q2': { items: [heapItem(1, { status: 'queued' })], next_cursor: null, total: 3 }
		};
		const calls: string[] = [];
		const list = vi.fn(async (options: HeapListOptions) => {
			const key = `${options.status}:${options.cursor ?? ''}`;
			calls.push(key);
			return pages[key];
		});
		const first = await fetchHeapPage({ status: 'active', q: '' }, null, undefined, list, 2);
		expect(first.items.map((item) => item.id)).toEqual([5, 4, 3]);
		expect(first.total).toBe(4);
		expect(first.next_cursor).not.toBeNull();
		const second = await fetchHeapPage({ status: 'active', q: '' }, first.next_cursor, undefined, list, 2);
		expect(second.items.map((item) => item.id)).toEqual([1]);
		expect(second.next_cursor).toBeNull();
		expect(second.total).toBe(4);
		expect(calls).toEqual(['queued:', 'importing:', 'queued:q2']);
	});

	it('rejects a malformed combined cursor', async () => {
		const list = vi.fn();
		await expect(fetchHeapPage({ status: 'active', q: '' }, 'not json', undefined, list)).rejects.toThrow();
		expect(list).not.toHaveBeenCalled();
	});
});
