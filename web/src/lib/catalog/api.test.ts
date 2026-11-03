import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { describe, expect, it } from 'vitest';
import { buildBooksPath, buildPagePath, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './api';
import { bookFiltersFromSearch, hasNextPage, selectedSort, setCatalogFilter } from './query';

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
