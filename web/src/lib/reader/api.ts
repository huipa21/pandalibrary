import { ApiError, api, type JsonValue } from '#lib/api/client.js';
import type { BookFile } from '#lib/catalog/types.js';
import type { BookState, Setting } from './types.js';

export type Mutation = {
	entity: 'reading_progress' | 'highlights' | 'bookmarks' | 'notes' | 'user_settings' | 'reading_sessions';
	op: 'upsert' | 'delete';
	data: { [key: string]: JsonValue };
	updated_at: number;
} & ({ id: string } | { key: string });

interface MutationResult {
	index: number;
	status: 'applied' | 'stale' | 'rejected';
	reason?: string;
}

export class SyncError extends Error {
	constructor(readonly status: 'stale' | 'rejected' | 'invalid', readonly reason?: string) {
		super(`Sync mutation ${status}${reason ? `: ${reason}` : ''}`);
		this.name = 'SyncError';
	}
}

export class InvalidFileUrlError extends Error {
	constructor() {
		super('The catalog returned an invalid book file URL.');
		this.name = 'InvalidFileUrlError';
	}
}

export async function getBookState(bookId: number): Promise<BookState> {
	return api.request(`/me/books/${bookId}`);
}

export async function getSettings(): Promise<Setting[]> {
	const response = await api.request<{ settings: Setting[] }>('/me/settings');
	return response.settings;
}

export function validatedBookFileUrl(bookId: number, file: BookFile, origin: string): URL {
	let url: URL;
	try {
		url = new URL(file.download_url, origin);
	} catch {
		throw new InvalidFileUrlError();
	}
	if (
		url.origin !== origin ||
		url.pathname !== `/api/v1/books/${bookId}/files/${file.id}` ||
		!/^[a-f0-9]{64}$/.test(url.searchParams.get('v') ?? '') ||
		url.username !== '' ||
		url.password !== ''
	) throw new InvalidFileUrlError();
	return url;
}

export async function downloadBookFile(
	bookId: number,
	file: BookFile,
	origin = window.location.origin,
	fetcher: typeof fetch = fetch
): Promise<Blob> {
	const url = validatedBookFileUrl(bookId, file, origin);
	const response = await fetcher(url.href, { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
	if (!response.ok) {
		throw new ApiError(response.status, response.statusText, await response.text());
	}
	return response.blob();
}

export async function pushMutation(
	mutation: Mutation,
	options: { keepalive?: boolean; signal?: AbortSignal } = {}
): Promise<void> {
	const response = await api.request<{ results: MutationResult[] }>('/sync/push', {
		method: 'POST',
		body: { mutations: [mutation] },
		...options
	});
	const result = response.results?.[0];
	if (!result || response.results.length !== 1 || result.index !== 0) {
		throw new SyncError('invalid');
	}
	if (result.status === 'applied') return;
	// Session IDs are immutable and append-only; a stale retry has already been inserted.
	if (result.status === 'stale' && mutation.entity === 'reading_sessions') return;
	if (result.status === 'stale' || result.status === 'rejected') {
		throw new SyncError(result.status, result.reason);
	}
	throw new SyncError('invalid');
}

export function deviceId(): string {
	const key = 'pandalibrary.reader.device-id';
	const current = localStorage.getItem(key);
	if (current && current.length <= 128) return current;
	const id = crypto.randomUUID();
	localStorage.setItem(key, id);
	return id;
}

export const DEVICE_NAME = 'PandaLibrary Web';
