import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '#lib/api/client.js';
import type { Shelf } from '#lib/shelves/types.js';
import { buildBooksPath, buildPagePath, countBooks, DEFAULT_PAGE_SIZE, getBookShelves, MAX_PAGE_SIZE } from './api';
import { allowsCatalogFilters, bookFiltersFromSearch, hasNextPage, selectedSort, setCatalogFilter } from './query';

afterEach(() => vi.restoreAllMocks());

describe('countBooks', () => {
	it('requests the visible book count and returns the number', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ count: 12 });
		const controller = new AbortController();

		await expect(countBooks()).resolves.toBe(12);
		await expect(countBooks(controller.signal)).resolves.toBe(12);

		expect(request.mock.calls).toEqual([
			['/books/count', {}],
			['/books/count', { signal: controller.signal }]
		]);
	});
});

describe('getBookShelves', () => {
	const shelf: Shelf = {
		id: 7,
		kind: 'private',
		mode: 'manual',
		system_key: 'favorites',
		rules: null,
		owner_id: 1,
		name: 'Favorites',
		description: null,
		created_by: 1,
		visible_book_count: 2,
		created_at: '2026-11-03T00:00:00Z',
		updated_at: '2026-11-03T00:00:00Z'
	};

	it('requests the book shelves endpoint and unwraps the shelves envelope', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ shelves: [shelf] });
		const controller = new AbortController();

		await expect(getBookShelves(21)).resolves.toEqual([shelf]);
		await expect(getBookShelves(22, controller.signal)).resolves.toEqual([shelf]);

		expect(request.mock.calls).toEqual([
			['/books/21/shelves', {}],
			['/books/22/shelves', { signal: controller.signal }]
		]);
	});

	it('propagates request failures', async () => {
		vi.spyOn(api, 'request').mockRejectedValue(new Error('not found'));
		await expect(getBookShelves(404)).rejects.toThrow('not found');
	});
});

describe('catalog API helpers', () => {
	it('uses the bounded default page size and preserves opaque cursors', () => {
		const cursor = 'eyJzY29wZSI6ImE/bis+==';
		const path = buildPagePath('/libraries', { cursor });
		const params = new URLSearchParams(path.split('?')[1]);

		expect(params.get('limit')).toBe(String(DEFAULT_PAGE_SIZE));
		expect(params.get('cursor')).toBe(cursor);
		expect(buildPagePath('/tags', { limit: 500 })).toContain(`limit=${MAX_PAGE_SIZE}`);
	});

	it('creates book requests with the C1 filter names and server sort', () => {
		const path = buildBooksPath(
			{ library_id: 4, author_id: 8, series_id: 11, tag_id: 13 },
			'series',
			{ cursor: 'opaque cursor' }
		);
		const params = new URLSearchParams(path.split('?')[1]);

		expect(path.startsWith('/books?')).toBe(true);
		expect(Object.fromEntries(params)).toMatchObject({
			library_id: '4',
			author_id: '8',
			series_id: '11',
			tag_id: '13',
			sort: 'series',
			cursor: 'opaque cursor'
		});
	});

	it('resets cursor when filters or sort change and avoids invalid series sorting', () => {
		const current = new URLSearchParams('author_id=3&series_id=7&sort=series&cursor=opaque');
		const updated = setCatalogFilter(current, 'series_id', '');

		expect(updated.has('cursor')).toBe(false);
		expect(updated.has('series_id')).toBe(false);
		expect(updated.has('sort')).toBe(false);
		expect(selectedSort(updated)).toBe('title');
		expect(selectedSort(new URLSearchParams('sort=series'))).toBe('title');
	});

	it('keeps entity filters in URL state while applying the current library scope', () => {
		const filters = bookFiltersFromSearch(
			{ library_id: 5 },
			new URLSearchParams('author_id=8&tag_id=12&series_id=bad')
		);

		expect(filters).toEqual({ library_id: 5, author_id: 8, tag_id: 12 });
	});

	it('applies URL filters to the unrestricted All Books scope but not to entity scopes', () => {
		const params = new URLSearchParams('author_id=8&tag_id=12');

		expect(allowsCatalogFilters({})).toBe(true);
		expect(bookFiltersFromSearch({}, params)).toEqual({ author_id: 8, tag_id: 12 });
		expect(allowsCatalogFilters({ series_id: 3 })).toBe(false);
		expect(bookFiltersFromSearch({ series_id: 3 }, params)).toEqual({ series_id: 3 });
	});

	it('treats a null next cursor as the end of the list', () => {
		expect(hasNextPage('opaque')).toBe(true);
		expect(hasNextPage(null)).toBe(false);
	});

	it('defines the same catalog translations in English and Chinese', () => {
		const englishKeys = Object.keys(en).filter((key) => key.startsWith('catalog.'));
		const chineseKeys = Object.keys(zh).filter((key) => key.startsWith('catalog.'));

		expect(englishKeys.length).toBeGreaterThan(0);
		expect(chineseKeys.sort()).toEqual(englishKeys.sort());
	});
});
