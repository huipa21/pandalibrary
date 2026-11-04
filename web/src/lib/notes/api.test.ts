import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import {
	annotationErrorKey,
	annotationQueryIssue,
	buildAnnotationSearchPath,
	excerpt,
	isShortQuery,
	normalizeAnnotationQuery,
	notesPageHref,
	positionPercent,
	resultBooks,
	searchAnnotations
} from './api.js';
import { AnnotationSearch } from './AnnotationSearch.svelte.js';
import type { AnnotationResult } from './types.js';

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const result = (id: string, bookId: number, kind = 'highlight', position = 0.5): AnnotationResult => ({
	id,
	book_id: bookId,
	kind,
	content: `content ${id}`,
	position,
	created_at: '2026-11-03T08:00:00Z'
});

describe('annotation search helpers', () => {
	it('follows R1 query rules: trimmed, 1–200 code points, short queries use substring matching', () => {
		expect(normalizeAnnotationQuery('  dune  ')).toBe('dune');
		expect(annotationQueryIssue('')).toBe('empty');
		expect(annotationQueryIssue('a'.repeat(200))).toBeNull();
		expect(annotationQueryIssue('a'.repeat(201))).toBe('too_long');
		expect(annotationQueryIssue('😀'.repeat(200))).toBeNull();
		expect(isShortQuery('ab')).toBe(true);
		expect(isShortQuery('书')).toBe(true);
		expect(isShortQuery('abc')).toBe(false);
		expect(isShortQuery('')).toBe(false);
	});

	it('builds the R1 path and the in-app URL', async () => {
		expect(buildAnnotationSearchPath('a&b "c"')).toBe('/search/annotations?q=a%26b+%22c%22');
		expect(notesPageHref('  spice ')).toBe('/notes?q=spice');
		expect(notesPageHref(' ')).toBe('/notes');

		const request = vi.spyOn(api, 'request').mockResolvedValue({ items: [result('h1', 1)] });
		await expect(searchAnnotations('spice')).resolves.toHaveLength(1);
		expect(request).toHaveBeenCalledWith('/search/annotations?q=spice', { signal: undefined, cache: 'no-store' });
	});

	it('produces plain-text excerpts and leaves markup as text', () => {
		expect(excerpt('  <img src=x onerror=alert(1)>\n\n**bold**  ')).toBe('<img src=x onerror=alert(1)> **bold**');
		expect(excerpt('abcdef', 3)).toBe('abc…');
		expect(excerpt('😀😀😀😀', 2)).toBe('😀😀…');
	});

	it('shows positions only for highlights with a valid fraction', () => {
		expect(positionPercent({ kind: 'highlight', position: 0.4567 })).toBe(45.7);
		expect(positionPercent({ kind: 'note', position: 0 })).toBeNull();
		expect(positionPercent({ kind: 'highlight', position: 3 })).toBeNull();
	});

	it('lists distinct books in result order with their match counts', () => {
		expect(resultBooks([result('a', 7), result('b', 3), result('c', 7, 'note')])).toEqual([
			{ book_id: 7, matches: 2 },
			{ book_id: 3, matches: 1 }
		]);
	});

	it('maps search failures to recoverable messages', () => {
		const problem = (status: number) => new ApiError(status, '', '{}', { status });
		expect(annotationErrorKey(problem(400))).toBe('notes.error.invalid');
		expect(annotationErrorKey(problem(401))).toBe('notes.error.session');
		expect(annotationErrorKey(problem(503))).toBe('notes.error.api');
		expect(annotationErrorKey(new TypeError('offline'))).toBe('notes.error.connection');
	});
});

describe('AnnotationSearch', () => {
	it('does not request empty or over-long queries', async () => {
		const fetcher = vi.fn();
		const search = new AnnotationSearch(fetcher);
		await search.search('   ');
		await search.search('x'.repeat(201));

		expect(fetcher).not.toHaveBeenCalled();
		expect(search.status).toBe('idle');
	});

	it('moves through loading to ready, keeping server order and reporting the cap', async () => {
		const items = Array.from({ length: 100 }, (_, index) => result(`h${index}`, index + 1));
		const fetcher = vi.fn().mockResolvedValue(items);
		const search = new AnnotationSearch(fetcher);

		const pending = search.search(' spice ');
		expect(search.status).toBe('loading');
		expect(search.query).toBe('spice');
		await pending;

		expect(fetcher).toHaveBeenCalledWith('spice', expect.any(AbortSignal));
		expect(search.status).toBe('ready');
		expect(search.results.map((item) => item.id)).toEqual(items.map((item) => item.id));
		expect(search.capped).toBe(true);
		expect(search.books).toHaveLength(100);
	});

	it('shares an in-flight request for the same query instead of duplicating it', async () => {
		const response = deferred<AnnotationResult[]>();
		const fetcher = vi.fn().mockReturnValue(response.promise);
		const search = new AnnotationSearch(fetcher);

		const first = search.search('spice');
		const second = search.search('  spice');
		expect(second).toBe(first);
		response.resolve([]);
		await first;

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(search.empty).toBe(true);
	});

	it('aborts and ignores a superseded query', async () => {
		const slow = deferred<AnnotationResult[]>();
		const signals: AbortSignal[] = [];
		const fetcher = vi.fn((query: string, signal: AbortSignal) => {
			signals.push(signal);
			return query === 'old' ? slow.promise : Promise.resolve([result('new', 2)]);
		});
		const search = new AnnotationSearch(fetcher);

		const old = search.search('old');
		await search.search('new');
		slow.resolve([result('old', 1)]);
		await old;

		expect(signals[0].aborted).toBe(true);
		expect(search.query).toBe('new');
		expect(search.results.map((item) => item.id)).toEqual(['new']);
	});

	it('keeps the error for display and retries the same query', async () => {
		const fetcher = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(503, '', '{}', { status: 503 }))
			.mockResolvedValueOnce([result('h1', 1)]);
		const search = new AnnotationSearch(fetcher);

		await search.search('spice');
		expect(search.status).toBe('error');
		expect(search.error).toBeInstanceOf(ApiError);
		expect(search.books).toEqual([]);
		await search.retry();

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(search.status).toBe('ready');
		expect(search.error).toBeNull();
	});
});
