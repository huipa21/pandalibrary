import { describe, expect, it } from 'vitest';
import { annotationHref, annotationKind, annotationTagClass } from './entry.js';
import type { AnnotationEntry } from './types.js';

const item: AnnotationEntry = {
	id: 'entry', kind: 'text', book_id: 21, book_file_id: 31,
	book_title: 'Book', cover_url: null, content: 'Text', created_at: ''
};

describe('annotation entries', () => {
	it('links reviews to book details, comments to their passage and inserts to their ID', () => {
		expect(annotationHref({ ...item, kind: 'review' })).toBe('/books/21#book-reviews-heading');
		for (const kind of ['note', 'comment', 'highlight', 'underline', 'strikeout']) {
			expect(annotationHref({ ...item, kind, highlight_id: 'passage' })).toBe('/read/21/31?highlight=passage');
		}
		for (const kind of ['text', 'ink', 'image']) {
			expect(annotationHref({ ...item, kind })).toBe('/read/21/31?annotation=entry');
		}
		expect(annotationHref({ ...item, kind: 'book_note' })).toBe('/books/21');
		expect(annotationHref({ ...item, book_file_id: undefined })).toBe('/books/21');
	});

	it('distinguishes passage comments from legacy private notes and uses distinct category colors', () => {
		expect(annotationKind({ ...item, kind: 'note', highlight_id: 'passage' })).toBe('comment');
		expect(annotationKind({ ...item, kind: 'note' })).toBe('book_note');
		const kinds = ['review', 'comment', 'highlight', 'underline', 'strikeout', 'text', 'ink', 'image', 'book_note'];
		expect(new Set(kinds.map(annotationTagClass)).size).toBe(kinds.length);
	});
});
