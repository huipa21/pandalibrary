import { api } from '#lib/api/client.js';
import { requestErrorKind } from '#lib/paging/errors.js';
import type { AnnotationResult, AnnotationSearchResponse, ResultBook } from './types.js';
import type { AnnotationKindFilter } from './entry.js';

export const NOTES_QUERY_PARAM = 'q';
/** R1 rejects trimmed queries that are empty or longer than 200 characters (code points). */
export const MAX_ANNOTATION_QUERY_CHARS = 200;
/** Shorter queries use substring matching; longer ones use FTS phrase matching. */
export const PHRASE_QUERY_CHARS = 3;
/** R1 returns at most 100 newest matches and offers no pagination. */
export const MAX_ANNOTATION_RESULTS = 100;
export const EXCERPT_CHARS = 280;

export function normalizeAnnotationQuery(value: string | null | undefined): string {
	return (value ?? '').trim();
}

function codePoints(value: string): number {
	return [...value].length;
}

export type AnnotationQueryIssue = 'empty' | 'too_long';

export function annotationQueryIssue(query: string): AnnotationQueryIssue | null {
	const length = codePoints(query);
	if (length === 0) return 'empty';
	if (length > MAX_ANNOTATION_QUERY_CHARS) return 'too_long';
	return null;
}

export function isShortQuery(query: string): boolean {
	const length = codePoints(query);
	return length > 0 && length < PHRASE_QUERY_CHARS;
}

export function buildAnnotationSearchPath(query: string, kind: AnnotationKindFilter = ''): string {
	const params = new URLSearchParams({ q: query });
	if (kind) params.set('kind', kind);
	return `/search/annotations?${params}`;
}

export function notesPageHref(query: string, kind: AnnotationKindFilter = ''): string {
	const normalized = normalizeAnnotationQuery(query);
	const params = new URLSearchParams();
	if (normalized) params.set(NOTES_QUERY_PARAM, normalized);
	if (kind) params.set('kind', kind);
	return params.size ? `/notes?${params}` : '/notes';
}

export async function searchAnnotations(query: string, signal?: AbortSignal, kind: AnnotationKindFilter = ''): Promise<AnnotationResult[]> {
	const response = await api.request<AnnotationSearchResponse>(buildAnnotationSearchPath(query, kind), {
		signal,
		cache: 'no-store'
	});
	return Array.isArray(response.items) ? response.items : [];
}

export function annotationErrorKey(error: unknown): string {
	switch (requestErrorKind(error)) {
		case 'invalid':
			return 'notes.error.invalid';
		case 'connection':
			return 'notes.error.connection';
		case 'unauthorized':
			return 'notes.error.session';
		default:
			return 'notes.error.api';
	}
}

/** Plain-text preview of an untrusted body: whitespace collapsed, truncated by code point. */
export function excerpt(content: string, max = EXCERPT_CHARS): string {
	const text = content.replace(/\s+/g, ' ').trim();
	const characters = [...text];
	return characters.length <= max ? text : `${characters.slice(0, max).join('').trimEnd()}…`;
}

/** Highlight position as a percentage with one decimal, or null when not meaningful. */
export function positionPercent(result: Pick<AnnotationResult, 'kind' | 'position'>): number | null {
	if ((result.kind !== 'highlight' && result.kind !== 'text') || !Number.isFinite(result.position)) return null;
	if (result.position < 0 || result.position > 1) return null;
	return Math.round(result.position * 1000) / 10;
}

/** Distinct books in result order, with how many visible results each has. */
export function resultBooks(results: readonly AnnotationResult[]): ResultBook[] {
	const books = new Map<number, ResultBook>();
	for (const result of results) {
		const book = books.get(result.book_id);
		if (book) book.matches += 1;
		else books.set(result.book_id, { book_id: result.book_id, matches: 1 });
	}
	return [...books.values()];
}
