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
	const started = pulls(synchronize);
	synchronize.mockClear();
	return { client, synchronize, started, window, document, network, register, serviceWorker };
}

/** Waits for the in-flight sync, whose IndexedDB status refresh runs on real (unfaked) immediates. */
async function idle(client: typeof import('./client.js')): Promise<void> {
	for (let i = 0; i < 200 && get(client.offlineStatus).syncing; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	expect(get(client.offlineStatus).syncing).toBe(false);
	await Promise.resolve();
}

function pulls(synchronize: { mock: { calls: unknown[][] } }): unknown[] {
	return synchronize.mock.calls.map(([account, client, , options]) => {
		expect([account, client]).toEqual([1, undefined]);
		return (options as { pull?: boolean }).pull;
	});
}

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it('only pushes on start, reconnect and transition to visible without an open reader', async () => {
	const { client, synchronize, started, window, document, network } = await setup();
	// The explicit full sync waits for the push-only start sync instead of reusing it.
	expect(started).toEqual([false, true]);
	expect(get(client.offlineStatus).account).toBe(1);
	network.onLine = false;
	window.dispatchEvent(new Event('offline'));
	expect(get(client.offlineStatus).online).toBe(false);
	network.onLine = true;
	window.dispatchEvent(new Event('online'));
	expect(pulls(synchronize)).toEqual([false]);
	await idle(client);
	synchronize.mockClear();
	document.hidden = true;
	document.dispatchEvent(new Event('visibilitychange'));
	expect(synchronize).not.toHaveBeenCalled();
	document.hidden = false;
	document.dispatchEvent(new Event('visibilitychange'));
	expect(pulls(synchronize)).toEqual([false]);
	await idle(client);
});

it('pulls immediately and every 60 seconds only while a visible reader is open', async () => {
	const { client, synchronize, document } = await setup();
	const close = client.readerOpened();
	expect(pulls(synchronize)).toEqual([true]);
	await idle(client);
	await vi.advanceTimersByTimeAsync(59_999);
	expect(synchronize).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(1);
	expect(pulls(synchronize)).toEqual([true, true]);
	await idle(client);
	synchronize.mockClear();

	document.hidden = true;
	document.dispatchEvent(new Event('visibilitychange'));
	await vi.advanceTimersByTimeAsync(60_000);
	expect(synchronize).not.toHaveBeenCalled();
	document.hidden = false;
	document.dispatchEvent(new Event('visibilitychange'));
	expect(pulls(synchronize)).toEqual([true]);
	await idle(client);
	await vi.advanceTimersByTimeAsync(30_000);
	document.dispatchEvent(new Event('visibilitychange'));
	expect(pulls(synchronize)).toEqual([true, false]);
	await idle(client);

	close();
	close();
	synchronize.mockClear();
	await vi.advanceTimersByTimeAsync(120_000);
	expect(synchronize).not.toHaveBeenCalled();
	document.dispatchEvent(new Event('visibilitychange'));
	expect(pulls(synchronize)).toEqual([false]);
	await idle(client);
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
	const { client, register, synchronize } = await setup();
	register.mockRejectedValueOnce(new DOMException('Permission denied.', 'NotAllowedError'));
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await client.saveMutation(mutation);
	await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
	expect(get(client.offlineStatus).error).toBe(false);
	await vi.advanceTimersByTimeAsync(1000);
	// Saving and the debounced follow-up only push queued writes.
	expect(pulls(synchronize)).toEqual([false, false]);
});

it('keeps an explicit online retry path when Background Sync is absent', async () => {
	const { client, synchronize, network, window, register } = await setup(false);
	network.onLine = false;
	window.dispatchEvent(new Event('offline'));
	await client.queueMutation(mutation);
	expect(register).not.toHaveBeenCalled();
	network.onLine = true;
	await client.syncNow(true);
	expect(pulls(synchronize)).toEqual([true]);
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
