import { describe, expect, it } from 'vitest';
import type { Bookmark, Highlight, Note, PageAnnotation } from '../../../types.js';
import { buildAnnotationList, excerpt, filterEntries, formatStamp, markdownExcerpt } from './annotations-list.js';
import { ANNOTATION_ROW_HEIGHT, annotationWindow } from './virtual-window.js';

const dates = { created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-02T10:00:00Z', deleted_at: null, rev: 1 };
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
	const input = {
		fileId: 31,
		highlights: [
			highlight('later-page', 2), highlight('low', 1, 0.5), highlight('first', 1, 0.1),
			{ ...highlight('older', 1, 0.1), created_at: '2026-10-01T00:00:00Z', style: 'underline' as const, color: '#000000' },
			{ ...highlight('other', 3), book_file_id: 32 },
			{ ...highlight('cfi', 1), locator: { type: 'cfi', value: 'epubcfi(/6/2)' } },
			{ ...highlight('deleted', 1), deleted_at: 'today' }
		],
		notes: [
			note('comment', 'first', 'A **café** [comment](https://example.com) 中文'),
			note('second', 'first', 'Another comment'), note('book', null),
			{ ...note('gone', null), deleted_at: 'today' }
		],
		bookmarks: [bookmark],
		pageAnnotations: [
			insert,
			{ ...insert, id: 'ink', kind: 'ink' as const, data: { color: '#112233', width: 0.01, strokes: [[0, 0, 1, 1]] } },
			{ ...insert, id: 'image', kind: 'image' as const, data: { asset: 'a'.repeat(64), media_type: 'image/png' as const, width: 100, height: 100 } },
			{ ...insert, id: 'other-insert', book_file_id: 32 }
		]
	};
	return buildAnnotationList(input);
}

