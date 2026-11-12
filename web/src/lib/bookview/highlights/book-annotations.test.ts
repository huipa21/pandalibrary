import { describe, expect, it } from 'vitest';
import type { Book } from '#lib/catalog/types.js';
import type { BookState, Highlight, Note, PageAnnotation } from '#lib/reader/types.js';
import type { Review } from '../reviews-api.js';
import { filterBookAnnotations, otherBookAnnotations } from './book-annotations.js';
import { markStats } from './highlights-model.js';

const book: Book = {
	id: 7, library_id: 1, title: 'Book', sort_title: 'Book', subtitle: null, description: null,
	language: null, publisher: null, published_date: null, page_count: null, cover_url: null, cover_source: null,
	authors: [], series: null, tags: [], identifiers: [], files: [], field_sources: [], created_at: '', updated_at: ''
};
const created_at = '2026-11-01T10:00:00Z';
const common = { book_id: 7, created_at, updated_at: created_at, deleted_at: null, rev: 1 };
const highlight: Highlight = {
	...common, id: 'h', book_file_id: 70, locator: {}, position: 0.1, text: 'Passage', color: 'yellow', chapter: null
};
const note: Note = { ...common, id: 'note', highlight_id: null, body_md: 'Café note' };
const text: PageAnnotation = {
	...common, id: 'text', book_file_id: 70, locator: { type: 'pdf', page: 1, rect: { x: 0, y: 0, width: 1, height: 1 } },
	position: 0.5, kind: 'text', data: { text: 'Inserted text', color: '#112233', size: 0.02 }
};
const review: Review = { id: 1, book_id: 7, body: 'Review', author: { id: 1, display_name: 'Reader' }, created_at, updated_at: created_at, mine: true };
const state: BookState = {
	user_book: null, progress: null, bookmarks: [], highlights: [highlight],
	notes: [note, { ...note, id: 'attached', highlight_id: 'h' }, { ...note, id: 'orphan', highlight_id: 'gone' }],
	page_annotations: [
		text,
		{ ...text, id: 'ink', kind: 'ink', data: { color: '#112233', width: 0.01, strokes: [[0, 0, 1, 1]] } },
		{ ...text, id: 'image', kind: 'image', data: { asset: 'a'.repeat(64), media_type: 'image/png', width: 10, height: 10 } }
	]
};
const filter = { query: '', kind: '', colors: new Set<string>(), styles: new Set<string>(), notesOnly: false, sort: 'reading' as const };

describe('other book annotations', () => {
	it('includes reviews, private notes, orphan comments and all inserts without repeating attached comments', () => {
		const entries = otherBookAnnotations(book, state, review);
		expect(entries.map((entry) => entry.kind)).toEqual(['book_note', 'comment', 'text', 'ink', 'image', 'review']);
		expect(entries.find((entry) => entry.kind === 'ink')?.data?.strokes).toEqual([[0, 0, 1, 1]]);
		const stats = markStats([], new Date(created_at), [{ id: 70, format: 'pdf' }], entries);
		expect(stats.total).toBe(6);
		expect(stats.weeks.reduce((sum, week) => sum + week.count, 0)).toBe(6);
		expect(stats.byFormat).toContainEqual({ format: 'pdf', count: 3 });
	});

	it('excludes deleted and foreign-book entries and reviews', () => {
		const entries = otherBookAnnotations(book, {
			...state,
			notes: [{ ...note, book_id: 8 }, { ...note, deleted_at: created_at }],
			page_annotations: [{ ...text, book_id: 8 }, { ...text, deleted_at: created_at }]
		}, { ...review, book_id: 8 });
		expect(entries).toEqual([]);
	});

	it('applies type, text, notes and mark-only filters consistently', () => {
		const entries = otherBookAnnotations(book, state, review);
		expect(filterBookAnnotations(entries, { ...filter, kind: 'ink' }).map((row) => row.id)).toEqual(['ink']);
		expect(filterBookAnnotations(entries, { ...filter, query: 'cafe', kind: 'book_note' }).map((row) => row.id)).toEqual(['note']);
		expect(filterBookAnnotations(entries, { ...filter, notesOnly: true })).toHaveLength(2);
		expect(filterBookAnnotations(entries, { ...filter, colors: new Set(['yellow']) })).toEqual([]);
		expect(filterBookAnnotations(entries, { ...filter, styles: new Set(['underline']) })).toEqual([]);
		expect(filterBookAnnotations(entries, { ...filter, query: 'missing' })).toEqual([]);
		expect(filterBookAnnotations(entries, filter).at(-1)?.position).toBe(0.5);
		const newer = { ...entries[0], id: 'newer', created_at: '2026-11-02T10:00:00Z' };
		expect(filterBookAnnotations([...entries, newer], { ...filter, sort: 'newest' })[0].id).toBe('newer');
	});
});
