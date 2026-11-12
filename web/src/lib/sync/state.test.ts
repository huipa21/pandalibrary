import { describe, expect, it } from 'vitest';
import type { BookState } from '#lib/reader/types.js';
import { replayMutations } from './state.js';
import type { OutboxEntry, SyncMutation } from './types.js';

const now = Date.parse('2026-11-08T00:00:00Z');
const iso = new Date(now).toISOString();
const empty: BookState = { user_book: null, progress: null, highlights: [], bookmarks: [], page_annotations: [], notes: [] };
const progress = {
	book_file_id: 3, source: 'web', percentage: 1, locator: { cfi: 'end' },
	device: 'Web', device_id: 'device', updated_at: new Date(now - 1).toISOString(), rev: 1
};
const userBook = {
	status: 'unread', rating: 7, started_at: null, finished_at: null, updated_at: new Date(now - 1).toISOString(), rev: 2
};

function queuedProgress(percentage: number, status: OutboxEntry['status'] = 'pending', time = now): OutboxEntry {
	return {
		account: 1, sequence: 1, status,
		mutation: {
			entity: 'reading_progress', key: '21', op: 'upsert', updated_at: time,
			data: { ...progress, book_id: 21, percentage }
		}
	};
}

function queuedStatus(status: string, time = now + 1): OutboxEntry {
	return {
		account: 1, sequence: 2, status: 'pending',
		mutation: {
			entity: 'user_books', key: '21', op: 'upsert', updated_at: time,
			data: { ...userBook, book_id: 21, status, started_at: time, finished_at: null }
		}
	};
}

