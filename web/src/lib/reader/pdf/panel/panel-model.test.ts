import { describe, expect, it } from 'vitest';
import type { Bookmark, Highlight, Note, PageAnnotation } from '../../types.js';
import { buildPanel, excerpt, filterEntries } from './panel-model.js';

const dates = { created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z', deleted_at: null, rev: 1 };
const base = { ...dates, book_id: 21, book_file_id: 31, position: 0 };
const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
const highlight = (id: string, page: number, y = 0.2): Highlight => ({
	...base, id, locator: { type: 'pdf', page, rects: [{ ...rect, y }] },
	text: 'English 中文 text', color: 'green', chapter: null
});
const note = (id: string, highlight_id: string | null, body_md = 'A comment'): Note => ({
	...dates, id, book_id: 21, highlight_id, body_md
});
const bookmark: Bookmark = { ...base, id: 'bookmark', locator: { type: 'pdf', page: 2 }, label: 'Bookmark', chapter: null };
const insert: PageAnnotation = {
	...base, id: 'text', kind: 'text', locator: { type: 'pdf', page: 1, rect },
	data: { text: 'Inserted text 中文', color: '#112233', size: 0.02 }
};

function fixture() {
	return buildPanel({
		fileId: 31, format: 'pdf',
		highlights: [
			highlight('later-page', 2), highlight('low', 1, 0.5), highlight('first', 1, 0.1),
			{ ...highlight('older', 1, 0.1), created_at: '2026-10-01T00:00:00Z', style: 'underline' },
			{ ...highlight('other', 3), book_file_id: 32 },
			{ ...highlight('cfi', 1), locator: { type: 'cfi', value: 'epubcfi(/6/2)' } },
			{ ...highlight('deleted', 1), deleted_at: 'today' }
		],
		notes: [note('comment', 'first', 'A café comment 中文'), note('book', null), { ...note('gone', null), deleted_at: 'today' }],
		bookmarks: [bookmark, { ...bookmark, id: 'other-bookmark', book_file_id: null }],
		pageAnnotations: [
			insert,
			{ ...insert, id: 'ink', kind: 'ink', data: { color: '#112233', width: 0.01, strokes: [[0, 0, 1, 1]] } },
			{ ...insert, id: 'image', kind: 'image', data: { asset: 'a'.repeat(64), media_type: 'image/png', width: 100, height: 100 } },
			{ ...insert, id: 'other-insert', book_file_id: 32 }
		]
	});
}

describe('PDF annotations panel model', () => {
	it('sorts by page, y, creation date and id, and groups other files separately', () => {
		const panel = fixture();
		expect(panel.groups.map((group) => group.page)).toEqual([1, 2]);
		expect(panel.groups[0].entries.map((entry) => entry.id)).toEqual(['older', 'first', 'image', 'ink', 'text', 'low']);
		expect(panel.groups[1].entries.map((entry) => entry.id)).toEqual(['bookmark', 'later-page']);
		expect(panel.otherFile.map((entry) => entry.id).sort()).toEqual(['cfi', 'other', 'other-bookmark', 'other-insert']);
		expect(panel.bookNotes.map((entry) => entry.id)).toEqual(['book']);
		expect(panel.counts).toEqual({ all: 8, marks: 4, comments: 1, bookmarks: 1, inserts: 3 });
		expect(panel.groups[0].entries.find((entry) => entry.id === 'first')).toMatchObject({ style: 'highlight', commentExcerpt: 'A café comment 中文' });
	});

	it('filters every kind, full text and comments case-insensitively without breaking CJK', () => {
		const entries = fixture().groups.flatMap((group) => group.entries);
		expect(filterEntries(entries, 'marks', '')).toHaveLength(4);
		expect(filterEntries(entries, 'comments', '').map((entry) => entry.id)).toEqual(['first']);
		expect(filterEntries(entries, 'bookmarks', 'BOOK')).toHaveLength(1);
		expect(filterEntries(entries, 'inserts', '').map((entry) => entry.id)).toEqual(['image', 'ink', 'text']);
		expect(filterEntries(entries, 'all', 'CAFE').map((entry) => entry.id)).toEqual(['first']);
		expect(filterEntries(entries, 'inserts', '中文').map((entry) => entry.id)).toEqual(['text']);
		expect(filterEntries(entries, 'all', 'no match')).toEqual([]);
	});

	it('uses Unicode-safe excerpts but searches beyond the excerpt', () => {
		const text = '😀'.repeat(160) + '中文';
		expect(Array.from(excerpt(text))).toHaveLength(161);
		expect(excerpt(text)).toBe('😀'.repeat(160) + '…');
		const panel = buildPanel({ fileId: 31, format: 'pdf', highlights: [{ ...highlight('long', 1), text }], notes: [], bookmarks: [], pageAnnotations: [] });
		expect(filterEntries(panel.groups[0].entries, 'all', '中文')).toHaveLength(1);
	});

	it('handles an empty book', () => {
		expect(buildPanel({ fileId: 31, format: 'pdf', highlights: [], notes: [], bookmarks: [], pageAnnotations: [] }).groups).toEqual([]);
	});
});
