import { api } from '#lib/api/client.js';
import type { JsonValue } from '#lib/api/client.js';
import type { Highlight, Note, Setting } from '#lib/reader/types.js';
import {
	activeViewer,
	AccountChangedError,
	cursorState,
	OfflineStorageError,
	outbox,
	persistPull,
	recordResults
} from './db.js';
import type {
	MutationResult, OutboxEntry, ProgressRow, PullResponse, SyncMutation, UserBookRow
} from './types.js';

const MAX_MUTATIONS = 500;
const MAX_BODY_BYTES = 1_900_000;
const FULL_RESYNC_MS = 180 * 24 * 60 * 60 * 1000;
const LOCK_NAME = 'pandalibrary-session-and-sync';

export class SyncProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SyncProtocolError';
	}
}

export interface SyncTransport {
	viewer(): Promise<number>;
	push(mutations: SyncMutation[]): Promise<unknown>;
	pull(cursor: number): Promise<unknown>;
}

const transport: SyncTransport = {
	async viewer() {
		const response = await api.request<{ user: { id: number } }>('/auth/me', { cache: 'no-store' });
		return response.user.id;
	},
	push(mutations) {
		return api.request('/sync/push', { method: 'POST', body: { mutations }, cache: 'no-store' });
	},
	pull(cursor) {
		return api.request(`/sync/pull?cursor=${cursor}`, { cache: 'no-store' });
	}
};

