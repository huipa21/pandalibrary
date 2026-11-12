import * as m from '#lib/paraglide/messages.js';
import { pushMutation } from '#lib/reader/api.js';
import { notifyBookStateChanged } from './events.js';
import { parseDate } from './format.js';

export const READ_STATUSES = [
	'unread', 'want_to_read', 'reading', 'on_hold', 'rereading', 'finished', 'skimmed', 'abandoned'
] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

export const AUTO_FINISH_THRESHOLD = 0.99;

export const TERMINAL_STATUSES: readonly ReadStatus[] = ['finished', 'skimmed', 'abandoned'];

/** Read books keep 100% progress even when the reader moves; only rereading starts over. */
export const COMPLETED_STATUSES: readonly ReadStatus[] = ['finished', 'skimmed'];

export function isCompletedStatus(status: ReadStatus | null | undefined): boolean {
	return status !== null && status !== undefined && COMPLETED_STATUSES.includes(status);
}

/** The stored progress percentage for a position saved under the given status. */
export function storedPercentage(status: ReadStatus | null | undefined, percentage: number): number {
	return isCompletedStatus(status) ? 1 : percentage;
}

export function availableReadStatuses(current: UserBook | null, percentage = 0): ReadStatus[] {
	const status = current?.status ?? 'unread';
	const untouched = (status === 'unread' || status === 'want_to_read') &&
		!current?.started_at && !current?.finished_at && percentage <= 0 && (current?.reading_cycle ?? 1) <= 1;
	return READ_STATUSES.filter((next) => {
		if (next === status) return true;
		if (next === 'unread' || next === 'want_to_read') return untouched;
		if (next === 'rereading') return TERMINAL_STATUSES.includes(status) ||
			(status === 'on_hold' && (current?.resume_status === 'rereading' || (current?.reading_cycle ?? 1) > 1));
		if (next === 'on_hold') return status === 'reading' || status === 'rereading';
		return true;
	});
}

export function autoStatus(
	current: ReadStatus | null,
	percentage: number,
	context: { moved?: boolean; resumeStatus?: 'reading' | 'rereading'; readingCycle?: number } = {}
): ReadStatus | null {
	const status = current ?? 'unread';
	if (status === 'on_hold' && context.moved && percentage > 0) {
		return percentage >= AUTO_FINISH_THRESHOLD ? 'finished' : context.readingCycle !== undefined
			? context.readingCycle > 1 ? 'rereading' : 'reading'
			: context.resumeStatus ?? 'reading';
	}
	if (['unread', 'want_to_read', 'reading', 'rereading'].includes(status)) {
		if (percentage >= AUTO_FINISH_THRESHOLD) return 'finished';
		if (percentage > 0 && (status === 'unread' || status === 'want_to_read')) return 'reading';
	}
	return null;
}

export function readStatusLabel(status: ReadStatus): string {
	switch (status) {
		case 'unread': return m['bv3.status_unread']();
		case 'want_to_read': return m['bv3.status_want_to_read']();
		case 'reading': return m['bv3.status_reading']();
		case 'on_hold': return m['bc1.status_on_hold']();
		case 'rereading': return m['bv3.status_rereading']();
		case 'finished': return m['bc1.status_read']();
		case 'skimmed': return m['bc1.status_skimmed']();
		case 'abandoned': return m['bv3.status_abandoned']();
	}
}

const STATUS_TONES = {
	unread: { text: 'text-slate-500', ring: 'ring-slate-500' },
	want_to_read: { text: 'text-violet-600', ring: 'ring-violet-600' },
	reading: { text: 'text-blue-600', ring: 'ring-blue-600' },
	on_hold: { text: 'text-amber-500', ring: 'ring-amber-500' },
	rereading: { text: 'text-fuchsia-600', ring: 'ring-fuchsia-600' },
	finished: { text: 'text-green-600', ring: 'ring-green-600' },
	skimmed: { text: 'text-sky-500', ring: 'ring-sky-500' },
	abandoned: { text: 'text-rose-600', ring: 'ring-rose-600' }
} satisfies Record<ReadStatus, { text: string; ring: string }>;

