import { DEFAULT_PAGE_SIZE } from './api.js';
import type { BookFilters, BookSort } from './types.js';

const FILTER_KEYS = ['author_id', 'series_id', 'tag_id'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

export interface SearchParamsReader {
	get(name: string): string | null;
}

function positiveID(value: string | null): number | undefined {
	if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
	const id = Number(value);
	return Number.isSafeInteger(id) ? id : undefined;
}

export function selectedSort(params: SearchParamsReader, seriesID?: number): BookSort {
	const value = params.get('sort');
	if (value === 'added') return value;
	if (value === 'series' && seriesID !== undefined) return value;
	return 'title';
}

export function bookFiltersFromSearch(
	scope: BookFilters,
	params: SearchParamsReader
): BookFilters {
	const filters: { library_id?: number; author_id?: number; series_id?: number; tag_id?: number } = {
		...scope
	};
	if (scope.library_id !== undefined) {
		for (const key of FILTER_KEYS) {
			const id = positiveID(params.get(key));
			if (id !== undefined) filters[key] = id;
		}
	}
	return filters;
}

export function setCatalogFilter(
	current: URLSearchParams,
	key: FilterKey | 'sort',
	value: string
): URLSearchParams {
	const updated = new URLSearchParams(current);
	if (value) updated.set(key, value);
	else updated.delete(key);

	if (key === 'series_id' && !value && updated.get('sort') === 'series') {
		updated.delete('sort');
	}
	if (key === 'sort' && value === 'title') updated.delete('sort');

	updated.delete('cursor');
	return updated;
}

export function hasNextPage(nextCursor: string | null): boolean {
	return nextCursor !== null;
}

export function bookPageOptions(cursor?: string | null) {
	return { cursor, limit: DEFAULT_PAGE_SIZE };
}
