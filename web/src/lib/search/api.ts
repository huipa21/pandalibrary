import { api } from '#lib/api/client.js';
import { requestErrorKind } from '#lib/paging/errors.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type PageOptions } from '#lib/catalog/api.js';
import type { Page } from '#lib/catalog/types.js';
import type { SearchResult } from './types.js';

export const SEARCH_QUERY_PARAM = 'q';
export const MAX_QUERY_BYTES = 4096;

/** Trims surrounding whitespace; the server owns all further normalization. */
export function normalizeSearchInput(value: string | null | undefined): string {
	return (value ?? '').trim();
}

export function queryTooLong(query: string): boolean {
	return new TextEncoder().encode(query).length > MAX_QUERY_BYTES;
}

export function buildSearchPath(query: string, options: PageOptions = {}): string {
	const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
	const params = new URLSearchParams({ q: query, limit: String(limit) });
	if (options.cursor !== undefined && options.cursor !== null) params.set('cursor', options.cursor);
	return `/search?${params.toString()}`;
}

/** Builds the in-app URL for a query; pagination cursors are never stored in the URL. */
export function searchPageHref(query: string): string {
	const normalized = normalizeSearchInput(query);
	return normalized ? `/search?${new URLSearchParams({ [SEARCH_QUERY_PARAM]: normalized })}` : '/search';
}

export async function searchBooks(
	query: string,
	options: PageOptions & { signal?: AbortSignal } = {}
): Promise<Page<SearchResult>> {
	return api.request(buildSearchPath(query, options), { signal: options.signal });
}

/** Formats the BM25 rank as a positive relevance score, or null for unranked matches. */
export function relevanceScore(rank: number): number | null {
	return Number.isFinite(rank) && rank < 0 ? -rank : null;
}

/** Validation failures mean the query or cursor was rejected, so the search must restart. */
export function searchErrorKey(error: unknown): string {
	switch (requestErrorKind(error)) {
		case 'invalid':
			return 'search.error.invalid';
		case 'connection':
			return 'search.error.connection';
		case 'unauthorized':
			return 'search.error.session';
		default:
			return 'search.error.api';
	}
}
