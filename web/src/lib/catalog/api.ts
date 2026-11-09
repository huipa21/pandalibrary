import { api } from '#lib/api/client.js';
import type { Shelf } from '#lib/shelves/types.js';
import type {
	Book,
	BookFilters,
	BookSort,
	CatalogEntity,
	EntityKind,
	Library,
	Page
} from './types.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export interface PageOptions {
	readonly cursor?: string | null;
	readonly limit?: number;
}

function pageParams(options: PageOptions = {}): URLSearchParams {
	const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
	const params = new URLSearchParams({ limit: String(limit) });
	if (options.cursor !== undefined && options.cursor !== null) {
		params.set('cursor', options.cursor);
	}
	return params;
}

export function buildPagePath(path: string, options: PageOptions = {}): string {
	return `${path}?${pageParams(options).toString()}`;
}

export function buildBooksPath(
	filters: BookFilters,
	sort: BookSort,
	options: PageOptions = {}
): string {
	const params = pageParams(options);
	params.set('sort', sort);
	for (const key of ['library_id', 'author_id', 'series_id', 'tag_id'] as const) {
		const value = filters[key];
		if (value !== undefined) params.set(key, String(value));
	}
	return `/books?${params.toString()}`;
}

export async function listLibraries(options: PageOptions = {}): Promise<Page<Library>> {
	return api.request(buildPagePath('/libraries', options));
}

export async function getLibrary(id: number): Promise<Library> {
	const response = await api.request<{ library: Library }>(`/libraries/${id}`);
	return response.library;
}

export async function listBooks(
	filters: BookFilters,
	sort: BookSort,
	options: PageOptions = {}
): Promise<Page<Book>> {
	return api.request(buildBooksPath(filters, sort, options));
}

/** Counts every book visible to the viewer across all libraries (the unfiltered All Books list). */
export async function countBooks(signal?: AbortSignal): Promise<number> {
	const response = await api.request<{ count: number }>(
		'/books/count',
		signal === undefined ? {} : { signal }
	);
	return response.count;
}

export async function getBook(id: number): Promise<Book> {
	const response = await api.request<{ book: Book }>(`/books/${id}`);
	return response.book;
}

/** Lists the viewer-visible manual shelves (including Favorites) that contain a book. */
export async function getBookShelves(bookId: number, signal?: AbortSignal): Promise<Shelf[]> {
	const response = await api.request<{ shelves: Shelf[] }>(
		`/books/${bookId}/shelves`,
		signal === undefined ? {} : { signal }
	);
	return response.shelves;
}

export async function listEntities(
	kind: EntityKind,
	options: PageOptions = {}
): Promise<Page<CatalogEntity>> {
	return api.request(buildPagePath(`/${kind}`, options));
}

export async function getEntity(kind: EntityKind, id: number): Promise<CatalogEntity> {
	const key = kind === 'authors' ? 'author' : kind === 'series' ? 'series' : 'tag';
	const response = await api.request<Record<string, CatalogEntity>>(`/${kind}/${id}`);
	return response[key];
}

export async function listAllEntities(kind: EntityKind): Promise<CatalogEntity[]> {
	const entities: CatalogEntity[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | null = null;
	do {
		const page = await listEntities(kind, { cursor, limit: MAX_PAGE_SIZE });
		entities.push(...page.items);
		cursor = page.next_cursor;
		if (cursor !== null) {
			if (seenCursors.has(cursor)) {
				throw new Error(`The ${kind} API returned a repeated pagination cursor.`);
			}
			seenCursors.add(cursor);
		}
	} while (cursor !== null);
	return entities;
}
