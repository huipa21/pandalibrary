import { describe, expect, it, vi } from 'vitest';
import { buildDashboardBooksPath, DASHBOARD_PAGE_SIZE, uniquePages } from './api.js';

describe('dashboard paging', () => {
	it('bounds the feed page and preserves an opaque cursor', () => {
		const path = buildDashboardBooksPath('continue_reading', { cursor: 'opaque/+cursor=' });
		const params = new URLSearchParams(path.split('?')[1]);
		expect(path.startsWith('/dashboard/sections/continue_reading/books?')).toBe(true);
		expect(params.get('limit')).toBe(String(DASHBOARD_PAGE_SIZE));
		expect(params.get('cursor')).toBe('opaque/+cursor=');
	});

	it('deduplicates live results, reports cursor loops, and resets on a new first page', async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce({ items: [{ id: 1 }, { id: 2 }], next_cursor: 'one/+' })
			.mockResolvedValueOnce({ items: [{ id: 2 }, { id: 3 }], next_cursor: 'two=' })
			.mockResolvedValueOnce({ items: [{ id: 4 }], next_cursor: 'two=' })
			.mockResolvedValueOnce({ items: [{ id: 1 }], next_cursor: null });
		const paged = uniquePages<{ id: number }>(fetch);
		const signal = new AbortController().signal;
		expect(await paged(null, signal)).toEqual({ items: [{ id: 1 }, { id: 2 }], next_cursor: 'one/+' });
		expect(await paged('one/+', signal)).toEqual({ items: [{ id: 3 }], next_cursor: 'two=' });
		await expect(paged('two=', signal)).rejects.toThrow('repeated pagination cursor');
		expect(await paged(null, signal)).toEqual({ items: [{ id: 1 }], next_cursor: null });
		expect(fetch.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'one/+', 'two=', null]);
	});

	it('does not publish a page that completed after cancellation', async () => {
		const controller = new AbortController();
		const paged = uniquePages<{ id: number }>(async () => {
			controller.abort();
			return { items: [{ id: 1 }], next_cursor: null };
		});
		await expect(paged(null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	});
});
