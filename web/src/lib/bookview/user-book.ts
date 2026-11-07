import * as m from '#lib/paraglide/messages.js';
import { pushMutation } from '#lib/reader/api.js';
import { notifyBookStateChanged } from './events.js';
import { parseDate } from './format.js';

export const READ_STATUSES = ['unread', 'want_to_read', 'reading', 'finished', 'abandoned'] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

/** Localized status label; `reading` reads "Re-reading" when the book has more than one attempt. */
export function readStatusLabel(status: ReadStatus, reread = false): string {
	switch (status) {
		case 'unread': return m['bv3.status_unread']();
		case 'want_to_read': return m['bv3.status_want_to_read']();
		case 'reading': return reread ? m['bv3.status_rereading']() : m['bv3.status_reading']();
		case 'finished': return m['bv3.status_finished']();
		case 'abandoned': return m['bv3.status_abandoned']();
	}
}

export interface UserBook {
	status: ReadStatus;
	rating: number | null;
	started_at: string | null;
	finished_at: string | null;
	updated_at: string;
	rev: number;
}

export type UserBookPatch = Partial<Pick<UserBook, 'status' | 'rating' | 'started_at' | 'finished_at'>>;

export function isUserBook(value: unknown): value is UserBook {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	if (!('status' in value && 'rating' in value && 'started_at' in value && 'finished_at' in value &&
		'updated_at' in value && 'rev' in value)) return false;
	return typeof value.status === 'string' && READ_STATUSES.some((status) => status === value.status) &&
		(value.rating === null || (typeof value.rating === 'number' && Number.isInteger(value.rating) &&
			value.rating >= 1 && value.rating <= 10)) &&
		(value.started_at === null || typeof value.started_at === 'string') &&
		(value.finished_at === null || typeof value.finished_at === 'string') &&
		typeof value.updated_at === 'string' && typeof value.rev === 'number' &&
		Number.isSafeInteger(value.rev) && value.rev >= 0;
}

export function statusPatch(current: UserBook | null, status: ReadStatus, now = new Date()): UserBookPatch {
	const patch: UserBookPatch = { status };
	if (status === 'reading' && !current?.started_at) patch.started_at = now.toISOString();
	if (status === 'finished' && !current?.finished_at) patch.finished_at = now.toISOString();
	return patch;
}

export function previewUserBook(current: UserBook | null, patch: UserBookPatch, now = new Date()): UserBook {
	return {
		status: patch.status ?? current?.status ?? 'unread',
		rating: patch.rating === undefined ? current?.rating ?? null : patch.rating,
		started_at: patch.started_at === undefined ? current?.started_at ?? null : patch.started_at,
		finished_at: patch.finished_at === undefined ? current?.finished_at ?? null : patch.finished_at,
		updated_at: now.toISOString(),
		rev: current?.rev ?? 0
	};
}

function timestamp(value: string | null): number | null {
	if (value === null) return null;
	const time = parseDate(value).getTime();
	if (time < 0) throw new RangeError('Invalid reading date.');
	return time;
}

export async function saveUserBook(bookId: number, current: UserBook | null, patch: UserBookPatch): Promise<void> {
	if (!Number.isSafeInteger(bookId) || bookId <= 0) throw new RangeError('Invalid book ID.');
	const status = patch.status ?? current?.status ?? 'unread';
	const rating = patch.rating === undefined ? current?.rating ?? null : patch.rating;
	const startedAt = patch.started_at === undefined ? current?.started_at ?? null : patch.started_at;
	const finishedAt = patch.finished_at === undefined ? current?.finished_at ?? null : patch.finished_at;
	if (!READ_STATUSES.includes(status)) throw new RangeError('Invalid reading status.');
	if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 10)) {
		throw new RangeError('Rating must be between 1 and 10.');
	}
	await pushMutation({
		entity: 'user_books',
		key: String(bookId),
		op: 'upsert',
		updated_at: Date.now(),
		data: {
			book_id: bookId,
			status,
			rating,
			started_at: timestamp(startedAt),
			finished_at: timestamp(finishedAt)
		}
	});
	notifyBookStateChanged(bookId);
}
