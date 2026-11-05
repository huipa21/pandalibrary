import type { JsonValue } from '#lib/api/client.js';
import type { Bookmark, BookState, Highlight, Note, Progress, Setting } from '#lib/reader/types.js';
import { OfflineStorageError, outbox, rows } from './db.js';
import type { OutboxEntry, StoredRow, SyncMutation, UserBookRow } from './types.js';

function number(data: SyncMutation['data'], key: string): number {
	const value = data[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new OfflineStorageError(`Invalid queued ${key}.`);
	return value;
}

function text(data: SyncMutation['data'], key: string): string {
	const value = data[key];
	if (typeof value !== 'string') throw new OfflineStorageError(`Invalid queued ${key}.`);
	return value;
}

function nullableText(data: SyncMutation['data'], key: string): string | null {
	const value = data[key];
	if (value === null || typeof value === 'string') return value;
	throw new OfflineStorageError(`Invalid queued ${key}.`);
}

function nullableNumber(data: SyncMutation['data'], key: string): number | null {
	const value = data[key];
	if (value === null || (typeof value === 'number' && Number.isFinite(value))) return value;
	throw new OfflineStorageError(`Invalid queued ${key}.`);
}

function json(data: SyncMutation['data'], key: string): JsonValue {
	if (!(key in data)) throw new OfflineStorageError(`Invalid queued ${key}.`);
	return data[key];
}

export function replayMutations(
	bookId: number,
	base: BookState,
	baseSettings: Setting[],
	entries: OutboxEntry[]
): { state: BookState; settings: Setting[] } {
	let userBook = base.user_book;
	let progress = base.progress;
	const highlights = new Map(base.highlights.map((item) => [item.id, item]));
	const bookmarks = new Map((base.bookmarks ?? []).map((item) => [item.id, item]));
	const notes = new Map(base.notes.map((item) => [item.id, item]));
	const settings = new Map(baseSettings.map((item) => [item.key, item]));

	for (const { mutation, status } of entries) {
		if (status === 'stale' || status === 'rejected') continue;
		const { entity, op, data } = mutation;
		const updatedAt = new Date(mutation.updated_at).toISOString();
		if (entity === 'reading_progress' && op === 'upsert' && data.book_id === bookId) {
			progress = {
				book_file_id: nullableNumber(data, 'book_file_id'),
				source: text(data, 'source'),
				locator: json(data, 'locator'),
				percentage: number(data, 'percentage'),
				device: text(data, 'device'),
				device_id: text(data, 'device_id'),
				updated_at: updatedAt,
				rev: progress?.rev ?? 0
			};
		} else if (entity === 'user_books' && op === 'upsert' && data.book_id === bookId) {
			userBook = { ...data, updated_at: updatedAt, rev: 0 };
		} else if (entity === 'user_settings' && 'key' in mutation && op === 'upsert') {
			const previous = settings.get(mutation.key);
			settings.set(mutation.key, {
				key: mutation.key, value: json(data, 'value'), updated_at: updatedAt, rev: previous?.rev ?? 0
			});
		} else if (entity === 'highlights' && 'id' in mutation) {
			if (op === 'delete') {
				highlights.delete(mutation.id);
				for (const [id, note] of notes) {
					if (note.highlight_id === mutation.id) notes.delete(id);
				}
			} else if (data.book_id === bookId) {
				const previous = highlights.get(mutation.id);
				highlights.set(mutation.id, {
					id: mutation.id,
					book_id: bookId,
					book_file_id: nullableNumber(data, 'book_file_id'),
					locator: json(data, 'locator'),
					position: number(data, 'position'),
					text: text(data, 'text'),
					color: text(data, 'color'),
					chapter: nullableText(data, 'chapter'),
					created_at: previous?.created_at ?? updatedAt,
					updated_at: updatedAt,
					deleted_at: null,
					rev: previous?.rev ?? 0
				});
			}
		} else if (entity === 'bookmarks' && 'id' in mutation) {
			if (op === 'delete') {
				bookmarks.delete(mutation.id);
			} else if (data.book_id === bookId) {
				const previous = bookmarks.get(mutation.id);
				bookmarks.set(mutation.id, {
					id: mutation.id,
					book_id: bookId,
					book_file_id: nullableNumber(data, 'book_file_id'),
					locator: json(data, 'locator'),
					position: number(data, 'position'),
					label: text(data, 'label'),
					chapter: nullableText(data, 'chapter'),
					created_at: previous?.created_at ?? updatedAt,
					updated_at: updatedAt,
					deleted_at: null,
					rev: previous?.rev ?? 0
				});
			}
		} else if (entity === 'notes' && 'id' in mutation) {
			if (op === 'delete') {
				notes.delete(mutation.id);
			} else if (data.book_id === bookId) {
				const previous = notes.get(mutation.id);
				notes.set(mutation.id, {
					id: mutation.id,
					book_id: bookId,
					highlight_id: nullableText(data, 'highlight_id'),
					body_md: text(data, 'body_md'),
					created_at: previous?.created_at ?? updatedAt,
					updated_at: updatedAt,
					deleted_at: null,
					rev: previous?.rev ?? 0
				});
			}
		}
	}
	return {
		state: { user_book: userBook, progress, highlights: [...highlights.values()], bookmarks: [...bookmarks.values()], notes: [...notes.values()] },
		settings: [...settings.values()]
	};
}

function snapshot(bookId: number, saved: StoredRow[]): { state: BookState; settings: Setting[] } {
	let userBook: UserBookRow | null = null;
	let progress: Progress | null = null;
	const highlights: Highlight[] = [];
	const bookmarks: Bookmark[] = [];
	const notes: Note[] = [];
	const settings: Setting[] = [];
	for (const row of saved) {
		switch (row.entity) {
			case 'user_books':
				if (row.value.book_id === bookId) userBook = row.value;
				break;
			case 'reading_progress':
				if (row.value.book_id === bookId) progress = row.value;
				break;
			case 'highlights':
				if (row.value.book_id === bookId && !row.value.deleted_at) highlights.push(row.value);
				break;
			case 'bookmarks':
				if (row.value.book_id === bookId && !row.value.deleted_at) bookmarks.push(row.value);
				break;
			case 'notes':
				if (row.value.book_id === bookId && !row.value.deleted_at) notes.push(row.value);
				break;
			case 'user_settings':
				settings.push(row.value);
				break;
		}
	}
	return { state: { user_book: userBook, progress, highlights, bookmarks, notes }, settings };
}

export async function readerState(
	account: number,
	bookId: number,
	online?: { state: BookState; settings: Setting[] }
): Promise<{ state: BookState; settings: Setting[] }> {
	const [saved, queued] = await Promise.all([rows(account), outbox(account)]);
	const base = online ?? snapshot(bookId, saved);
	return replayMutations(bookId, base.state, base.settings, queued);
}
