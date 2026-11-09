import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const viewer = { id: 1, username: 'reader', display_name: '', role: 'user', locale: 'en' as const };
const mutation = {
	entity: 'notes' as const, id: '019a4d48-cc00-7000-8000-000000000001',
	op: 'upsert' as const, updated_at: 123,
	data: { book_id: 21, highlight_id: null, body_md: 'Offline note' }
};

async function setup(backgroundSync = true) {
	const network = { onLine: true };
	const document = Object.assign(new EventTarget(), { hidden: false });
	const window = new EventTarget();
	const register = vi.fn(async () => undefined);
	const serviceWorker = Object.assign(new EventTarget(), {
		ready: Promise.resolve(backgroundSync ? { sync: { register } } : {})
	});
	vi.stubGlobal('navigator', {
		get onLine() { return network.onLine; },
		locks: { request: async (_name: string, action: () => Promise<unknown>) => action() },
		serviceWorker
	});
	vi.stubGlobal('window', window);
	vi.stubGlobal('document', document);
	vi.stubGlobal('BroadcastChannel', undefined);
	const storage = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key)
	});
	const { api } = await import('#lib/api/client.js');
	vi.spyOn(api, 'request').mockResolvedValue({ user: viewer });
	const engine = await import('./engine.js');
	const synchronize = vi.spyOn(engine, 'synchronize').mockResolvedValue({ applied: 0, issues: 0 });
	const client = await import('./client.js');
	await client.activateOffline(viewer);
	await client.syncNow();
	synchronize.mockClear();
	return { client, synchronize, window, document, network, register, serviceWorker };
}

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it('runs on start, reconnect and transition to visible', async () => {
	const { client, synchronize, window, document, network } = await setup();
	expect(get(client.offlineStatus).account).toBe(1);
	network.onLine = false;
	window.dispatchEvent(new Event('offline'));
	expect(get(client.offlineStatus).online).toBe(false);
	network.onLine = true;
	window.dispatchEvent(new Event('online'));
	expect(synchronize).toHaveBeenCalledOnce();
	await client.syncNow();
	synchronize.mockClear();
	document.hidden = true;
	document.dispatchEvent(new Event('visibilitychange'));
	expect(synchronize).not.toHaveBeenCalled();
	document.hidden = false;
	document.dispatchEvent(new Event('visibilitychange'));
	expect(synchronize).toHaveBeenCalledOnce();
	await client.syncNow();
});

it('synchronizes every 60 seconds only while a reader is open', async () => {
	const { client, synchronize } = await setup();
	const close = client.readerOpened();
	await vi.advanceTimersByTimeAsync(59_999);
	expect(synchronize).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(synchronize).toHaveBeenCalledOnce();
	await client.syncNow();
	close();
	synchronize.mockClear();
	await vi.advanceTimersByTimeAsync(120_000);
	expect(synchronize).not.toHaveBeenCalled();
});

it('durably queues before registering Background Sync and does not claim delivery', async () => {
	const { client, network, window, register } = await setup();
	network.onLine = false;
	window.dispatchEvent(new Event('offline'));
	await expect(client.saveMutation(mutation)).resolves.toBe('queued');
	const { outbox } = await import('./db.js');
	expect(await outbox(1)).toMatchObject([{ mutation, status: 'pending' }]);
	expect(register).toHaveBeenCalledWith('pandalibrary-outbox');
});

it('does not report a sync failure when Background Sync registration is refused', async () => {
	const { client, register } = await setup();
	register.mockRejectedValueOnce(new DOMException('Permission denied.', 'NotAllowedError'));
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await client.saveMutation(mutation);
	await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
	expect(get(client.offlineStatus).error).toBe(false);
});

it('keeps an explicit online retry path when Background Sync is absent', async () => {
	const { client, synchronize, network, window, register } = await setup(false);
	network.onLine = false;
	window.dispatchEvent(new Event('offline'));
	await client.queueMutation(mutation);
	expect(register).not.toHaveBeenCalled();
	network.onLine = true;
	await client.syncNow(true);
	expect(synchronize).toHaveBeenCalledWith(1);
	expect(get(client.offlineStatus).pending).toBe(1);
});

it('locks offline restoration on logout while retaining isolated queued writes', async () => {
	const { client } = await setup();
	await client.queueMutation(mutation);
	for (const name of ['pandalibrary-ocr', 'pandalibrary-assets']) {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(name, 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		database.close();
	}
	await client.deactivateOffline();
	expect(await client.rememberedViewer()).toBeNull();
	expect(get(client.offlineStatus).account).toBeNull();
	expect((await indexedDB.databases()).map((entry) => entry.name))
		.not.toContain('pandalibrary-ocr');
	expect((await indexedDB.databases()).map((entry) => entry.name))
		.not.toContain('pandalibrary-assets');
	const { setActiveViewer, outbox } = await import('./db.js');
	await setActiveViewer(viewer);
	expect(await outbox(1)).toMatchObject([{ mutation }]);
});
