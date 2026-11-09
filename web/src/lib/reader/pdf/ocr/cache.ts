import { languageKey, type OcrLanguage } from './languages.js';
import type { OcrPage } from './types.js';

const DATABASE = 'pandalibrary-ocr';
export const OCR_ENGINE_VERSION = 'tesseract-7.0.0-eng-int-chi-sim-full-1.0.0-v1';
export const OCR_CACHE_LIMIT = 5000;

export interface OcrCacheKey {
	accountId: number | null;
	fingerprint: string;
	page: number;
	languages: readonly OcrLanguage[];
}

export function cacheKey(key: OcrCacheKey): [number, string, number, string, string] {
	return [key.accountId ?? 0, key.fingerprint, key.page, languageKey(key.languages), OCR_ENGINE_VERSION];
}

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore('pages').createIndex('lastUsedAt', 'lastUsedAt');
		};
		request.onsuccess = () => {
			request.result.onversionchange = () => request.result.close();
			resolve(request.result);
		};
		request.onerror = () => reject(request.error ?? new Error('Could not open the OCR cache.'));
		request.onblocked = () => reject(new Error('The OCR cache is blocked by another tab.'));
	});
}

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('An OCR cache request failed.'));
	});
}

export class OcrCache {
	private memory = new Map<string, OcrPage>();
	private unavailable = typeof indexedDB === 'undefined';

	constructor() {
		if (this.unavailable) console.warn('IndexedDB is unavailable; OCR results will only be kept in memory.');
	}

	private async transaction<T>(signal: AbortSignal | undefined, action: (store: IDBObjectStore) => Promise<T>): Promise<T> {
		const database = await open();
		if (signal?.aborted) {
			database.close();
			signal.throwIfAborted();
		}
		const tx = database.transaction('pages', 'readwrite');
		const abort = () => tx.abort();
		signal?.addEventListener('abort', abort, { once: true });
		const complete = new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error ?? new DOMException('OCR cache write cancelled.', 'AbortError'));
			tx.onerror = () => { /* onabort reports the failure */ };
		});
		try {
			const [value] = await Promise.all([action(tx.objectStore('pages')), complete]);
			return value;
		} finally {
			signal?.removeEventListener('abort', abort);
			database.close();
		}
	}

	private fallback(error: unknown): void {
		this.unavailable = true;
		console.warn('Could not use the OCR cache; results will only be kept in memory.', error);
	}

	async get(key: OcrCacheKey, signal?: AbortSignal): Promise<OcrPage | undefined> {
		signal?.throwIfAborted();
		const id = cacheKey(key);
		if (key.accountId !== null && !this.unavailable) {
			try {
				return await this.transaction(signal, async (store) => {
					const page = await result<OcrPage | undefined>(store.get(id));
					if (page) {
						page.lastUsedAt = Date.now();
						await result(store.put(page, id));
					}
					return page;
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				this.fallback(error);
			}
		}
		const page = this.memory.get(JSON.stringify(id));
		if (page) page.lastUsedAt = Date.now();
		return page;
	}

	async put(key: OcrCacheKey, page: OcrPage, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const id = cacheKey(key);
		const value = { ...page, lastUsedAt: Date.now() };
		if (key.accountId !== null && !this.unavailable) {
			try {
				await this.transaction(signal, async (store) => {
					await result(store.put(value, id));
					const excess = await result(store.count()) - OCR_CACHE_LIMIT;
					if (excess > 0) {
						await new Promise<void>((resolve, reject) => {
							let remaining = excess;
							const request = store.index('lastUsedAt').openCursor();
							request.onerror = () => reject(request.error);
							request.onsuccess = () => {
								const cursor = request.result;
								if (!cursor || remaining-- <= 0) return resolve();
								cursor.delete();
								cursor.continue();
							};
						});
					}
				});
				return;
			} catch (error) {
				if (signal?.aborted) throw error;
				this.fallback(error);
			}
		}
		signal?.throwIfAborted();
		this.memory.set(JSON.stringify(id), value);
		if (this.memory.size > OCR_CACHE_LIMIT) {
			const oldest = [...this.memory].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
			this.memory.delete(oldest[0]);
		}
	}

	dispose(): void {
		this.memory.clear();
	}
}

export function clearOcrCache(): Promise<void> {
	if (typeof indexedDB === 'undefined') return Promise.resolve();
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(DATABASE);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new Error('Could not delete the OCR cache.'));
		request.onblocked = () => reject(new Error('The OCR cache is open in another tab.'));
	});
}
