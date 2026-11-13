import type { Book } from '#lib/catalog/types.js';
import type { AnnotationEntry } from '#lib/notes/types.js';
import type { BookState } from '#lib/reader/types.js';
import type { Review } from '../reviews-api.js';
import { foldText, type MarkSort } from './highlights-model.js';

export type BookAnnotation = AnnotationEntry & { position: number };

/** Highlights and their attached comments stay in the chapter list. */
export function otherBookAnnotations(book: Book, state: BookState, review: Review | null): BookAnnotation[] {
	const base = { book_id: book.id, book_title: book.title, cover_url: book.cover_url };
	const liveHighlights = new Set(state.highlights.filter((row) => row.book_id === book.id && !row.deleted_at).map((row) => row.id));
	const entries: BookAnnotation[] = [];
	for (const note of state.notes) {
		if (note.book_id !== book.id || note.deleted_at || !note.highlight_id || liveHighlights.has(note.highlight_id)) continue;
		entries.push({
			...base, id: note.id, kind: 'comment',
			content: note.body_md, created_at: note.created_at, position: 0
		});
	}
	for (const row of state.page_annotations ?? []) {
		if (row.book_id !== book.id || row.deleted_at) continue;
		entries.push({
			...base, id: row.id, kind: row.kind, book_file_id: row.book_file_id ?? undefined,
			locator: row.locator, position: row.position, created_at: row.created_at,
			content: row.kind === 'text' ? row.data.text : '',
			...(row.kind === 'ink' ? { data: row.data } : {})
		});
	}
	if (review?.book_id === book.id) {
		entries.push({ ...base, id: String(review.id), kind: 'review', content: review.body, created_at: review.created_at, position: 0 });
	}
	return entries;
}

export function filterBookAnnotations(
	entries: readonly BookAnnotation[],
	options: { query: string; kind: string; colors: ReadonlySet<string>; notesOnly: boolean; styles: ReadonlySet<string>; sort: MarkSort }
): BookAnnotation[] {
	const query = foldText(options.query);
	return entries.filter((entry) =>
		(!options.kind || entry.kind === options.kind) &&
		(!options.notesOnly || entry.kind === 'comment') &&
		options.colors.size === 0 && options.styles.size === 0 &&
		foldText(entry.content).includes(query)
	).sort((a, b) => options.sort === 'reading'
		? a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
		: (options.sort === 'newest' ? -1 : 1) * (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
}
