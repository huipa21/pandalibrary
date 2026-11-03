import { writable } from 'svelte/store';
import { ApiError, api } from '#lib/api/client.js';
import { pushMutation, SyncError, type Mutation } from '#lib/reader/api.js';
import {
	activeViewer,
	AccountChangedError,
	enqueue,
	OfflineStorageError,
	outbox,
	retryFailed,
	setActiveViewer
} from './db.js';
import { synchronize, withSessionLock, type SyncReport } from './engine.js';
import type { OfflineViewer } from './types.js';

export interface OfflineStatus {
	account: number | null;
	available: boolean;
	online: boolean;
	pending: number;
	issues: number;
	syncing: boolean;
	error: boolean;
}

export const offlineStatus = writable<OfflineStatus>({
	account: null, available: true, online: true, pending: 0, issues: 0, syncing: false, error: false
});

let viewer: OfflineViewer | null = null;
let available = true;
let running: Promise<SyncReport> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let readerTimer: ReturnType<typeof setInterval> | null = null;
let readers = 0;
let listenersInstalled = false;
let channel: BroadcastChannel | null = null;
const submitted = new WeakMap<Mutation, { account: number; sequence: number | null }>();
const SIGNED_OUT = 'pandalibrary.offline.signed-out';

function connected(): boolean {
	return typeof navigator === 'undefined' || navigator.onLine;
}

function update(patch: Partial<OfflineStatus>): void {
	offlineStatus.update((current) => ({ ...current, ...patch }));
}

export function currentAccount(): number {
	if (!viewer) throw new AccountChangedError();
	return viewer.id;
}

export function offlineAvailable(): boolean {
	return available;
}

export async function rememberedViewer(): Promise<OfflineViewer | null> {
	if (localStorage.getItem(SIGNED_OUT) === '1') return null;
	return activeViewer();
}

function report(error: unknown): void {
	console.error('Offline synchronization failed', error);
	update({ error: true, syncing: false });
	if (error instanceof AccountChangedError || (error instanceof ApiError && error.status === 401)) {
		window.dispatchEvent(new Event('pandalibrary-account-invalid'));
	}
}

function triggerSync(): void {
	void syncNow().catch(report);
}

function installListeners(): void {
	if (listenersInstalled || typeof window === 'undefined') return;
	listenersInstalled = true;
	window.addEventListener('online', () => {
		update({ online: true });
		triggerSync();
	});
	window.addEventListener('offline', () => update({ online: false }));
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) triggerSync();
	});
	navigator.serviceWorker?.addEventListener('message', (event: MessageEvent<unknown>) => {
		if (event.data === 'pandalibrary-sync-complete') {
			void refreshStatus().catch(report);
		} else if (event.data === 'pandalibrary-sync-request') {
			triggerSync();
		}
	});
	if (typeof BroadcastChannel !== 'undefined') {
		channel = new BroadcastChannel('pandalibrary-account');
		channel.onmessage = (event: MessageEvent<unknown>) => {
			if (viewer && event.data !== viewer.id) {
				window.dispatchEvent(new Event('pandalibrary-account-invalid'));
			}
		};
	}
}

export async function activateOffline(next: OfflineViewer, offline = false): Promise<void> {
	viewer = next;
	installListeners();
	update({ account: next.id, online: !offline && connected(), error: false });
	try {
		if (offline) {
			const active = await activeViewer();
			if (!active || active.id !== next.id) throw new AccountChangedError();
		} else {
			await withSessionLock(async () => {
				const response = await api.request<{ user: OfflineViewer }>('/auth/me', { cache: 'no-store' });
				if (response.user.id !== next.id) throw new AccountChangedError();
				await setActiveViewer(response.user);
				localStorage.removeItem(SIGNED_OUT);
			});
			channel?.postMessage(next.id);
		}
		available = true;
		if (!navigator.locks) throw new OfflineStorageError('Safe offline synchronization requires the Web Locks API.');
		update({ available: true });
		await refreshStatus();
		if (!offline) triggerSync();
	} catch (error) {
		if (error instanceof AccountChangedError || error instanceof ApiError) throw error;
		console.error('Offline storage is unavailable', error);
		available = false;
		update({ available: false, error: true });
	}
}

export async function deactivateOffline(): Promise<void> {
	if (timer !== null) clearTimeout(timer);
	timer = null;
	let locked = false;
	try {
		localStorage.setItem(SIGNED_OUT, '1');
		locked = true;
	} catch (error) {
		console.error('Could not lock the remembered offline session', error);
	}
	try {
		await setActiveViewer(null);
		locked = true;
	} catch (error) {
		console.error('Could not clear the remembered offline session', error);
		available = false;
		update({ available: false });
	}
	if (!locked) throw new OfflineStorageError('Could not lock the remembered offline session.');
	viewer = null;
	channel?.postMessage(null);
	update({ account: null, pending: 0, issues: 0, syncing: false, error: false });
}

