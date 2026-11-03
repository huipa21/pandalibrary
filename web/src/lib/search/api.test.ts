import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import {
	buildSearchPath,
	normalizeSearchInput,
	queryTooLong,
	relevanceScore,
	searchBooks,
	searchErrorKey,
	searchPageHref
} from './api.js';

afterEach(() => vi.restoreAllMocks());

describe('search API helpers', () => {
	it('builds the S1 request with the query, bounded limit, and verbatim cursor', () => {
		const cursor = 'eyJxIjoiZHVuZSJ9/+=';
		const params = new URLSearchParams(buildSearchPath('dune & co', { cursor, limit: 500 }).split('?')[1]);

		expect(buildSearchPath('x').startsWith('/search?')).toBe(true);
		expect(params.get('q')).toBe('dune & co');
		expect(params.get('limit')).toBe('100');
		expect(params.get('cursor')).toBe(cursor);
		expect(new URLSearchParams(buildSearchPath('x').split('?')[1]).has('cursor')).toBe(false);
	});

	it('keeps only the query in the page URL so pagination restarts when it changes', () => {
		expect(searchPageHref('  black hole  ')).toBe('/search?q=black+hole');
		expect(searchPageHref('   ')).toBe('/search');
		expect(searchPageHref('a&b')).not.toContain('cursor');
		expect(normalizeSearchInput(null)).toBe('');
	});

	it('rejects queries above the server byte limit before sending them', () => {
		expect(queryTooLong('a'.repeat(4096))).toBe(false);
		expect(queryTooLong('界'.repeat(1366))).toBe(true);
	});

	it('passes abort signals through the shared API client', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ items: [], next_cursor: null });
		const controller = new AbortController();
		await searchBooks('dune', { cursor: 'c', signal: controller.signal });

		expect(request).toHaveBeenCalledWith('/search?q=dune&limit=50&cursor=c', { signal: controller.signal });
	});

	it('shows BM25 ranks as positive relevance and omits unranked matches', () => {
		expect(relevanceScore(-2.5)).toBe(2.5);
		expect(relevanceScore(0)).toBeNull();
	});

	it('treats validation errors as a prompt to restart rather than an empty result', () => {
		const problem = (status: number) => new ApiError(status, '', '{}', { status });
		expect(searchErrorKey(problem(400))).toBe('search.error.invalid');
		expect(searchErrorKey(problem(401))).toBe('search.error.session');
		expect(searchErrorKey(problem(500))).toBe('search.error.api');
		expect(searchErrorKey(new TypeError('offline'))).toBe('search.error.connection');
		for (const status of [400, 401, 500]) {
			expect(en).toHaveProperty([searchErrorKey(problem(status))]);
		}
	});

	it('defines the same search and shelf translations in English and Chinese', () => {
		const pick = (messages: Record<string, string>) =>
			Object.keys(messages).filter((key) => key.startsWith('search.') || key.startsWith('shelves.')).sort();
		const englishKeys = pick(en);

		expect(englishKeys.length).toBeGreaterThan(50);
		expect(pick(zh)).toEqual(englishKeys);
		for (const key of englishKeys) {
			const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
			expect(placeholders((zh as Record<string, string>)[key]), key).toEqual(placeholders((en as Record<string, string>)[key]));
			expect((zh as Record<string, string>)[key], key).not.toBe('');
		}
	});
});
