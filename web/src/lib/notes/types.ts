import type { InkData, PageAnnotationLocator } from '#lib/reader/types.js';

export interface AnnotationEntry {
	id: string;
	book_id: number;
	book_title: string;
	cover_url: string | null;
	kind: string;
	content: string;
	created_at: string;
	book_file_id?: number;
	highlight_id?: string;
	anchor?: string;
	locator?: PageAnnotationLocator;
	data?: InkData;
}

/** `GET /api/v1/search/annotations` item. Position is a book fraction for reader annotations. */
export interface AnnotationResult extends AnnotationEntry {
	kind: 'highlight' | 'note' | 'review' | 'text' | (string & {});
	position: number;
}

export interface AnnotationSearchResponse {
	items: AnnotationResult[];
}

/** A distinct book represented in the visible results, in first-seen order. */
export interface ResultBook {
	book_id: number;
	matches: number;
}
