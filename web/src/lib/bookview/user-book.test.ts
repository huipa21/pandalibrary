import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushMutation, SyncError } from '#lib/reader/api.js';
import { notifyBookStateChanged } from './events.js';
import {
	autoStatus, AUTO_FINISH_THRESHOLD, isUserBook, previewUserBook, READ_STATUSES, readStatusLabel, saveUserBook, statusPatch, statusTone,
	userBookFromState, type UserBook
} from './user-book.js';

vi.mock('#lib/reader/api.js', async (importOriginal) => ({
	...await importOriginal<typeof import('#lib/reader/api.js')>(),
	pushMutation: vi.fn()
}));
vi.mock('./events.js', () => ({ notifyBookStateChanged: vi.fn() }));

const current: UserBook = {
	status: 'reading', rating: 7, started_at: '2026-01-02T03:04:05Z',
	finished_at: null, updated_at: '2026-01-03T00:00:00Z', rev: 3
};

afterEach(() => {
	vi.resetAllMocks();
	vi.useRealTimers();
});

describe('automatic status', () => {
	it('uses the 99% completion threshold', () => {
		expect(AUTO_FINISH_THRESHOLD).toBe(0.99);
	});

	for (const current of [null, ...READ_STATUSES]) {
		for (const percentage of [0, 0.001, 0.5, 0.989, 0.99, 1]) {
			it(`${current} at ${percentage}`, () => {
				let expected = null;
				if (current === null || current === 'unread' || current === 'want_to_read') {
					if (percentage > 0) expected = 'reading';
					if (percentage >= 0.99) expected = 'finished';
				} else if ((current === 'reading' || current === 'rereading') && percentage >= 0.99) {
					expected = 'finished';
				}
				expect(autoStatus(current, percentage)).toBe(expected);
			});
		}
	}
});

describe('saveUserBook', () => {
	it('exposes all localized statuses in menu order with reusable tones', () => {
		expect(READ_STATUSES).toEqual([
			'unread', 'want_to_read', 'reading', 'on_hold', 'rereading', 'finished', 'skimmed', 'abandoned'
		]);
		expect(READ_STATUSES.map(readStatusLabel)).toEqual([
			'Unread', 'Want to read', 'Reading', 'On hold', 'Re-reading', 'Read', 'Skimmed', 'Abandoned'
		]);
		expect(READ_STATUSES.map(statusTone)).toEqual([
			{ text: 'text-slate-500', ring: 'ring-slate-500' },
			{ text: 'text-violet-600', ring: 'ring-violet-600' },
			{ text: 'text-blue-600', ring: 'ring-blue-600' },
			{ text: 'text-amber-500', ring: 'ring-amber-500' },
			{ text: 'text-fuchsia-600', ring: 'ring-fuchsia-600' },
			{ text: 'text-green-600', ring: 'ring-green-600' },
			{ text: 'text-sky-500', ring: 'ring-sky-500' },
			{ text: 'text-rose-600', ring: 'ring-rose-600' }
		]);
	});

	it('narrows untrusted user-book state before it is passed to the kit', () => {
		expect(isUserBook(current)).toBe(true);
		for (const status of READ_STATUSES) expect(isUserBook({ ...current, status })).toBe(true);
		expect(isUserBook({ ...current, status: 'invalid' })).toBe(false);
		expect(isUserBook({ ...current, rating: 0 })).toBe(false);
		expect(isUserBook({ ...current, rev: '3' })).toBe(false);
		expect(isUserBook(null)).toBe(false);
		expect(isUserBook([])).toBe(false);
	});

	it('normalizes dates from queued user-book mutations without losing other fields', () => {
		const queued = {
			...current, started_at: Date.parse(current.started_at!), finished_at: Date.parse('2026-02-01T00:00:00Z')
		};
		expect(userBookFromState(queued)).toEqual({
			...current, started_at: '2026-01-02T03:04:05.000Z', finished_at: '2026-02-01T00:00:00.000Z'
		});
		expect(userBookFromState(null)).toBeNull();
		expect(() => userBookFromState({ ...queued, rating: 12 })).toThrow(TypeError);
	});

	it('sets only missing status dates and preserves the other fields in the optimistic preview', () => {
		const now = new Date('2026-11-07T00:00:00Z');
		expect(statusPatch(current, 'reading', now)).toEqual({ status: 'reading' });
		expect(statusPatch(current, 'finished', now)).toEqual({
			status: 'finished', finished_at: '2026-11-07T00:00:00.000Z'
		});
		const patch = statusPatch(null, 'reading', now);
		expect(previewUserBook(null, patch, now)).toEqual({
			status: 'reading', rating: null, started_at: now.toISOString(), finished_at: null,
			updated_at: now.toISOString(), rev: 0
		});
		expect(previewUserBook(current, { rating: null }, now).rating).toBeNull();
	});

	it('preserves unchanged values and converts dates to Unix milliseconds', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
		await saveUserBook(21, current, { rating: null, finished_at: '2026-11-06T00:00:00Z' });
		expect(pushMutation).toHaveBeenCalledWith({
			entity: 'user_books', key: '21', op: 'upsert', updated_at: Date.now(),
			data: {
				book_id: 21, status: 'reading', rating: null,
				started_at: Date.parse(current.started_at!), finished_at: Date.parse('2026-11-06T00:00:00Z')
			}
		});
		expect(notifyBookStateChanged).toHaveBeenCalledWith(21);
	});

	it('starts a new re-read once and persists the cleared finish date', async () => {
		const now = new Date('2026-11-07T00:00:00Z');
		const finished: UserBook = { ...current, status: 'finished', finished_at: '2026-02-01T00:00:00Z' };
		const patch = statusPatch(finished, 'rereading', now);
		expect(patch).toEqual({ status: 'rereading', started_at: now.toISOString(), finished_at: null });
		const preview = previewUserBook(finished, patch, now);
		expect(preview).toMatchObject({
			status: 'rereading', rating: 7, started_at: now.toISOString(), finished_at: null
		});
		expect(statusPatch(preview, 'rereading', new Date('2026-11-08T00:00:00Z'))).toEqual({ status: 'rereading' });
		expect(statusPatch({ ...preview, started_at: null }, 'rereading', now)).toEqual(patch);
		await saveUserBook(21, finished, patch);
		expect(pushMutation).toHaveBeenCalledWith(expect.objectContaining({
			data: { book_id: 21, status: 'rereading', rating: 7, started_at: now.getTime(), finished_at: null }
		}));
	});

	it('creates a new unread row with nullable fields when needed', async () => {
		await saveUserBook(21, null, { rating: 5 });
		expect(pushMutation).toHaveBeenCalledWith(expect.objectContaining({
			data: { book_id: 21, status: 'unread', rating: 5, started_at: null, finished_at: null }
		}));
	});

	it('does not notify after rejected writes or invalid input', async () => {
		vi.mocked(pushMutation).mockRejectedValue(new SyncError('stale'));
		await expect(saveUserBook(21, current, { status: 'finished' })).rejects.toBeInstanceOf(SyncError);
		await expect(saveUserBook(21, current, { rating: 11 })).rejects.toThrow(RangeError);
		await expect(saveUserBook(21, current, { started_at: 'not a date' })).rejects.toThrow(RangeError);
		await expect(saveUserBook(21, current, { started_at: '2026-02-31' })).rejects.toThrow(RangeError);
		await expect(saveUserBook(0, current, {})).rejects.toThrow(RangeError);
		expect(notifyBookStateChanged).not.toHaveBeenCalled();
		expect(pushMutation).toHaveBeenCalledOnce();
	});
});
