import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import {
	createHistoryCache,
	formatHistoryDuration,
	HISTORY_CACHE_MAX_PAGES,
	HISTORY_CACHE_TTL_MS,
	type HistoryPage
} from './history.js';

function page(title = 'A book'): HistoryPage {
	return {
		year: 2026,
		timezone: 'UTC',
		items: [{
			date: '2026-01-02', book_id: 7, title, authors: ['Author'], cover_url: null,
			cycle: 1, active_seconds: 123, session_count: 2, day_active_seconds: 123, day_session_count: 2
		}],
		next_cursor: 'next/+?=',
		summary: {
			books: 1, active_seconds: 123, session_count: 2, active_days: 1,
			months: Array.from({ length: 12 }, (_, index) => ({
				month: `2026-${String(index + 1).padStart(2, '0')}`,
				books: index === 0 ? 1 : 0, active_seconds: index === 0 ? 123 : 0,
				session_count: index === 0 ? 2 : 0
			})),
			records: {
				busiest_day: { date: '2026-01-02', active_seconds: 123, session_count: 2 },
				longest_session_seconds: 100,
				most_read_book: { book_id: 7, title, session_count: 2 }
			}
		}
	};
}

function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() { return values.size; },
		clear: vi.fn(() => values.clear()),
		getItem: vi.fn((key: string) => values.get(key) ?? null),
		key: vi.fn((index: number) => [...values.keys()][index] ?? null),
		removeItem: vi.fn((key: string) => { values.delete(key); }),
		setItem: vi.fn((key: string, value: string) => { values.set(key, value); })
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

let store: Storage;