export async function refreshStatus(): Promise<void> {
	if (!viewer || !available) return;
	const entries = await outbox(viewer.id);
	update({
		pending: entries.filter((entry) => entry.status === 'pending').length,
		issues: entries.filter((entry) => entry.status === 'stale' || entry.status === 'rejected').length,
		online: connected()
	});
}

export async function syncNow(retry = false): Promise<SyncReport> {
	if (!viewer || !available) throw new OfflineStorageError('Offline synchronization is unavailable.');
	if (!connected()) {
		update({ online: false });
		return { applied: 0, issues: 0 };
	}
	if (running) {
		const result = await running;
		if (!retry) return result;
	}
	const account = viewer.id;
	update({ syncing: true, error: false, online: true });
	const operation = (async () => {
		if (retry) await retryFailed(account);
		const result = await synchronize(account);
		await refreshStatus();
		update({ syncing: false });
		return result;
	})();
	running = operation;
	try {
		return await operation;
	} catch (error) {
		update({ syncing: false, error: true });
		throw error;
	} finally {
		if (running === operation) running = null;
	}
}

function scheduleSync(): void {
	if (timer !== null) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		if (connected()) triggerSync();
	}, 1000);
}

function registerBackgroundSync(): void {
	if (!('serviceWorker' in navigator)) return;
	void navigator.serviceWorker.ready.then(async (registration) => {
		if (!('sync' in registration)) return;
		const sync = registration.sync;
		if (typeof sync === 'object' && sync !== null && 'register' in sync &&
			typeof sync.register === 'function') {
			await sync.register('pandalibrary-outbox');
		}
	}).catch(report);
}

export async function queueMutation(mutation: Mutation): Promise<number | null> {
	if (!viewer) throw new AccountChangedError();
	if (!available) {
		if (!connected()) throw new OfflineStorageError('Offline storage is unavailable.');
		await pushMutation(mutation);
		return null;
	}
	const sequence = await enqueue(viewer.id, mutation);
	await refreshStatus();
	registerBackgroundSync();
	scheduleSync();
	return sequence;
}

export async function saveMutation(mutation: Mutation): Promise<'applied' | 'queued'> {
	const account = currentAccount();
	let submission = submitted.get(mutation);
	if (submission && submission.account !== account) throw new AccountChangedError();
	if (!submission) {
		submission = { account, sequence: await queueMutation(mutation) };
		submitted.set(mutation, submission);
	}
	const { sequence } = submission;
	if (currentAccount() !== account) throw new AccountChangedError();
	if (sequence === null) return 'applied';
	if (!connected()) return 'queued';
	try {
		await syncNow();
	} catch (error) {
		report(error);
	}
	if (currentAccount() !== account) throw new AccountChangedError();
	const entry = (await outbox(account)).find((item) => item.sequence === sequence);
	if (!entry || entry.status === 'applied') return 'applied';
	if (entry.status === 'stale' || entry.status === 'rejected') {
		throw new SyncError(entry.status, entry.reason);
	}
	return 'queued';
}

export function readerOpened(): () => void {
	readers += 1;
	if (readerTimer === null) {
		readerTimer = setInterval(() => {
			if (connected() && readers > 0) triggerSync();
		}, 60_000);
	}
	return () => {
		readers -= 1;
		if (readers <= 0 && readerTimer !== null) {
			clearInterval(readerTimer);
			readerTimer = null;
			readers = 0;
		}
	};
}

export class DurableProgressWriter {
	private writes = new Map<Mutation, Promise<void> | null>();

	constructor(private readonly onError: (error: unknown) => void) {}

	schedule(mutation: Mutation): void {
		this.writes.set(mutation, null);
		this.start(mutation);
	}

	private start(mutation: Mutation): void {
		const write = queueMutation(mutation).then(() => {
			this.writes.delete(mutation);
		}).catch((error: unknown) => {
			this.writes.set(mutation, null);
			this.onError(error);
			throw error;
		});
		this.writes.set(mutation, write);
		void write.catch(() => undefined);
	}

	async flush(_options: { keepalive?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		for (const [mutation, write] of this.writes) {
			if (write === null) this.start(mutation);
		}
		await Promise.all([...this.writes.values()].filter((write): write is Promise<void> => write !== null));
		if (connected() && available) {
			await syncNow();
		}
	}
}
