import { revokeAssetUrls } from '#lib/reader/assets/asset-cache.js';

export const LOCAL_CACHE_DATABASES = ['pandalibrary-ocr', 'pandalibrary-assets'] as const;

export async function clearLocalCaches(): Promise<void> {
	revokeAssetUrls();
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
}
