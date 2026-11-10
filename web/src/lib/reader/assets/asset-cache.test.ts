import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountChangedError, setActiveViewer } from '#lib/sync/db.js';
import { clearLocalCaches } from '#lib/sync/local-caches.js';
import { annotationAssetUrl, ASSET_CACHE_BUDGET, clearAssetCache, releaseAnnotationAssetUrl, revokeAssetUrls } from './asset-cache.js';
import { OfflineError } from './errors.js';

const viewer = { id: 1, username: 'a', display_name: '', role: 'user', locale: 'en' as const };
const hash = 'a'.repeat(64);
const fetcher = vi.fn<typeof fetch>();
const image = () => new Response(new Blob(['private image'], { type: 'image/png' }), {
	headers: { 'content-type': 'image/png' }
});

interface Entry {
	accountId: number;
	sha256: string;
	blob: Blob;
	lastUsed: number;
}

async function seed(entries: Entry[]): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open('pandalibrary-assets', 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore('blobs', { keyPath: ['accountId', 'sha256'] })
				.createIndex('account', 'accountId');
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = database.transaction('blobs', 'readwrite');
			for (const entry of entries) tx.objectStore('blobs').put(entry);
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		database.close();
	}
}

beforeEach(async () => {
	revokeAssetUrls();
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal('IDBKeyRange', IDBKeyRange);
	vi.stubGlobal('navigator', { onLine: true, locks: { request: (_name: string, action: () => unknown) => action() } });
	vi.stubGlobal('fetch', fetcher);
	fetcher.mockReset().mockImplementation(async () => image());
	vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${Math.random()}`);
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
	await setActiveViewer(viewer);
});
afterEach(() => {
	revokeAssetUrls();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('account-scoped annotation image cache', () => {
	it('fetches a miss and serves a hit offline as tracked object URLs', async () => {
		const first = await annotationAssetUrl(hash);
		expect(fetcher).toHaveBeenCalledWith(`/api/v1/me/annotation-assets/${hash}`, expect.objectContaining({
			credentials: 'same-origin', cache: 'no-store', redirect: 'error'
		}));
		vi.stubGlobal('navigator', { onLine: false, locks: { request: (_name: string, action: () => unknown) => action() } });
		const second = await annotationAssetUrl(hash);
		expect(first).not.toBe(second);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
		revokeAssetUrls();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(second);
	});

	it('releases individual object URLs without retaining them for later account cleanup', async () => {
		const released = await annotationAssetUrl(hash);
		const retained = await annotationAssetUrl(hash);
		releaseAnnotationAssetUrl(released);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(released);
		revokeAssetUrls();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(retained);
		expect(vi.mocked(URL.revokeObjectURL).mock.calls.filter(([url]) => url === released)).toHaveLength(1);
	});

	it('rejects an offline miss without sending a request', async () => {
		vi.stubGlobal('navigator', { onLine: false, locks: { request: (_name: string, action: () => unknown) => action() } });
		await expect(annotationAssetUrl(hash)).rejects.toBeInstanceOf(OfflineError);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('never gives account B account A images, even for the same hash', async () => {
		const first = await annotationAssetUrl(hash);
		await setActiveViewer({ ...viewer, id: 2 });
		vi.stubGlobal('navigator', { onLine: false, locks: { request: (_name: string, action: () => unknown) => action() } });
		await expect(annotationAssetUrl(hash)).rejects.toBeInstanceOf(OfflineError);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
		vi.stubGlobal('navigator', { onLine: true, locks: { request: (_name: string, action: () => unknown) => action() } });
		fetcher.mockImplementation(async () => new Response(null, { status: 404, headers: { 'content-type': 'application/problem+json' } }));
		await expect(annotationAssetUrl(hash)).rejects.toMatchObject({ status: 404 });
		expect(fetcher).toHaveBeenCalledTimes(2);
		await setActiveViewer(viewer);
		await expect(annotationAssetUrl(hash)).resolves.toMatch(/^blob:/);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('does not return or cache an image if the active account changes in flight', async () => {
		fetcher.mockImplementationOnce(async () => {
			await setActiveViewer({ ...viewer, id: 2 });
			return image();
		});
		await expect(annotationAssetUrl(hash)).rejects.toBeInstanceOf(AccountChangedError);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
		await setActiveViewer(viewer);
		await annotationAssetUrl(hash);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('enforces the exact 200 MiB per-account LRU budget and touches cache hits', async () => {
		const blob = new Blob([new Uint8Array(4 << 20)], { type: 'image/webp' });
		const key = (n: number) => n.toString(16).padStart(64, '0');
		expect(ASSET_CACHE_BUDGET).toBe(50 * blob.size);
		await seed([
			...Array.from({ length: 50 }, (_, i) => ({ accountId: 1, sha256: key(i + 1), blob, lastUsed: i })),
			{ accountId: 2, sha256: key(2), blob, lastUsed: 0 }
		]);
		await annotationAssetUrl(key(1));
		fetcher.mockImplementation(async () => new Response(blob, { headers: { 'content-type': blob.type } }));
		await annotationAssetUrl(hash);
		expect(fetcher).toHaveBeenCalledOnce();
		vi.stubGlobal('navigator', { onLine: false, locks: { request: (_name: string, action: () => unknown) => action() } });
		await expect(annotationAssetUrl(key(1))).resolves.toMatch(/^blob:/);
		await expect(annotationAssetUrl(key(2))).rejects.toBeInstanceOf(OfflineError);
		await setActiveViewer({ ...viewer, id: 2 });
		await expect(annotationAssetUrl(key(2))).resolves.toMatch(/^blob:/);
	});

	it('clears cached images and revokes URLs on explicit clear and sign-out cleanup', async () => {
		const first = await annotationAssetUrl(hash);
		await clearAssetCache();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
		await annotationAssetUrl(hash);
		expect(fetcher).toHaveBeenCalledTimes(2);
		const last = await annotationAssetUrl(hash);
		await clearLocalCaches();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(last);
		expect((await indexedDB.databases()).map((entry) => entry.name)).not.toContain('pandalibrary-assets');
	});

	it('rejects invalid hashes, aborted requests, malformed downloads and HTTP errors', async () => {
		await expect(annotationAssetUrl('../escape')).rejects.toMatchObject({ code: 'invalid_asset_hash' });
		const abort = new AbortController();
		abort.abort();
		await expect(annotationAssetUrl(hash, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetcher).not.toHaveBeenCalled();
		fetcher.mockResolvedValueOnce(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }));
		await expect(annotationAssetUrl(hash)).rejects.toMatchObject({ code: 'invalid_response' });
		fetcher.mockResolvedValueOnce(Response.json({ code: 'asset_not_found' }, {
			status: 404, headers: { 'content-type': 'application/problem+json' }
		}));
		await expect(annotationAssetUrl(hash)).rejects.toMatchObject({ code: 'asset_not_found' });
		await setActiveViewer(null);
		await expect(annotationAssetUrl(hash)).rejects.toBeInstanceOf(AccountChangedError);
	});
});
