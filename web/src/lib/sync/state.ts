import type { JsonValue } from '#lib/api/client.js';
import {
	autoStatus, availableReadStatuses, statusPatch, storedPercentage, TERMINAL_STATUSES, userBookFromState
} from '#lib/bookview/user-book.js';
import { isHighlightStyle } from '#lib/reader/annotations.js';
import { validatePageAnnotationInput } from '#lib/reader/page-annotations.js';
import type { Bookmark, BookState, Highlight, Note, PageAnnotation, Progress, Setting } from '#lib/reader/types.js';
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

function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

export function replayMutations(
	bookId: number,
	base: BookState,
	baseSettings: Setting[],
	entries: OutboxEntry[],
	pageTombstones: PageAnnotation[] = []
): { state: BookState; settings: Setting[] } {
	let userBook = base.user_book;
	let progress = base.progress;
	const highlights = new Map(base.highlights.map((item) => [item.id, item]));
	const bookmarks = new Map((base.bookmarks ?? []).map((item) => [item.id, item]));
	const pageAnnotations = new Map((base.page_annotations ?? []).map((item) => [item.id, item]));
	const knownPages = new Map(pageAnnotations);
	const pageClocks = new Map<string, number>();
	for (const item of [...pageAnnotations.values(), ...pageTombstones]) {
		const clock = Date.parse(item.updated_at);
		if (!Number.isFinite(clock)) throw new OfflineStorageError('Invalid page annotation timestamp.');
		if (clock > (pageClocks.get(item.id) ?? -Infinity)) {
			pageClocks.set(item.id, clock);
			knownPages.set(item.id, item);
		}
	}
	const notes = new Map(base.notes.map((item) => [item.id, item]));
	const settings = new Map(baseSettings.map((item) => [item.key, item]));

	for (const { mutation, status } of entries) {
		if (status === 'stale' || status === 'rejected') continue;
		const { entity, op, data } = mutation;
		const updatedAt = new Date(mutation.updated_at).toISOString();
		if (entity === 'reading_progress' && op === 'upsert' && data.book_id === bookId) {
			if (progress && mutation.updated_at <= Date.parse(progress.updated_at)) continue;
			const previous = progress;
			const current = userBookFromState(userBook);
			progress = {
				book_file_id: nullableNumber(data, 'book_file_id'),
				source: text(data, 'source'),
				locator: json(data, 'locator'),
				percentage: storedPercentage(current?.status, number(data, 'percentage')),
				device: text(data, 'device'),
				device_id: text(data, 'device_id'),
				updated_at: updatedAt,
				rev: progress?.rev ?? 0
			};
			const next = autoStatus(current?.status ?? null, progress.percentage, {
				moved: progress.percentage !== (previous?.percentage ?? 0) ||
					canonicalJson(progress.locator) !== canonicalJson(previous?.locator ?? null),
				resumeStatus: current?.resume_status,
				readingCycle: current?.reading_cycle
			});
			if (next !== null && (!current || mutation.updated_at > Date.parse(current.updated_at))) {
				if (next === 'finished') progress = { ...progress, percentage: 1 };
				userBook = {
					...current,
					status: next,
					rating: current?.rating ?? null,
					started_at: current?.started_at ?? updatedAt,
					finished_at: next === 'finished' ? updatedAt : current?.finished_at ?? null,
					updated_at: updatedAt,
					rev: current?.rev ?? 0
				};
			}
		} else if (entity === 'user_books' && op === 'upsert' && data.book_id === bookId) {
			const current = userBookFromState(userBook);
			if (current && mutation.updated_at <= Date.parse(current.updated_at)) continue;
			let next;
			try {
				next = userBookFromState({ ...data, updated_at: updatedAt, rev: current?.rev ?? 0 });
			} catch {
				throw new OfflineStorageError('Invalid queued user book.');
			}
			if (!next || !availableReadStatuses(current, progress?.percentage ?? 0).includes(next.status)) {
				throw new OfflineStorageError('Invalid queued reading status transition.');
			}
			const dates = statusPatch(current, next.status, new Date(mutation.updated_at));
			if (dates.started_at !== undefined &&
				(next.started_at === null || (next.status === 'rereading' && TERMINAL_STATUSES.includes(current?.status ?? 'unread')))) {
				next.started_at = dates.started_at;
			}
			if (dates.finished_at !== undefined) next.finished_at = dates.finished_at;
			if (TERMINAL_STATUSES.includes(current?.status ?? 'unread') && TERMINAL_STATUSES.includes(next.status) && current?.finished_at) {
				next.finished_at = current.finished_at;
			}
			const restarting = next.status === 'rereading' && TERMINAL_STATUSES.includes(current?.status ?? 'unread');
			const completing = (next.status === 'finished' || next.status === 'skimmed') &&
				(next.status !== current?.status || progress === null);
			if (restarting || completing) {
				const percentage = restarting ? 0 : 1;
				const progressUpdatedAt = new Date(Math.max(mutation.updated_at, progress ? Date.parse(progress.updated_at) + 1 : 0)).toISOString();
				progress = progress
					? { ...progress, percentage, ...(restarting ? { locator: null } : {}), updated_at: progressUpdatedAt }
					: {
						book_file_id: null, source: 'web', percentage, locator: null,
						device: '', device_id: '', updated_at: progressUpdatedAt, rev: 0
					};
			}
			userBook = {
				...next,
				...(next.status === 'rereading' && TERMINAL_STATUSES.includes(current?.status ?? 'unread')
					? { reading_cycle: (current?.reading_cycle ?? 1) + 1 }
					: current?.reading_cycle !== undefined ? { reading_cycle: current.reading_cycle } : {}),
				...(next.status === 'on_hold'
					? { resume_status: current?.status === 'rereading' ? 'rereading' : current?.resume_status ?? 'reading' }
					: {})
			};
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
				const style = data.style === undefined ? (previous?.style ?? 'highlight') : data.style;
				if (!isHighlightStyle(style)) throw new OfflineStorageError('Invalid queued highlight style.');
				highlights.set(mutation.id, {
					id: mutation.id,
					book_id: bookId,
					book_file_id: nullableNumber(data, 'book_file_id'),
					locator: json(data, 'locator'),
					position: number(data, 'position'),
					text: text(data, 'text'),
					color: text(data, 'color'),
					style,
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
		} else if (entity === 'page_annotations' && 'id' in mutation) {
			const previous = pageAnnotations.get(mutation.id);
			const known = knownPages.get(mutation.id);
			const clock = pageClocks.get(mutation.id);
			if (clock !== undefined && mutation.updated_at <= clock) continue;
			if (op === 'delete') {
				if (previous) {
					pageAnnotations.delete(mutation.id);
					pageClocks.set(mutation.id, mutation.updated_at);
					knownPages.set(mutation.id, { ...previous, updated_at: updatedAt, deleted_at: updatedAt });
				}
			} else if (data.book_id === bookId) {
				const input: unknown = {
					kind: data.kind, locator: data.locator, position: data.position, data: data.data
				};
				if (!validatePageAnnotationInput(input) || (known && known.kind !== input.kind)) {
					throw new OfflineStorageError('Invalid queued page annotation.');
				}
				const value: PageAnnotation = {
					...input, id: mutation.id, book_id: bookId,
					book_file_id: data.book_file_id === undefined ? null : nullableNumber(data, 'book_file_id'),
					created_at: known?.created_at ?? updatedAt,
					updated_at: updatedAt, deleted_at: null, rev: known?.rev ?? 0
				};
				pageAnnotations.set(mutation.id, value);
				knownPages.set(mutation.id, value);
				pageClocks.set(mutation.id, mutation.updated_at);
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
		state: {
			user_book: userBook, progress, highlights: [...highlights.values()], bookmarks: [...bookmarks.values()],
			page_annotations: [...pageAnnotations.values()].sort((a, b) =>
				a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
			),
			notes: [...notes.values()]
		},
		settings: [...settings.values()]
	};
}

function snapshot(bookId: number, saved: StoredRow[]): { state: BookState; settings: Setting[] } {
	let userBook: UserBookRow | null = null;
	let progress: Progress | null = null;
	const highlights: Highlight[] = [];
	const bookmarks: Bookmark[] = [];
	const pageAnnotations: PageAnnotation[] = [];
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
			case 'page_annotations':
				if (row.value.book_id === bookId && !row.value.deleted_at) pageAnnotations.push(row.value);
				break;
			case 'notes':
				if (row.value.book_id === bookId && !row.value.deleted_at) notes.push(row.value);
				break;
			case 'user_settings':
				settings.push(row.value);
				break;
		}
	}
	return { state: { user_book: userBook, progress, highlights, bookmarks, page_annotations: pageAnnotations, notes }, settings };
}

export async function readerState(
	account: number,
	bookId: number,
	online?: { state: BookState; settings: Setting[] }
): Promise<{ state: BookState; settings: Setting[] }> {
	const [saved, queued] = await Promise.all([rows(account), outbox(account)]);
	const base = online ?? snapshot(bookId, saved);
	const tombstones = saved.flatMap((row) =>
		row.entity === 'page_annotations' && row.value.book_id === bookId && row.value.deleted_at ? [row.value] : []
	);
	return replayMutations(bookId, base.state, base.settings, queued, tombstones);
}