export function statusTone(status: ReadStatus): { text: string; ring: string } {
	return STATUS_TONES[status];
}

export interface UserBook {
	status: ReadStatus;
	rating: number | null;
	started_at: string | null;
	finished_at: string | null;
	updated_at: string;
	rev: number;
	resume_status?: 'reading' | 'rereading';
	reading_cycle?: number;
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
		(!('resume_status' in value) || value.resume_status === undefined || value.resume_status === 'reading' || value.resume_status === 'rereading') &&
		(!('reading_cycle' in value) || value.reading_cycle === undefined ||
			(typeof value.reading_cycle === 'number' && Number.isSafeInteger(value.reading_cycle) && value.reading_cycle >= 1)) &&
		typeof value.updated_at === 'string' && typeof value.rev === 'number' &&
		Number.isSafeInteger(value.rev) && value.rev >= 0;
}

export function userBookFromState(value: unknown): UserBook | null {
	if (value === null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Invalid user book state.');
	}
	const date = (input: unknown) =>
		typeof input === 'number' ? new Date(input).toISOString() : input;
	const candidate = {
		...value,
		started_at: 'started_at' in value ? date(value.started_at) : undefined,
		finished_at: 'finished_at' in value ? date(value.finished_at) : undefined
	};
	if (!isUserBook(candidate)) throw new TypeError('Invalid user book state.');
	return candidate;
}

export function statusPatch(current: UserBook | null, status: ReadStatus, now = new Date()): UserBookPatch {
	if (!availableReadStatuses(current).includes(status)) throw new RangeError('Invalid reading status transition.');
	const patch: UserBookPatch = { status };
	if (status !== 'unread' && status !== 'want_to_read' && !current?.started_at) patch.started_at = now.toISOString();
	if (status === 'reading' || status === 'on_hold' || status === 'rereading') {
		if (current?.finished_at) patch.finished_at = null;
	}
	if (status === 'rereading' && (TERMINAL_STATUSES.includes(current?.status ?? 'unread') || !current?.started_at)) {
		patch.started_at = now.toISOString();
		patch.finished_at = null;
	}
	if (TERMINAL_STATUSES.includes(status) &&
		(!TERMINAL_STATUSES.includes(current?.status ?? 'unread') || !current?.finished_at)) {
		patch.finished_at = now.toISOString();
	}
	return patch;
}

export function previewUserBook(current: UserBook | null, patch: UserBookPatch, now = new Date()): UserBook {
	return {
		status: patch.status ?? current?.status ?? 'unread',
		rating: patch.rating === undefined ? current?.rating ?? null : patch.rating,
		started_at: patch.started_at === undefined ? current?.started_at ?? null : patch.started_at,
		finished_at: patch.finished_at === undefined ? current?.finished_at ?? null : patch.finished_at,
		updated_at: now.toISOString(),
		rev: current?.rev ?? 0,
		...(patch.status === 'rereading' && TERMINAL_STATUSES.includes(current?.status ?? 'unread')
			? { reading_cycle: (current?.reading_cycle ?? 1) + 1 }
			: current?.reading_cycle !== undefined ? { reading_cycle: current.reading_cycle } : {}),
		...(patch.status === 'on_hold'
			? { resume_status: current?.status === 'rereading' ? 'rereading' as const : current?.resume_status ?? 'reading' as const }
			: patch.status === undefined && current?.resume_status ? { resume_status: current.resume_status } : {})
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
	if (patch.status !== undefined && !availableReadStatuses(current).includes(patch.status)) {
		throw new RangeError('Invalid reading status transition.');
	}
	patch = patch.status === undefined ? patch : { ...statusPatch(current, patch.status), ...patch };
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
