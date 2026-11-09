import { describe, expect, it } from 'vitest';
import type { BookState, PageAnnotation } from '#lib/reader/types.js';
import { replayMutations } from './state.js';
import type { OutboxEntry } from './types.js';

const now = Date.parse('2026-11-08T00:00:00Z');
const iso = new Date(now).toISOString();
const empty: BookState = { user_book: null, progress: null, highlights: [], bookmarks: [], page_annotations: [], notes: [] };
const page: PageAnnotation = {
	id: '018f0f7e-7b00-7000-8000-000000000001', book_id: 21, book_file_id: 3, kind: 'text',
	locator: { type: 'pdf', page: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }, position: 0.2,
	data: { text: 'Saved', color: '#000000', size: 0.02 },
	created_at: iso, updated_at: iso, deleted_at: null, rev: 1
};
const change = (at: number, status: OutboxEntry['status'] = 'pending'): OutboxEntry => ({
	account: 1, sequence: 1, status,
	mutation: {
		entity: 'page_annotations', id: page.id, op: 'upsert', updated_at: at,
		data: {
			book_id: 21, book_file_id: 3, kind: 'text', locator: page.locator, position: 0.2,
			data: { text: 'Edited', color: '#000000', size: 0.02 }
		}
	}
});

describe('offline annotation replay', () => {
	it('uses LWW for edits and deletes and ignores rejected or stale rows', () => {
		const base = { ...empty, page_annotations: [page] };
		expect(replayMutations(21, base, [], [change(now - 1)]).state.page_annotations).toEqual([page]);
		expect(replayMutations(21, base, [], [change(now + 1, 'stale')]).state.page_annotations).toEqual([page]);
		expect(replayMutations(21, base, [], [change(now + 1, 'rejected')]).state.page_annotations).toEqual([page]);
		expect(replayMutations(21, base, [], [change(now + 1)]).state.page_annotations)
			.toMatchObject([{ data: { text: 'Edited' }, created_at: iso }]);
		const deletion: OutboxEntry = {
			account: 1, sequence: 2, status: 'pending',
			mutation: { entity: 'page_annotations', id: page.id, op: 'delete', updated_at: now + 2, data: {} }
		};
		expect(replayMutations(21, base, [], [change(now + 1), deletion, change(now + 1)]).state.page_annotations)
			.toEqual([]);
		const tombstone = { ...page, updated_at: new Date(now + 2).toISOString(), deleted_at: new Date(now + 2).toISOString() };
		expect(replayMutations(21, empty, [], [change(now + 1)], [tombstone]).state.page_annotations).toEqual([]);
		expect(replayMutations(21, empty, [], [change(now + 3)], [tombstone]).state.page_annotations)
			.toMatchObject([{ created_at: iso, data: { text: 'Edited' } }]);
	});

	it('preserves the style when replaying an older highlight mutation', () => {
		const highlight = {
			id: 'highlight', book_id: 21, book_file_id: 3, locator: { type: 'pdf', page: 1 },
			position: 0.2, text: 'text', color: 'yellow', style: 'underline' as const, chapter: null,
			created_at: iso, updated_at: iso, deleted_at: null, rev: 1
		};
		const mutation: OutboxEntry = {
			account: 1, sequence: 1, status: 'pending',
			mutation: {
				entity: 'highlights', id: highlight.id, op: 'upsert', updated_at: now + 1,
				data: {
					book_id: 21, book_file_id: 3, locator: highlight.locator, position: 0.2,
					text: 'text', color: 'blue', chapter: null
				}
			}
		};
		expect(replayMutations(21, { ...empty, highlights: [highlight] }, [], [mutation]).state.highlights)
			.toMatchObject([{ color: 'blue', style: 'underline' }]);
		expect(replayMutations(21, empty, [], [mutation]).state.highlights)
			.toMatchObject([{ color: 'blue', style: 'highlight' }]);
	});

	it('returns page annotations in the same position and ID order as the server', () => {
		const later = { ...page, id: '018f0f7e-7b00-7000-8000-000000000003', position: 0.8 };
		const samePosition = { ...page, id: '018f0f7e-7b00-7000-8000-000000000002' };
		const result = replayMutations(21, { ...empty, page_annotations: [later, samePosition, page] }, [], []);
		expect(result.state.page_annotations?.map((item) => item.id)).toEqual([page.id, samePosition.id, later.id]);
	});
});
