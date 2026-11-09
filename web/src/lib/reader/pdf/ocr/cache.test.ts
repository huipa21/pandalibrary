import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cacheKey, clearOcrCache, OcrCache, OCR_CACHE_LIMIT, type OcrCacheKey } from './cache.js';
import { clearLocalCaches } from '#lib/sync/local-caches.js';
import type { OcrPage } from './types.js';

const key: OcrCacheKey = { accountId: 1, fingerprint: 'pdf-a', page: 1, languages: ['eng'] };
const page: OcrPage = { width: 100, height: 200, lines: [], createdAt: 1, lastUsedAt: 1 };
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('persists pages and isolates account, fingerprint, page and languages', async () => {
	await new OcrCache().put(key, page);
	const cache = new OcrCache();
	expect(await cache.get(key)).toMatchObject({ width: 100 });
	for (const change of [{ accountId: 2 }, { fingerprint: 'pdf-b' }, { page: 2 }, { languages: ['chi_sim'] as const }]) {
		expect(await cache.get({ ...key, ...change })).toBeUndefined();
	}
	expect(cacheKey({ ...key, languages: ['eng', 'chi_sim'] })).toEqual(
		cacheKey({ ...key, languages: ['chi_sim', 'eng'] })
	);
	expect(cacheKey(key).at(-1)).toContain('7.0.0');
});

it('keeps anonymous OCR in instance memory only', async () => {
	const cache = new OcrCache();
	await cache.put({ ...key, accountId: null }, page);
	expect(await cache.get({ ...key, accountId: null })).toMatchObject({ width: 100 });
	expect(await new OcrCache().get({ ...key, accountId: null })).toBeUndefined();
	expect(await indexedDB.databases()).toEqual([]);
	cache.dispose();
	expect(await cache.get({ ...key, accountId: null })).toBeUndefined();
});

it('evicts the least recently used page beyond 5000 rows', async () => {
	const cache = new OcrCache();
	await cache.put(key, page);
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.open('pandalibrary-ocr');
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const database = request.result;
			const tx = database.transaction('pages', 'readwrite');
			const store = tx.objectStore('pages');
			for (let number = 1; number <= OCR_CACHE_LIMIT; number++) {
				store.put({ ...page, lastUsedAt: number }, cacheKey({ ...key, page: number }));
			}
			tx.oncomplete = () => { database.close(); resolve(); };
			tx.onabort = () => { database.close(); reject(tx.error); };
		};
	});
	await cache.get(key);
	await cache.put({ ...key, page: OCR_CACHE_LIMIT + 1 }, page);
	expect(await cache.get(key)).toBeDefined();
	expect(await cache.get({ ...key, page: 2 })).toBeUndefined();
	expect(await cache.get({ ...key, page: OCR_CACHE_LIMIT + 1 })).toBeDefined();
});

it('refuses aborted writes and clears through the existing sign-out registry', async () => {
	const cache = new OcrCache();
	const controller = new AbortController();
	controller.abort();
	await expect(cache.put(key, page, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	expect(await cache.get(key)).toBeUndefined();
	await cache.put(key, page);
	await clearLocalCaches();
	expect(await cache.get(key)).toBeUndefined();
	await cache.put(key, page);
	await clearOcrCache();
	expect(await cache.get(key)).toBeUndefined();
});

it('warns and uses memory when IndexedDB is unavailable or denied', async () => {
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.stubGlobal('indexedDB', undefined);
	const unavailable = new OcrCache();
	await unavailable.put(key, page);
	expect(await unavailable.get(key)).toMatchObject({ width: 100 });
	vi.stubGlobal('indexedDB', { open: () => { throw new DOMException('Denied', 'SecurityError'); } });
	const denied = new OcrCache();
	await denied.put(key, page);
	expect(await denied.get(key)).toMatchObject({ width: 100 });
	expect(warning).toHaveBeenCalledTimes(2);
});
