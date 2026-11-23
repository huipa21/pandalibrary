import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearBookReaderCache,
	listCachedBooks,
	resetReaderCacheStateForTests
} from '../range-cache.js';
import { PdfPageCache, quantizeScale } from './page-cache.js';

function fakeBitmap(width = 400, height = 600): ImageBitmap {
	return {
		width,
		height,
		close: vi.fn()
	} as unknown as ImageBitmap;
}

class MemoryCache {
	private readonly store = new Map<string, Response>();

	async match(request: RequestInfo | URL): Promise<Response | undefined> {
		const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
		return this.store.get(url)?.clone();
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

describe('PdfPageCache', () => {
	beforeEach(() => {
		const storage = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => { storage.set(key, value); },
			removeItem: (key: string) => { storage.delete(key); }
		});
		const cachesMap = new Map<string, MemoryCache>();
		vi.stubGlobal('caches', {
			open: async (name: string) => {
				let c = cachesMap.get(name);
				if (!c) {
					c = new MemoryCache();
					cachesMap.set(name, c);
				}
				return c;
			},
			delete: async (name: string) => cachesMap.delete(name)
		});
		vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(500, 700)));
		resetReaderCacheStateForTests();
	});

	afterEach(() => {
		resetReaderCacheStateForTests();
		vi.unstubAllGlobals();
	});

	it('quantizes scales and falls back to nearest cached scale in memory for the same page and rotation', () => {
		expect(quantizeScale(1.12)).toBe(1);
		expect(quantizeScale(1.14)).toBe(1.25);

		const cache = new PdfPageCache({
			account: 1,
			bookId: 21,
			fileId: 31,
			bookTitle: 'Scanned Book',
			fingerprint: 'fp1',
			origin: 'http://books.test'
		});
		const bmp = fakeBitmap();
		cache.putBitmap(3, 0, 1.0, bmp);
		expect(cache.getMemory(3, 0, 1.0)).toBe(bmp);
		expect(cache.getMemory(3, 0, 1.5)).toBe(bmp);
		expect(cache.getMemory(3, 90, 1.0)).toBeNull();
		cache.dispose();
	});

	it('persists rendered page canvases to Cache Storage and clears them when book cache is cleared', async () => {
		const cache = new PdfPageCache({
			account: 1,
			bookId: 21,
			fileId: 31,
			bookTitle: 'Scanned PDF',
			fingerprint: 'fp-scan',
			origin: 'http://books.test'
		});
		const fakeCanvas = {
			width: 800,
			height: 1200,
			convertToBlob: vi.fn(async () => new Blob([new Uint8Array(2048)], { type: 'image/webp' }))
		} as unknown as OffscreenCanvas;

		await cache.captureCanvas(5, 0, 1.25, fakeCanvas);
		expect(cache.hasMemory(5, 0, 1.25)).toBe(true);

		const summaries = await listCachedBooks(1);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			bookId: 21,
			title: 'Scanned PDF',
			pageBytes: 2048,
			pageCount: 1
		});

		// A fresh PdfPageCache instance loads the persisted page bitmap from Cache Storage.
		const reopened = new PdfPageCache({
			account: 1,
			bookId: 21,
			fileId: 31,
			bookTitle: 'Scanned PDF',
			fingerprint: 'fp-scan',
			origin: 'http://books.test'
		});
		const loaded = await reopened.get(5, 0, 1.25);
		expect(loaded).not.toBeNull();
		expect(reopened.hasMemory(5, 0, 1.25)).toBe(true);

		await clearBookReaderCache(1, 21);
		expect(reopened.hasMemory(5, 0, 1.25)).toBe(false);
		expect(await reopened.get(5, 0, 1.25)).toBeNull();
		cache.dispose();
		reopened.dispose();
	});
});
