export interface Page<T> {
	readonly items: T[];
	readonly next_cursor: string | null;
}

export interface Library {
	readonly id: number;
	readonly icon?: string | null;
	readonly name: string;
	readonly slug: string;
	readonly visible_book_count: number;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface Author {
	readonly id: number;
	readonly name: string;
	readonly role: string;
	readonly position: number;
}

export interface Series {
	readonly id: number;
	readonly name: string;
	readonly index: number | null;
	readonly total: number | null;
}

export interface Tag {
	readonly id: number;
	readonly name: string;
}

export const CONTENT_RATINGS = ['everyone', 'teen', 'mature', 'adult'] as const;
export type ContentRating = (typeof CONTENT_RATINGS)[number];

/** A metadata provider's community rating normalized to a 0–5 scale. */
export interface ProviderRating {
	readonly provider: string;
	readonly rating: number | null;
	readonly count: number | null;
}

export interface Identifier {
	readonly scheme: string;
	readonly value: string;
}

export interface BookFile {
	readonly id: number;
	readonly format: string;
	readonly size_bytes: number;
	readonly download_url: string;
	/** Base name of the uploaded file; never contains a directory path. */
	readonly original_filename: string;
	/** RFC3339 UTC time the file was added. */
	readonly created_at: string;
	/** Whether an admin chose this file as the book's default. Absent on books saved offline before it existed. */
	readonly is_default?: boolean;
}

export interface FieldSource {
	readonly field: string;
	readonly source: string;
	readonly source_ref: string | null;
	readonly chosen_by: number | null;
	readonly chosen_at: string;
}

export interface Book {
	readonly id: number;
	readonly library_id: number;
	readonly owner_id: number | null;
	readonly visibility: 'public' | 'private' | 'library';
	readonly can_manage_visibility: boolean;
	readonly title: string;
	readonly sort_title: string;
	readonly subtitle: string | null;
	readonly description: string | null;
	readonly language: string | null;
	readonly publisher: string | null;
	readonly published_date: string | null;
	readonly page_count: number | null;
	readonly cover_url: string | null;
	readonly cover_source: string | null;
	readonly authors: Author[];
	readonly series: Series | null;
	readonly tags: Tag[];
	readonly genres: string[];
	readonly moods: string[];
	/** Minimum reader age in years (0–21). */
	readonly age_rating: number | null;
	readonly content_rating: ContentRating | null;
	readonly ratings: ProviderRating[];
	readonly identifiers: Identifier[];
	readonly files: BookFile[];
	readonly field_sources: FieldSource[];
	readonly created_at: string;
	readonly updated_at: string;
}

export interface CatalogEntity {
	readonly id: number;
	readonly name: string;
	readonly description?: string | null;
	readonly visible_book_count: number;
}

export type EntityKind = 'authors' | 'series' | 'tags';
export type BookSort = 'title' | 'added' | 'series';

export interface BookFilters {
	readonly library_id?: number;
	readonly author_id?: number;
	readonly series_id?: number;
	readonly tag_id?: number;
}
