import { AccountChangedError, OfflineStorageError } from '#lib/sync/db.js';
import { withSessionLock } from '#lib/sync/engine.js';
import { downloadAnnotationAsset, requireAssetAccount, validAssetHash } from './assets-api.js';
import { AnnotationImageError } from './errors.js';

const DATABASE = 'pandalibrary-assets';
export const ASSET_CACHE_BUDGET = 200 << 20;

interface CachedAsset {
	accountId: number;
	sha256: string;
	blob: Blob;
	lastUsed: number;
}

const urls = new Set<string>();
let urlAccount: number | null = null;
let generation = 0;
let lastUsed = 0;

function openDatabase(): Promise<IDBDatabase> {
	if (typeof indexedDB === 'undefined') throw new OfflineStorageError('IndexedDB is unavailable.');
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore('blobs', { keyPath: ['accountId', 'sha256'] })
				.createIndex('account', 'accountId');
		};
		request.onsuccess = () => {
			request.result.onversionchange = () => {
				revokeAssetUrls();
				request.result.close();
			};
			resolve(request.result);
		};
		request.onerror = () => reject(request.error ?? new OfflineStorageError('Could not open image cache.'));
		request.onblocked = () => reject(new OfflineStorageError('Image cache is blocked by another tab.'));
	});
}

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new OfflineStorageError('Image cache request failed.'));
	});
}

async function cacheTransaction<T>(action: (store: IDBObjectStore) => Promise<T>): Promise<T> {
	const database = await openDatabase();
	const tx = database.transaction('blobs', 'readwrite');
	const complete = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new OfflineStorageError('Image cache transaction aborted.'));
		tx.onerror = () => { /* onabort reports failures */ };
	});
	try {
		const value = await action(tx.objectStore('blobs'));
		await complete;
		return value;
	} catch (error) {
		try {
			tx.abort();
		} catch (abortError) {
			if (!(abortError instanceof DOMException && abortError.name === 'InvalidStateError')) throw abortError;
		}
		await complete.catch(() => undefined);
		throw error;
	} finally {
		database.close();
	}
}

function nextUse(): number {
	lastUsed = Math.max(Date.now(), lastUsed + 1);
	return lastUsed;
}

async function cacheRead(accountId: number, sha256: string): Promise<Blob | null> {
	return cacheTransaction(async (store) => {
		const entry = await result<CachedAsset | undefined>(store.get([accountId, sha256]));
		if (!entry) return null;
		await result(store.put({ ...entry, lastUsed: nextUse() }));
		return entry.blob;
	});
}

async function cacheWrite(accountId: number, sha256: string, blob: Blob): Promise<void> {
	await cacheTransaction(async (store) => {
		await result(store.put({ accountId, sha256, blob, lastUsed: nextUse() } satisfies CachedAsset));
		const entries = await result<CachedAsset[]>(store.index('account').getAll(accountId));
		let size = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
		entries.sort((a, b) => a.lastUsed - b.lastUsed || a.sha256.localeCompare(b.sha256));
		for (const entry of entries) {
			if (size <= ASSET_CACHE_BUDGET) break;
			await result(store.delete([accountId, entry.sha256]));
			size -= entry.blob.size;
		}
	});
}

export async function annotationAssetUrl(sha256: string, signal?: AbortSignal): Promise<string> {
	if (!validAssetHash(sha256)) throw new AnnotationImageError('invalid_asset_hash');
	return withSessionLock(async () => {
		signal?.throwIfAborted();
		const account = await requireAssetAccount();
		if (urlAccount !== account) revokeAssetUrls();
		urlAccount = account;
		const version = generation;
		let blob = await cacheRead(account, sha256);
		await requireAssetAccount(account);
		if (!blob) {
			blob = await downloadAnnotationAsset(sha256, signal);
			await requireAssetAccount(account);
			if (version !== generation) throw new AccountChangedError();
			await cacheWrite(account, sha256, blob);
		}
		await requireAssetAccount(account);
		signal?.throwIfAborted();
		if (version !== generation) throw new AccountChangedError();
		const url = URL.createObjectURL(blob);
		urls.add(url);
		return url;
	}, true).catch((error: unknown) => {
		if (error instanceof AccountChangedError) revokeAssetUrls();
		throw error;
	});
}

export function revokeAssetUrls(): void {
	generation++;
	for (const url of urls) URL.revokeObjectURL(url);
	urls.clear();
	urlAccount = null;
}

export async function clearAssetCache(): Promise<void> {
	revokeAssetUrls();
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(DATABASE);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new OfflineStorageError('Could not clear image cache.'));
		request.onblocked = () => reject(new OfflineStorageError('Image cache is open in another tab.'));
	});
}