beforeEach(() => {
	store = memoryStorage();
	vi.stubGlobal('window', { sessionStorage: store });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('history duration', () => {
	it('uses whole hours and zero-padded minutes without a 24-hour wrap', () => {
		expect(formatHistoryDuration(0)).toBe('0 h 00 m');
		expect(formatHistoryDuration(59)).toBe('0 h 00 m');
		expect(formatHistoryDuration(60)).toBe('0 h 01 m');
		expect(formatHistoryDuration(3725.5)).toBe('1 h 02 m');
		expect(formatHistoryDuration(360000 + 59 * 60)).toBe('100 h 59 m');
		expect(formatHistoryDuration(-1)).toBe('0 h 00 m');
		expect(formatHistoryDuration(NaN)).toBe('0 h 00 m');
		expect(formatHistoryDuration(Infinity)).toBe('0 h 00 m');
	});
});

describe('history page cache', () => {
	it('uses the API client with limit 50 and reuses pages across navigation', async () => {
		const result = page();
		const request = vi.spyOn(api, 'request').mockResolvedValue(result);
		const cache = createHistoryCache(1);
		expect(await cache.load(2026, 'America/New_York')).toEqual(result);
		expect(await cache.load(2026, 'America/New_York', null)).toEqual(result);
		expect(await createHistoryCache(1).load(2026, 'America/New_York')).toEqual(result);
		expect(request).toHaveBeenCalledExactlyOnceWith(
			'/stats/history?year=2026&timezone=America%2FNew_York&limit=50',
			{ method: 'GET', signal: expect.any(AbortSignal), cache: 'no-store' }
		);
	});

	it('separates cursor, year and timezone and preserves opaque cursor characters', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue(page());
		const cache = createHistoryCache(1);
		await cache.load(2026, 'UTC');
		await cache.load(2026, 'UTC', 'next/+?=');
		await cache.load(2025, 'UTC');
		await cache.load(2026, 'Asia/Shanghai');
		await cache.load(2026, 'UTC', '');
		await cache.load(2026, 'UTC', 'next/+?=');
		expect(request).toHaveBeenCalledTimes(5);
		const params = new URLSearchParams(request.mock.calls[1][0].split('?')[1]);
		expect(params.get('cursor')).toBe('next/+?=');
		expect(request.mock.calls[4][0]).toContain('&cursor=');
	});

	it('isolates users and refresh clears only the selected user', async () => {
		const first = page('User one');
		const second = page('User two');
		const request = vi.spyOn(api, 'request').mockResolvedValueOnce(first).mockResolvedValue(second);
		const one = createHistoryCache(1);
		const two = createHistoryCache(2);
		expect(await one.load(2026, 'UTC')).toEqual(first);
		expect(await two.load(2026, 'UTC')).toEqual(second);
		const otherInstance = createHistoryCache(1);
		expect(await otherInstance.load(2026, 'UTC')).toEqual(first);
		one.clear();
		expect(await two.load(2026, 'UTC')).toEqual(second);
		expect(await otherInstance.load(2026, 'UTC')).toEqual(second);
		expect(request).toHaveBeenCalledTimes(3);
	});

	it('expires pages after five minutes without extending freshness on access', async () => {
		vi.useFakeTimers();
		const request = vi.spyOn(api, 'request').mockResolvedValue(page());
		const cache = createHistoryCache(1);
		await cache.load(2026, 'UTC');
		vi.advanceTimersByTime(HISTORY_CACHE_TTL_MS - 1);
		await createHistoryCache(1).load(2026, 'UTC');
		expect(request).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		await cache.load(2026, 'UTC');
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('bounds persisted pages and evicts the least recently used page', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue(page());
		const cache = createHistoryCache(1);
		for (let i = 0; i < HISTORY_CACHE_MAX_PAGES; i++) await cache.load(2026, 'UTC', String(i));
		await cache.load(2026, 'UTC', '0');
		await cache.load(2026, 'UTC', 'overflow');
		expect(JSON.parse(store.getItem(store.key(0)!)!)).toHaveLength(HISTORY_CACHE_MAX_PAGES);
		await createHistoryCache(1).load(2026, 'UTC', '0');
		expect(request).toHaveBeenCalledTimes(HISTORY_CACHE_MAX_PAGES + 1);
		await cache.load(2026, 'UTC', '1');
		expect(request).toHaveBeenCalledTimes(HISTORY_CACHE_MAX_PAGES + 2);
	});

	it('coalesces repeated in-flight requests', async () => {
		const response = deferred<HistoryPage>();
		const request = vi.spyOn(api, 'request').mockReturnValue(response.promise);
		const cache = createHistoryCache(1);
		const first = cache.load(2026, 'UTC');
		const second = cache.load(2026, 'UTC');
		response.resolve(page());
		expect(await first).toEqual(page());
		expect(await second).toEqual(page());
		expect(request).toHaveBeenCalledTimes(1);
	});

	it.each([401, 500])('does not cache failed HTTP %s responses', async (status) => {
		const error = new ApiError(status, '', '');
		const request = vi.spyOn(api, 'request').mockRejectedValueOnce(error).mockResolvedValue(page());
		const cache = createHistoryCache(1);
		await expect(cache.load(2026, 'UTC')).rejects.toBe(error);
		expect(store.length).toBe(0);
		expect(await cache.load(2026, 'UTC')).toEqual(page());
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('does not cache network failures', async () => {
		const request = vi.spyOn(api, 'request').mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(page());
		const cache = createHistoryCache(1);
		await expect(cache.load(2026, 'UTC')).rejects.toThrow('offline');
		await cache.load(2026, 'UTC');
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('rejects pre-aborted requests, including cache hits, without fetching', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue(page());
		const cache = createHistoryCache(1);
		await cache.load(2026, 'UTC');
		const controller = new AbortController();
		controller.abort();
		await expect(cache.load(2026, 'UTC', null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
		await expect(cache.load(2025, 'UTC', null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('does not store an aborted response even if the transport ignores cancellation', async () => {
		const response = deferred<HistoryPage>();
		const request = vi.spyOn(api, 'request').mockReturnValueOnce(response.promise).mockResolvedValue(page('Retry'));
		const cache = createHistoryCache(1);
		const controller = new AbortController();
		const first = cache.load(2026, 'UTC', null, controller.signal);
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: 'AbortError' });
		expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
		response.resolve(page('Stale'));
		expect(await cache.load(2026, 'UTC')).toEqual(page('Retry'));
		expect(await createHistoryCache(1).load(2026, 'UTC')).toEqual(page('Retry'));
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('cancels only the aborted subscriber when another reader still needs the page', async () => {
		const response = deferred<HistoryPage>();
		const request = vi.spyOn(api, 'request').mockReturnValue(response.promise);
		const cache = createHistoryCache(1);
		const controller = new AbortController();
		const first = cache.load(2026, 'UTC', null, controller.signal);
		const second = cache.load(2026, 'UTC');
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: 'AbortError' });
		expect(request.mock.calls[0][1]?.signal?.aborted).toBe(false);
		response.resolve(page());
		expect(await second).toEqual(page());
		expect(await cache.load(2026, 'UTC')).toEqual(page());
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('does not let an older in-flight response repopulate the cache after clear', async () => {
		const response = deferred<HistoryPage>();
		const request = vi.spyOn(api, 'request').mockReturnValueOnce(response.promise).mockResolvedValue(page('Fresh'));
		const cache = createHistoryCache(1);
		const first = cache.load(2026, 'UTC');
		cache.clear();
		expect(await cache.load(2026, 'UTC')).toEqual(page('Fresh'));
		response.resolve(page('Old'));
		expect(await first).toEqual(page('Old'));
		expect(await cache.load(2026, 'UTC')).toEqual(page('Fresh'));
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('invalidates in-flight pages from previous navigations when the same user refreshes', async () => {
		const response = deferred<HistoryPage>();
		const request = vi.spyOn(api, 'request').mockReturnValueOnce(response.promise).mockResolvedValue(page('Fresh'));
		const oldCache = createHistoryCache(1);
		const first = oldCache.load(2026, 'UTC');
		const newCache = createHistoryCache(1);
		newCache.clear();
		await newCache.load(2026, 'UTC');
		response.resolve(page('Old'));
		expect(await first).toEqual(page('Old'));
		expect(await oldCache.load(2026, 'UTC')).toEqual(page('Fresh'));
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each(['getItem', 'setItem'] as const)('reports %s failures but still fetches and reuses memory pages', async (operation) => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(store, operation).mockImplementation(() => { throw new Error('Storage unavailable'); });
		const request = vi.spyOn(api, 'request').mockResolvedValue(page());
		const cache = createHistoryCache(1);
		expect(await cache.load(2026, 'UTC')).toEqual(page());
		expect(await cache.load(2026, 'UTC')).toEqual(page());
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('history cache'), expect.any(Error));
		expect(request).toHaveBeenCalledTimes(1);
		cache.clear();
		await cache.load(2026, 'UTC');
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('warns when sessionStorage access itself is denied', async () => {
		vi.stubGlobal('window', { get sessionStorage() { throw new Error('SecurityError'); } });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const request = vi.spyOn(api, 'request').mockResolvedValue(page());
		const cache = createHistoryCache(1);
		expect(await cache.load(2026, 'UTC')).toEqual(page());
		expect(await cache.load(2026, 'UTC')).toEqual(page());
		expect(warn).toHaveBeenCalled();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('reports clear failures without breaking refresh requests', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const request = vi.spyOn(api, 'request').mockResolvedValue(page());
		const cache = createHistoryCache(1);
		await cache.load(2026, 'UTC');
		vi.spyOn(store, 'removeItem').mockImplementation(() => { throw new Error('Denied'); });
		cache.clear();
		expect(warn).toHaveBeenCalledWith('Could not clear stored history cache.', expect.any(Error));
		await cache.load(2026, 'UTC');
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('handles corrupt persisted data without blocking online browsing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const request = vi.spyOn(api, 'request').mockResolvedValue(page());
		await createHistoryCache(1).load(2026, 'UTC');
		store.setItem(store.key(0)!, '{not json');
		expect(await createHistoryCache(1).load(2026, 'UTC')).toEqual(page());
		expect(warn).toHaveBeenCalled();
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('uses expiring memory cache when rendered outside a browser', async () => {
		vi.stubGlobal('window', undefined);
		vi.useFakeTimers();
		const request = vi.spyOn(api, 'request').mockResolvedValue(page());
		const cache = createHistoryCache(1);
		await cache.load(2026, 'UTC');
		await cache.load(2026, 'UTC');
		expect(request).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(HISTORY_CACHE_TTL_MS);
		await cache.load(2026, 'UTC');
		expect(request).toHaveBeenCalledTimes(2);
	});
});