describe('offline status lifecycle', () => {
	it('creates a status only when first progress is positive, without changing queued data', () => {
		const entry = queuedProgress(0.4);
		const original: SyncMutation = structuredClone(entry.mutation);
		const result = replayMutations(21, empty, [], [entry]).state;
		expect(result.user_book).toMatchObject({
			status: 'reading', rating: null, started_at: iso, finished_at: null
		});
		expect(entry.mutation).toEqual(original);
		expect(empty.user_book).toBeNull();
		expect(replayMutations(21, empty, [], [queuedProgress(0)]).state.user_book).toBeNull();
	});

	it('finishes at 99% and preserves existing rating and start date', () => {
		const base = { ...empty, user_book: { ...userBook, started_at: now - 1000 } };
		const result = replayMutations(21, base, [], [queuedProgress(0.99)]).state;
		expect(result.user_book).toMatchObject({
			status: 'finished', rating: 7, started_at: new Date(now - 1000).toISOString(), finished_at: iso
		});
		expect(result.progress).toMatchObject({ percentage: 1, locator: progress.locator });
		expect(replayMutations(21, empty, [], [queuedProgress(1)]).state.user_book).toMatchObject({
			status: 'finished', started_at: iso, finished_at: iso
		});
	});

	for (const status of ['skimmed', 'abandoned', 'finished']) {
		it(`keeps manual ${status}`, () => {
			const base = { ...empty, user_book: { ...userBook, status, finished_at: now - 1000 }, progress };
			expect(replayMutations(21, base, [], [queuedProgress(1)]).state.user_book).toEqual(base.user_book);
			const entry = queuedProgress(0.3);
			entry.mutation.data = { ...entry.mutation.data, locator: { cfi: 'middle' }, book_file_id: 4, device: 'Phone' };
			const moved = replayMutations(21, base, [], [entry]).state;
			expect(moved.user_book).toEqual(base.user_book);
			expect(moved.progress).toMatchObject({
				percentage: status === 'abandoned' ? 0.3 : 1, locator: { cfi: 'middle' }, book_file_id: 4, device: 'Phone',
				updated_at: iso
			});
		});
	}

	it('restarts progress once, preserving file and device, then finishes again', () => {
		const base = { ...empty, user_book: { ...userBook, status: 'finished' }, progress };
		const restart = queuedStatus('rereading');
		const result = replayMutations(21, base, [], [restart]).state;
		expect(result.progress).toEqual({
			...progress, percentage: 0, locator: null, updated_at: new Date(now + 1).toISOString()
		});
		expect(base.progress.percentage).toBe(1);
		const laterProgress = queuedProgress(0.5, 'pending', now + 2);
		expect(replayMutations(21, base, [], [restart, laterProgress, restart]).state.progress?.percentage).toBe(0.5);
		expect(replayMutations(21, base, [], [restart, queuedProgress(0.99, 'pending', now + 2)]).state.user_book)
			.toMatchObject({ status: 'finished', finished_at: new Date(now + 2).toISOString() });
		expect(() => replayMutations(21, empty, [], [restart])).toThrow('transition');
		expect(replayMutations(21, { ...base, progress: null }, [], [restart]).state.progress).toMatchObject({
			percentage: 0, locator: null
		});
	});

	it('resumes on hold on increased progress or a new locator, but not repeated restoration', () => {
		const base = { ...empty, user_book: { ...userBook, status: 'on_hold' }, progress: { ...progress, percentage: 0.5 } };
		expect(replayMutations(21, base, [], [queuedProgress(0.5)]).state.user_book).toEqual(base.user_book);
		expect(replayMutations(21, base, [], [queuedProgress(0.6)]).state.user_book).toMatchObject({ status: 'reading' });
		const moved = queuedProgress(0.5);
		moved.mutation.data.locator = { cfi: 'next' };
		expect(replayMutations(21, base, [], [moved]).state.user_book).toMatchObject({ status: 'reading' });
		expect(replayMutations(21, base, [], [queuedProgress(0.99)]).state.user_book).toMatchObject({ status: 'finished' });
	});

	it('retains the reread through pause, resume, and later completion', () => {
		const base = { ...empty, user_book: { ...userBook, status: 'finished' }, progress };
		const result = replayMutations(21, base, [], [
			queuedStatus('rereading'), queuedProgress(0.2, 'pending', now + 2),
			queuedStatus('on_hold', now + 3), queuedProgress(0.4, 'pending', now + 4)
		]).state;
		expect(result.user_book).toMatchObject({ status: 'rereading', reading_cycle: 2, finished_at: null });
		const held = { ...result, user_book: { ...result.user_book as object, status: 'on_hold' } };
		expect(replayMutations(21, held, [], [queuedProgress(0.6, 'pending', now + 5)]).state.user_book).toMatchObject({ status: 'rereading' });
		expect(replayMutations(21, held, [], [queuedProgress(0.99, 'pending', now + 5)]).state.user_book).toMatchObject({ status: 'finished' });
	});

	for (const status of ['finished', 'skimmed']) {
		it(`sets manually selected ${status} to 100%, including without a progress row`, () => {
			expect(replayMutations(21, empty, [], [queuedStatus(status)]).state.progress).toMatchObject({
				percentage: 1, locator: null
			});
			const base = { ...empty, progress: { ...progress, percentage: 0.2 } };
			expect(replayMutations(21, base, [], [queuedStatus(status)]).state.progress).toMatchObject({
				percentage: 1, locator: progress.locator
			});
		});
		it(`keeps ${status} rating-only updates from overwriting a revisited position`, () => {
			const base = { ...empty, user_book: { ...userBook, status }, progress: { ...progress, percentage: 0.4 } };
			const entry = queuedStatus(status);
			entry.mutation.data.rating = 9;
			const result = replayMutations(21, base, [], [entry]).state;
			expect(result.user_book).toMatchObject({ status, rating: 9 });
			expect(result.progress?.percentage).toBe(0.4);
			expect(replayMutations(21, { ...base, progress: null }, [], [entry]).state.progress?.percentage).toBe(1);
		});
	}

	it('preserves abandoned progress until manually resumed reading can auto-finish', () => {
		const base = { ...empty, user_book: { ...userBook, status: 'reading' }, progress: { ...progress, percentage: 0.3 } };
		const abandoned = replayMutations(21, base, [], [queuedStatus('abandoned')]).state;
		expect(abandoned.progress?.percentage).toBe(0.3);
		expect(replayMutations(21, abandoned, [], [queuedProgress(0.99)]).state.user_book).toMatchObject({ status: 'abandoned' });
		expect(replayMutations(21, abandoned, [], [queuedStatus('reading', now + 2), queuedProgress(0.99, 'pending', now + 3)]).state.user_book)
			.toMatchObject({ status: 'finished' });
		expect(() => replayMutations(21, abandoned, [], [queuedStatus('unread', now + 2)])).toThrow('transition');
	});

	it('ignores stale pending lifecycle writes before validating their transitions', () => {
		const base = { ...empty, user_book: { ...userBook, status: 'finished', updated_at: new Date(now + 5).toISOString() }, progress };
		expect(replayMutations(21, base, [], [queuedStatus('unread')]).state).toEqual(base);
		const result = replayMutations(21, { ...base, progress: { ...progress, updated_at: new Date(now + 5).toISOString() } },
			[], [queuedProgress(0.1)]).state;
		expect(result.progress?.percentage).toBe(1);
	});

	it('compares locator values independently of JSON property order', () => {
		const base = {
			...empty, user_book: { ...userBook, status: 'on_hold' },
			progress: { ...progress, percentage: 0.5, locator: { type: 'pdf', page: 2 } }
		};
		const entry = queuedProgress(0.5);
		entry.mutation.data.locator = { page: 2, type: 'pdf' };
		expect(replayMutations(21, base, [], [entry]).state.user_book).toEqual(base.user_book);
	});

	it('ignores stale, rejected and other-book mutations', () => {
		const other = queuedProgress(1);
		other.mutation.data.book_id = 22;
		const result = replayMutations(21, empty, [], [queuedProgress(1, 'stale'), queuedProgress(1, 'rejected'), other]);
		expect(result.state).toEqual(empty);
	});
});
