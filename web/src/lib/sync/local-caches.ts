import { revokeAssetUrls } from '#lib/reader/assets/asset-cache.js';
import {
	clearAllReaderCaches,
	PDF_PAGE_CACHE_NAME,
	RANGE_CACHE_NAME
} from '#lib/reader/range-cache.js';

export const LOCAL_CACHE_DATABASES = ['pandalibrary-ocr', 'pandalibrary-assets'] as const;
export const LOCAL_CACHE_STORAGE = [RANGE_CACHE_NAME, PDF_PAGE_CACHE_NAME] as const;

export async function clearLocalCaches(): Promise<void> {
	revokeAssetUrls();
	await clearAllReaderCaches();
	if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable.');
	await Promise.all(LOCAL_CACHE_DATABASES.map((name) => new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new Error(`Could not delete ${name}.`));
		request.onblocked = () => {
			console.warn(`Could not delete ${name}: another tab has it open.`);
			resolve();
		};
	})));
	if (typeof caches === 'undefined') return;
	await Promise.all(LOCAL_CACHE_STORAGE.map((name) => caches.delete(name)));
}
