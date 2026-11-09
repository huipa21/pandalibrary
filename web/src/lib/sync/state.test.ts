import { describe, expect, it } from 'vitest';
import type { BookState } from '#lib/reader/types.js';
import { replayMutations } from './state.js';
import type { OutboxEntry, SyncMutation } from './types.js';

const now = Date.parse('2026-11-08T00:00:00Z');
const iso = new Date(now).toISOString();
const empty: BookState = { user_book: null, progress: null, highlights: [], bookmarks: [], page_annotations: [], notes: [] };
const progress = {
	book_file_id: 3, source: 'web', percentage: 1, locator: { cfi: 'end' },
	device: 'Web', device_id: 'device', updated_at: iso, rev: 1
};
const userBook = {
	status: 'unread', rating: 7, started_at: null, finished_at: null, updated_at: iso, rev: 2
};

function queuedProgress(percentage: number, status: OutboxEntry['status'] = 'pending'): OutboxEntry {
	return {
		account: 1, sequence: 1, status,
		mutation: {
			entity: 'reading_progress', key: '21', op: 'upsert', updated_at: now,
			data: { ...progress, book_id: 21, percentage }
		}
	};
}

function queuedStatus(status: string): OutboxEntry {
	return {
		account: 1, sequence: 2, status: 'pending',
		mutation: {
			entity: 'user_books', key: '21', op: 'upsert', updated_at: now + 1,
			data: { ...userBook, book_id: 21, status, started_at: now + 1, finished_at: null }
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
		expect(replayMutations(21, empty, [], [queuedProgress(1)]).state.user_book).toMatchObject({
			status: 'finished', started_at: iso, finished_at: iso
		});
	});

	for (const status of ['on_hold', 'skimmed', 'abandoned', 'finished']) {
		it(`keeps manual ${status}`, () => {
			const base = { ...empty, user_book: { ...userBook, status } };
			expect(replayMutations(21, base, [], [queuedProgress(1)]).state.user_book).toEqual(base.user_book);
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
		const laterProgress = queuedProgress(0.5);
		expect(replayMutations(21, base, [], [restart, laterProgress, restart]).state.progress?.percentage).toBe(0.5);
		expect(replayMutations(21, base, [], [restart, queuedProgress(0.99)]).state.user_book)
			.toMatchObject({ status: 'finished', finished_at: iso });
		expect(replayMutations(21, empty, [], [restart]).state.progress).toBeNull();
	});

	it('ignores stale, rejected and other-book mutations', () => {
		const other = queuedProgress(1);
		other.mutation.data.book_id = 22;
		const result = replayMutations(21, empty, [], [queuedProgress(1, 'stale'), queuedProgress(1, 'rejected'), other]);
		expect(result.state).toEqual(empty);
	});
});