export async function withSessionLock<T>(action: () => Promise<T>, required = false): Promise<T> {
	if (typeof navigator !== 'undefined' && navigator.locks) {
		return navigator.locks.request(LOCK_NAME, action);
	}
	if (required) throw new OfflineStorageError('Safe synchronization requires the Web Locks API.');
	return action();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	return isRecord(value) && Object.values(value).every(isJson);
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function nullableNumber(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function validRevision(value: Record<string, unknown>): boolean {
	return typeof value.rev === 'number' && Number.isSafeInteger(value.rev) &&
		typeof value.updated_at === 'string';
}

function validUserBook(value: unknown): value is UserBookRow {
	return isRecord(value) && validRevision(value) && typeof value.book_id === 'number' &&
		Number.isSafeInteger(value.book_id) && value.book_id > 0 && typeof value.status === 'string' &&
		nullableNumber(value.rating) && nullableString(value.started_at) && nullableString(value.finished_at);
}

function validProgress(value: unknown): value is ProgressRow {
	return isRecord(value) && validRevision(value) && typeof value.book_id === 'number' &&
		Number.isSafeInteger(value.book_id) && value.book_id > 0 && nullableNumber(value.book_file_id) &&
		typeof value.source === 'string' && isJson(value.locator) &&
		typeof value.percentage === 'number' && Number.isFinite(value.percentage) &&
		typeof value.device === 'string' && typeof value.device_id === 'string';
}

function validHighlight(value: unknown): value is Highlight {
	return isRecord(value) && validRevision(value) && typeof value.id === 'string' && value.id.length > 0 &&
		typeof value.book_id === 'number' && Number.isSafeInteger(value.book_id) && value.book_id > 0 &&
		nullableNumber(value.book_file_id) && isJson(value.locator) &&
		typeof value.position === 'number' && Number.isFinite(value.position) &&
		typeof value.text === 'string' && typeof value.color === 'string' && nullableString(value.chapter) &&
		typeof value.created_at === 'string' && nullableString(value.deleted_at);
}

function validNote(value: unknown): value is Note {
	return isRecord(value) && validRevision(value) && typeof value.id === 'string' && value.id.length > 0 &&
		typeof value.book_id === 'number' && Number.isSafeInteger(value.book_id) && value.book_id > 0 &&
		nullableString(value.highlight_id) && typeof value.body_md === 'string' &&
		typeof value.created_at === 'string' && nullableString(value.deleted_at);
}

function validSetting(value: unknown): value is Setting {
	return isRecord(value) && validRevision(value) && typeof value.key === 'string' &&
		value.key.length > 0 && isJson(value.value);
}

function isPullResponse(value: Record<string, unknown>): value is Record<string, unknown> & PullResponse {
	return typeof value.cursor === 'number' &&
		Array.isArray(value.user_books) && value.user_books.every(validUserBook) &&
		Array.isArray(value.reading_progress) && value.reading_progress.every(validProgress) &&
		Array.isArray(value.highlights) && value.highlights.every(validHighlight) &&
		Array.isArray(value.notes) && value.notes.every(validNote) &&
		Array.isArray(value.user_settings) && value.user_settings.every(validSetting);
}

function validResult(value: unknown, length: number): value is MutationResult {
	return isRecord(value) &&
		Number.isSafeInteger(value.index) && typeof value.index === 'number' &&
		value.index >= 0 && value.index < length &&
		(value.status === 'applied' || value.status === 'stale' || value.status === 'rejected') &&
		(value.reason === undefined || typeof value.reason === 'string');
}

export function parsePushResponse(value: unknown, length: number): MutationResult[] {
	if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== length ||
		!value.results.every((item: unknown) => validResult(item, length))) {
		throw new SyncProtocolError('The server returned an invalid push response.');
	}
	const results: MutationResult[] = value.results;
	if (new Set(results.map((item) => item.index)).size !== length) {
		throw new SyncProtocolError('The server returned duplicate push result indexes.');
	}
	return results;
}

export function parsePullResponse(value: unknown, requestedCursor: number): PullResponse {
	if (!isRecord(value) || typeof value.cursor !== 'number' ||
		!Number.isSafeInteger(value.cursor) || value.cursor < requestedCursor) {
		throw new SyncProtocolError('The server returned an invalid pull cursor.');
	}
	const high = value.cursor;
	const collections = ['user_books', 'reading_progress', 'highlights', 'notes', 'user_settings'] as const;
	for (const entity of collections) {
		const rows = value[entity];
		if (!Array.isArray(rows)) throw new SyncProtocolError(`The pull response is missing ${entity}.`);
		const keys = new Set<string>();
		for (const row of rows) {
			if (!isRecord(row) || typeof row.rev !== 'number' || !Number.isSafeInteger(row.rev) ||
				row.rev <= requestedCursor || row.rev > high || typeof row.updated_at !== 'string') {
				throw new SyncProtocolError(`The pull response contains an invalid ${entity} revision.`);
			}
			const key = entity === 'user_books' || entity === 'reading_progress'
				? row.book_id
				: entity === 'user_settings' ? row.key : row.id;
			if ((typeof key !== 'string' || key.length === 0) &&
				(typeof key !== 'number' || !Number.isSafeInteger(key) || key < 1)) {
				throw new SyncProtocolError(`The pull response contains an invalid ${entity} key.`);
			}
			if (keys.has(String(key))) throw new SyncProtocolError(`The pull response contains duplicate ${entity} keys.`);
			keys.add(String(key));
			if ((entity === 'highlights' || entity === 'notes') &&
				(typeof row.book_id !== 'number' || !Number.isSafeInteger(row.book_id) || row.book_id < 1)) {
				throw new SyncProtocolError(`The pull response contains an invalid ${entity} book.`);
			}
		}
	}
	if (!isPullResponse(value)) throw new SyncProtocolError('The pull response contains an invalid row.');
	return value;
}

function nextBatch(entries: OutboxEntry[]): OutboxEntry[] {
	const batch: OutboxEntry[] = [];
	const encoder = new TextEncoder();
	let size = encoder.encode('{"mutations":[]}').length;
	for (const entry of entries) {
		if (entry.status !== 'pending') continue;
		const addition = encoder.encode(JSON.stringify(entry.mutation)).length + (batch.length ? 1 : 0);
		if (size + addition > MAX_BODY_BYTES || batch.length === MAX_MUTATIONS) {
			if (!batch.length) throw new SyncProtocolError('A queued mutation exceeds the push request size limit.');
			break;
		}
		size += addition;
		batch.push(entry);
	}
	return batch;
}

async function verifyAccount(account: number, client: SyncTransport): Promise<void> {
	const active = await activeViewer();
	if (!active || active.id !== account || await client.viewer() !== account) {
		throw new AccountChangedError();
	}
}

export interface SyncReport {
	applied: number;
	issues: number;
}

export async function synchronize(
	account: number,
	client: SyncTransport = transport,
	now = Date.now()
): Promise<SyncReport> {
	return withSessionLock(async () => {
		let applied = 0;
		for (;;) {
			await verifyAccount(account, client);
			const batch = nextBatch(await outbox(account));
			if (!batch.length) break;
			const response = parsePushResponse(await client.push(batch.map((entry) => entry.mutation)), batch.length);
			await recordResults(account, batch, response);
			applied += response.filter((item) => item.status === 'applied').length;
		}

		await verifyAccount(account, client);
		const previous = await cursorState(account);
		const full = previous.cursor === 0 || (previous.pulledAt > 0 && now - previous.pulledAt >= FULL_RESYNC_MS);
		const requestedCursor = full ? 0 : previous.cursor;
		const response = parsePullResponse(await client.pull(requestedCursor), requestedCursor);
		await persistPull(account, previous.cursor, response, full, now);
		const remaining = await outbox(account);
		return { applied, issues: remaining.filter((entry) => entry.status === 'stale' || entry.status === 'rejected').length };
	}, true);
}
