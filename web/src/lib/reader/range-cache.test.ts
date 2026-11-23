import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearAllReaderCaches,
	clearBookReaderCache,
	DEFAULT_DISK_CACHE_LIMIT_BYTES,
	DEFAULT_MEMORY_CACHE_LIMIT_BYTES,
	getReaderCacheSettings,
	listCachedBooks,
	PDF_PAGE_CACHE_NAME,
	RANGE_CACHE_NAME,
	RangeCache,
	recordReaderCacheEntry,
	resetReaderCacheStateForTests,
	saveReaderCacheSettings
} from './range-cache.js';

class MemoryCache {
	private readonly store = new Map<string, Response>();

	async match(request: RequestInfo | URL): Promise<Response | undefined> {
		const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
		const found = this.store.get(url);
		return found ? found.clone() : undefined;
	}

	async put(request: RequestInfo | URL, response: Response): Promise<void> {
		const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
		this.store.set(url, response.clone());
	}

	async delete(request: RequestInfo | URL): Promise<boolean> {
		const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
		return this.store.delete(url);
	}

	async keys(): Promise<readonly Request[]> {
		return [...this.store.keys()].map((url) => new Request(url));
	}
}

class MemoryCacheStorage {
	private readonly caches = new Map<string, MemoryCache>();

	async open(name: string): Promise<Cache> {
		let cache = this.caches.get(name);
		if (!cache) {
			cache = new MemoryCache();
			this.caches.set(name, cache);
		}
		return cache as unknown as Cache;
	}

	async delete(name: string): Promise<boolean> {
		return this.caches.delete(name);
	}

	async keys(): Promise<string[]> {
		return [...this.caches.keys()];
	}
}

describe('RangeCache and per-book cache management', () => {
	let storage: Map<string, string>;

	beforeEach(() => {
		storage = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => { storage.set(key, value); },
			removeItem: (key: string) => { storage.delete(key); }
		});
		vi.stubGlobal('caches', new MemoryCacheStorage());
		resetReaderCacheStateForTests();
	});

	afterEach(() => {
		resetReaderCacheStateForTests();
		vi.unstubAllGlobals();
	});

	it('persists configurable disk and memory cache budgets', () => {
		expect(getReaderCacheSettings()).toEqual({
			diskLimitBytes: DEFAULT_DISK_CACHE_LIMIT_BYTES,
			memoryLimitBytes: DEFAULT_MEMORY_CACHE_LIMIT_BYTES
		});

		const updated = saveReaderCacheSettings({
			diskLimitBytes: 4 * 1024 * 1024 * 1024,
			memoryLimitBytes: 512 * 1024 * 1024
		});
		expect(updated).toEqual({
			diskLimitBytes: 4 * 1024 * 1024 * 1024,
			memoryLimitBytes: 512 * 1024 * 1024
		});
		resetReaderCacheStateForTests();
		expect(getReaderCacheSettings()).toEqual(updated);
	});

	it('tracks cached chunks and pages per book and clears a specific book without affecting others', async () => {
		const book21 = new RangeCache(
			1,
			new URL(`http://books.test/api/v1/books/21/files/31?v=${'a'.repeat(64)}`),
			{ bookId: 21, fileId: 31, bookTitle: 'Scanned History Vol 1' }
		);
		const book22 = new RangeCache(
			1,
			new URL(`http://books.test/api/v1/books/22/files/32?v=${'b'.repeat(64)}`),
			{ bookId: 22, fileId: 32, bookTitle: 'Scanned Atlas Vol 2' }
		);

		await book21.put(0, new Uint8Array(1024));
		await book21.put(1, new Uint8Array(2048));
		await book22.put(0, new Uint8Array(4096));

		const pageCache = await caches.open(PDF_PAGE_CACHE_NAME);
		const pageUrl = 'http://books.test/__pandalibrary_pdf_page_cache__?account=1&book=21&file=31&page=1';
		await pageCache.put(new Request(pageUrl), new Response(new Uint8Array(512)));
		recordReaderCacheEntry({
			key: pageUrl,
			cache: 'page',
			account: 1,
			bookId: 21,
			fileId: 31,
			title: 'Scanned History Vol 1',
			bytes: 512,
			updatedAt: Date.now()
		});

		const books = await listCachedBooks(1);
		expect(books).toHaveLength(2);
		const summary21 = books.find((item) => item.bookId === 21)!;
		expect(summary21).toMatchObject({
			bookId: 21,
			title: 'Scanned History Vol 1',
			rangeBytes: 3072,
			pageBytes: 512,
			totalBytes: 3584,
			chunkCount: 2,
			pageCount: 1
		});

		await clearBookReaderCache(1, 21);
		expect(await book21.get(0)).toBeNull();
		expect(await book21.get(1)).toBeNull();
		expect((await book22.get(0))?.byteLength).toBe(4096);

		const remaining = await listCachedBooks(1);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].bookId).toBe(22);

		await clearAllReaderCaches(1);
		expect(await listCachedBooks(1)).toEqual([]);
		expect(await book22.get(0)).toBeNull();
	});
});
