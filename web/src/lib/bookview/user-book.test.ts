import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushMutation, SyncError } from '#lib/reader/api.js';
import { notifyBookStateChanged } from './events.js';
import { isUserBook, previewUserBook, saveUserBook, statusPatch, type UserBook } from './user-book.js';

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

describe('saveUserBook', () => {
	it('narrows untrusted user-book state before it is passed to the kit', () => {
		expect(isUserBook(current)).toBe(true);
		expect(isUserBook({ ...current, status: 'invalid' })).toBe(false);
		expect(isUserBook({ ...current, rating: 0 })).toBe(false);
		expect(isUserBook({ ...current, rev: '3' })).toBe(false);
		expect(isUserBook(null)).toBe(false);
		expect(isUserBook([])).toBe(false);
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
