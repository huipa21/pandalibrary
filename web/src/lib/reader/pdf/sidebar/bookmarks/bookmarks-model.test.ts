import { describe, expect, it } from 'vitest';
import type { Bookmark } from '../../../types.js';
import { bookmarkPage, buildBookmarks, pageBookmark, validateBookmarkLabel } from './bookmarks-model.js';

const row = (id: string, extra: Partial<Bookmark> = {}): Bookmark => ({
	id, book_id: 21, book_file_id: 31, locator: { type: 'pdf', page: 1 }, position: 0,
	label: id, chapter: null, created_at: '2026-11-10T10:00:00Z', updated_at: '',
	deleted_at: null, rev: 1, ...extra
});
const selection = (page: number, y: number) => ({
	type: 'pdf', page, rects: [{ x: 0, y, width: 0.1, height: 0.1 }]
});

describe('bookmarks tab model', () => {
	it('orders live entries by page, y, time and identity without changing the source', () => {
		const rows = [
			row('second-page', { locator: selection(2, 0) }),
			row('lower', { locator: selection(1, 0.5) }),
			row('later', { locator: selection(1, 0.2), created_at: '2026-11-10T11:00:00Z' }),
			row('earlier', { locator: selection(1, 0.2) }),
			row('top'), row('deleted', { deleted_at: '2026-11-10T12:00:00Z' })
		];
		expect(buildBookmarks(rows, 31).current.map((item) => item.id))
			.toEqual(['top', 'earlier', 'later', 'lower', 'second-page']);
		expect(rows[0].id).toBe('second-page');
	});

	it('keeps unavailable and other-file bookmarks in a trailing group', () => {
		const rows = [
			row('current'), row('other', { book_file_id: 32 }), row('missing', { book_file_id: null }),
			row('cfi', { locator: { type: 'cfi', value: 'epubcfi(/6/2)' } }),
			row('invalid', { locator: { type: 'pdf', page: -1 } }),
			row('deleted', { book_file_id: 32, deleted_at: 'deleted' })
		];
		const result = buildBookmarks(rows, 31);
		expect(result.current.map((item) => item.id)).toEqual(['current']);
		expect(result.other.map((item) => item.id)).toEqual(['missing', 'other', 'cfi', 'invalid']);
		expect(bookmarkPage(rows[3])).toBeNull();
	});

	it('only counts a live bookmark without rects on this file and page for the toggle', () => {
		const rows = [
			row('selection', { locator: selection(1, 0.2) }),
			row('empty-rects', { locator: { type: 'pdf', page: 1, rects: [] } }),
			row('deleted', { deleted_at: 'deleted' }), row('other', { book_file_id: 32 }),
			row('page', { label: 'Renamed' })
		];
		expect(pageBookmark(rows, 31, 1)?.id).toBe('page');
		expect(pageBookmark(rows, 31, 2)).toBeUndefined();
		expect(pageBookmark(rows.slice(0, 4), 31, 1)).toBeUndefined();
	});

	it('trims labels and validates characters and the server byte limit', () => {
		expect(validateBookmarkLabel('  Chapter 1  ')).toEqual({ label: 'Chapter 1', error: null });
		expect(validateBookmarkLabel(' \n ')).toEqual({ label: null, error: 'length' });
		expect(validateBookmarkLabel('a'.repeat(200)).error).toBeNull();
		expect(validateBookmarkLabel('a'.repeat(201)).error).toBe('length');
		expect(validateBookmarkLabel('书'.repeat(170)).error).toBeNull();
		expect(validateBookmarkLabel('书'.repeat(171)).error).toBe('bytes');
		expect(validateBookmarkLabel('😀'.repeat(128)).error).toBeNull();
		expect(validateBookmarkLabel('😀'.repeat(129)).error).toBe('bytes');
	});
});
