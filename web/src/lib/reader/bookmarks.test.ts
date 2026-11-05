import { describe, expect, it } from 'vitest';
import { bookmarkForPosition, deleteBookmark, makeBookmark, updateBookmarkLabel } from './bookmarks.js';
import type { Bookmark } from './types.js';

const saved: Bookmark = {
	id: '019a4d48-cc00-7000-8000-000000000001', book_id: 21, book_file_id: 31,
	locator: { type: 'cfi', value: 'epubcfi(/6/2)' }, position: 0.4, label: 'Original',
	chapter: null, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z',
	deleted_at: null, rev: 1
};

describe('saved positions', () => {
	it('uses the same identity for the local bookmark and durable mutation', () => {
		const mutation = makeBookmark(21, 31, { locator: { type: 'pdf', page: 2 }, fraction: 0.5 }, 'Page', saved.id);
		expect(mutation).toMatchObject({
			id: saved.id, entity: 'bookmarks', data: { book_id: 21, book_file_id: 31, locator: { type: 'pdf', page: 2 } }
		});
		expect(deleteBookmark(saved.id)).toMatchObject({ id: saved.id, op: 'delete' });
	});

	it('edits a label without moving the saved location', () => {
		const mutation = updateBookmarkLabel(saved, 'Renamed');
		expect(mutation).toMatchObject({ id: saved.id, data: { locator: saved.locator, position: 0.4, label: 'Renamed' } });
		expect(() => updateBookmarkLabel({ ...saved, book_file_id: null }, 'Renamed')).toThrow('unavailable');
	});

	it('only jumps to a compatible file and validates byte limits', () => {
		expect(bookmarkForPosition(saved, 31, 'epub')).toBe(true);
		expect(bookmarkForPosition(saved, 32, 'epub')).toBe(false);
		expect(bookmarkForPosition(saved, 31, 'pdf')).toBe(false);
		expect(() => updateBookmarkLabel(saved, '书'.repeat(171))).toThrow('server limits');
	});
});