describe('annotation list', () => {
	it('excludes bookmarks and deleted rows, sorts by page, y and creation, and separates other files', () => {
		const list = fixture();
		expect(list.entries.map((entry) => entry.id)).toEqual(['older', 'first', 'image', 'ink', 'text', 'low', 'later-page']);
		expect(list.otherFile.map((entry) => entry.id).sort()).toEqual(['cfi', 'other', 'other-insert']);
		expect(list.count).toBe(7);
		expect(list.entries[0]).toMatchObject({ swatch: { kind: 'mark', style: 'underline', hex: '#000000' } });
		expect(list.entries[1]).toMatchObject({
			createdAt: dates.created_at, updatedAt: dates.updated_at,
			commentExcerpt: 'A café comment 中文', swatch: { kind: 'mark', style: 'highlight', hex: '#4ade80' }
		});
		expect(list.entries.find((entry) => entry.id === 'ink')?.excerpt).toBe('Drawing');
		expect(list.entries.find((entry) => entry.id === 'image')?.excerpt).toBe('Image');
	});

	it('searches full mark text, all comments and text boxes with CJK and accent folding', () => {
		const entries = fixture().entries;
		expect(filterEntries(entries, 'CAFE').map((entry) => entry.id)).toEqual(['first']);
		expect(filterEntries(entries, 'another comment').map((entry) => entry.id)).toEqual(['first']);
		expect(filterEntries(entries, '中文').map((entry) => entry.id)).toEqual(['older', 'first', 'text', 'low', 'later-page']);
		expect(filterEntries(entries, 'inserted').map((entry) => entry.id)).toEqual(['text']);
		expect(filterEntries(entries, 'no match')).toEqual([]);
		const long = buildAnnotationList({ fileId: 31, highlights: [{ ...highlight('long', 1), text: 'x'.repeat(200) + '中文' }], notes: [], pageAnnotations: [] });
		expect(filterEntries(long.entries, '中文')).toHaveLength(1);
		const entities = buildAnnotationList({
			fileId: 31, highlights: [highlight('entity', 1)],
			notes: [note('entity-note', 'entity', 'tea &amp; coffee &copy;')], pageAnnotations: []
		});
		expect(filterEntries(entities.entries, 'tea & coffee ©')).toHaveLength(1);
	});

	it('lists current-file CFI marks in reading order with attached comments', () => {
		const cfi = (id: string, position: number): Highlight => ({
			...highlight(id, 1), position, locator: { type: 'cfi', value: 'epubcfi(/6/2)' }
		});
		const list = buildAnnotationList({
			fileId: 31, locatorType: 'cfi',
			highlights: [
				cfi('later', 0.8), cfi('first', 0.1), cfi('tied', 0.1),
				{ ...cfi('deleted', 0), deleted_at: 'today' }
			],
			notes: [note('attached', 'first', '**Café** 中文'), note('book', null)],
			pageAnnotations: []
		});
		expect(list.entries.map((entry) => entry.id)).toEqual(['first', 'tied', 'later']);
		expect(list.entries[0]).toMatchObject({
			page: null, y: 0, commentExcerpt: '**Café** 中文',
			notes: [{ id: 'attached' }]
		});
		expect(filterEntries(list.entries, 'CAFE').map((entry) => entry.id)).toEqual(['first']);
		expect(list.count).toBe(3);
	});

	it('keeps other-file and incompatible locators read-only in a CFI list', () => {
		const list = buildAnnotationList({
			fileId: 31, locatorType: 'cfi',
			highlights: [
				{ ...highlight('current', 1), locator: { type: 'cfi', value: 'epubcfi(/6/2)' } },
				{ ...highlight('other', 1), book_file_id: 32, locator: { type: 'cfi', value: 'epubcfi(/6/2)' } },
				highlight('pdf', 1),
				{ ...highlight('invalid', 1), locator: { type: 'cfi', value: '' } }
			],
			notes: [], pageAnnotations: [insert]
		});
		expect(list.entries.map((entry) => entry.id)).toEqual(['current']);
		expect(list.otherFile.map((entry) => entry.id).sort()).toEqual(['invalid', 'other', 'pdf', 'text']);
		expect(list.count).toBe(1);
	});

	it('strips Markdown from the first comment and caps excerpts at 160 code points', () => {
		expect(markdownExcerpt('# Heading\n\nA **bold** [link](https://example.com) and `code`.')).toBe('Heading A bold link and code.');
		expect(markdownExcerpt('中**文**测试\n\n- one\n- two')).toBe('中文测试 one two');
		expect(markdownExcerpt('<script>alert(1)</script>\n\nSafe')).toBe('Safe');
		expect(markdownExcerpt('中<b>文</b>测<br>试 <script>alert(1)</script>安全')).toBe('中文测 试 安全');
		expect(markdownExcerpt('Tea &amp; coffee &copy; &#x1F600; &lt;tag&gt;')).toBe('Tea & coffee © 😀 <tag>');
		expect(markdownExcerpt('`&amp;` and \\&amp; and &amp;amp;')).toBe('&amp; and &amp; and &amp;');
		expect(excerpt(' first\n  second ')).toBe('first second');
		expect(Array.from(markdownExcerpt('😀'.repeat(200)))).toHaveLength(160);
		expect(markdownExcerpt('😀'.repeat(200)).endsWith('…')).toBe(true);
	});

	it('formats same-year and older dates for English and Chinese', () => {
		const now = new Date(2026, 10, 11, 12, 0);
		const sameYear = new Date(2026, 10, 10, 14, 32).toISOString();
		const older = new Date(2025, 10, 10, 14, 32).toISOString();
		expect(formatStamp(sameYear, now, 'en')).toBe('Nov 10 14:32');
		expect(formatStamp(older, now, 'en')).toBe('Nov 10, 2025');
		expect(formatStamp(sameYear, now, 'zh')).toBe('11月10日 14:32');
		expect(formatStamp(older, now, 'zh')).toBe('2025年11月10日');
		expect(formatStamp('bad date', now, 'en')).toBe('bad date');
	});

	it('windows large lists without exceeding 80 entries and clamps at either end', () => {
		expect(annotationWindow(300, 0, 800)).toEqual({ start: 0, end: 300 });
		expect(annotationWindow(600, 0, 800)).toEqual({ start: 0, end: 27 });
		const middle = annotationWindow(600, 300 * ANNOTATION_ROW_HEIGHT, 800);
		expect(middle.start).toBe(294);
		expect(middle.end - middle.start).toBeLessThanOrEqual(80);
		expect(annotationWindow(600, 100000, 900).end).toBe(600);
		expect(annotationWindow(600, 0, 100000).end).toBe(40);
	});
});
