import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearLocalCaches, LOCAL_CACHE_DATABASES } from './local-caches.js';

function open(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, 1);
		request.onupgradeneeded = () => request.result.createObjectStore('private');
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('deletes both local cache databases and tolerates missing databases', async () => {
	const databases = await Promise.all(LOCAL_CACHE_DATABASES.map(open));
	for (const database of databases) database.close();
	await clearLocalCaches();
	expect((await indexedDB.databases()).map((entry) => entry.name)).toEqual([]);
	await expect(clearLocalCaches()).resolves.toBeUndefined();
});

it('logs blocked deletion instead of hanging sign-out', async () => {
	const database = await open(LOCAL_CACHE_DATABASES[0]);
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await clearLocalCaches();
	expect(warning).toHaveBeenCalledWith(expect.stringContaining(LOCAL_CACHE_DATABASES[0]));
	database.close();
});
