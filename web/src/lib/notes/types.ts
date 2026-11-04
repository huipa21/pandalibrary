/** R1 `GET /api/v1/search/annotations` item. `position` is a 0–1 book fraction for highlights and 0 for notes. */
export interface AnnotationResult {
	id: string;
	book_id: number;
	kind: 'highlight' | 'note' | (string & {});
	content: string;
	position: number;
	created_at: string;
}

export interface AnnotationSearchResponse {
	items: AnnotationResult[];
}

/** A distinct book represented in the visible results, in first-seen order. */
export interface ResultBook {
	book_id: number;
	matches: number;
}
