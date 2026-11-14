import type { Book, ContentRating } from '#lib/catalog/types.js';

export interface CandidatePerson {
	readonly name: string;
	readonly role: string;
}

export interface CandidateSeries {
	readonly name: string;
	readonly index: number | null;
	readonly total: number | null;
}

export interface CandidateIdentifier {
	readonly scheme: string;
	readonly value: string;
}

export interface Candidate {
	readonly provider: string;
	readonly reference: string;
	readonly title: string;
	readonly subtitle: string | null;
	readonly authors: CandidatePerson[];
	readonly description: string | null;
	readonly publisher: string | null;
	readonly published_date: string | null;
	readonly language: string | null;
	readonly page_count: number | null;
	readonly series: CandidateSeries | null;
	readonly tags: string[];
	readonly genres: string[];
	readonly moods: string[];
	readonly age_rating: number | null;
	readonly content_rating: ContentRating | null;
	/** Community rating normalized to 0-5. */
	readonly rating: number | null;
	readonly rating_count: number | null;
	readonly identifiers: CandidateIdentifier[];
	readonly cover_url: string | null;
}

export interface LookupError {
	readonly code: string;
	readonly message: string;
}

export interface ProviderResult {
	readonly provider: string;
	readonly candidates: Candidate[];
	readonly error: LookupError | null;
}

export interface LookupQuery {
	readonly isbn?: string;
	readonly title?: string;
	readonly author?: string;
	readonly language?: string;
	/** Restricts the lookup to these enabled providers; omitted means all. */
	readonly providers?: string[];
}

export interface LookupResponse {
	readonly request_key: string;
	readonly query: LookupQuery;
	readonly providers: ProviderResult[];
}

export const MERGE_FIELDS = [
	'title',
	'subtitle',
	'authors',
	'description',
	'language',
	'publisher',
	'published_date',
	'page_count',
	'series',
	'tags',
	'genres',
	'moods',
	'age_rating',
	'content_rating',
	'ratings',
	'identifiers',
	'cover'
] as const;

export type MergeField = (typeof MERGE_FIELDS)[number];

export interface CandidateRef {
	readonly provider: string;
	readonly reference: string;
}

/** A missing entry means "keep the current value"; it is never sent as a clear. */
export type Selections = Partial<Record<MergeField, CandidateRef>>;

export interface ApplyResponse {
	readonly book: Book;
}
