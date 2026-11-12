import { describe, expect, it, vi } from 'vitest';
import type { ReaderSearchEngine, ReaderSearchResult } from './search.js';
import { createReaderSearchState } from './search-state.svelte.js';

function results(count: number): ReaderSearchResult[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `match-${index}`, excerpt: { before: 'Before ', match: 'word', after: ' after' }, page: index + 1
	}));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function engine(found = results(43)) {
	return {
		search: vi.fn<ReaderSearchEngine['search']>().mockResolvedValue(found),
		goToSearchResult: vi.fn<ReaderSearchEngine['goToSearchResult']>().mockResolvedValue(),
		clearSearch: vi.fn()
	};
}

describe('reader search sidebar state', () => {
	it('paginates by 20 and follows previous/next matches across page boundaries', async () => {
		const reader = engine();
		const state = createReaderSearchState(reader);
		state.setQuery(' word ');
		await state.search();
		expect(reader.search).toHaveBeenCalledWith('word', expect.any(AbortSignal));
		expect([state.pageCount, state.visibleResults.length]).toEqual([3, 20]);
		await state.select(19);
		await state.next();
		expect([state.active, state.page, state.visibleResults[0].id]).toEqual([20, 1, 'match-20']);
		expect(reader.goToSearchResult).toHaveBeenLastCalledWith(state.results[20]);
		await state.previous();
		expect([state.active, state.page]).toEqual([19, 0]);
		state.setPage(2);
		expect(state.visibleResults.map((result) => result.id)).toEqual(['match-40', 'match-41', 'match-42']);
		state.setPage(3);
		state.setPage(-1);
		expect(state.page).toBe(2);
		await state.select(42);
		await state.next();
		expect(state.active).toBe(42);
	});

	it('aborts on editing and ignores an older completion even when the engine ignores abort', async () => {
		const old = deferred<ReaderSearchResult[]>();
		const fresh = deferred<ReaderSearchResult[]>();
		const reader = engine();
		reader.search.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
		const state = createReaderSearchState(reader);
		state.setQuery('old');
		const first = state.search();
		const signal = reader.search.mock.calls[0][1]!;
		state.setQuery('new');
		expect(signal.aborted).toBe(true);
		const second = state.search();
		old.resolve(results(30));
		await first;
		expect([state.loading, state.results.length]).toEqual([true, 0]);
		fresh.resolve(results(1));
		await second;
		expect([state.loading, state.results.length, state.error]).toEqual([false, 1, null]);
	});

	it('clears and cancels pending work on disposal without exposing stale errors', async () => {
		const pending = deferred<ReaderSearchResult[]>();
		const reader = engine();
		reader.search.mockReturnValue(pending.promise);
		const state = createReaderSearchState(reader);
		state.setQuery('word');
		const task = state.search();
		const signal = reader.search.mock.calls[0][1]!;
		const clears = reader.clearSearch.mock.calls.length;
		state.dispose();
		state.dispose();
		pending.reject(new Error('late failure'));
		await task;
		expect(signal.aborted).toBe(true);
		expect(reader.clearSearch).toHaveBeenCalledTimes(clears + 1);
		expect([state.results.length, state.loading, state.error]).toEqual([0, false, null]);
	});

	it('handles errors, retry, no results and clear without searching blank text', async () => {
		const reader = engine();
		reader.search.mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce([]);
		const state = createReaderSearchState(reader);
		state.setQuery('word');
		await state.search();
		expect([state.error, state.loading]).toEqual(['search', false]);
		await state.search();
		expect([state.error, state.searched, state.results.length]).toEqual([null, true, 0]);
		state.clear();
		expect([state.query, state.searched, state.active]).toEqual(['', false, -1]);
		state.setQuery('   ');
		await state.search();
		expect(reader.search).toHaveBeenCalledTimes(2);
	});

	it('reports navigation errors without changing the selected match and serializes navigation', async () => {
		const reader = engine();
		const state = createReaderSearchState(reader);
		state.setQuery('word');
		await state.search();
		reader.goToSearchResult.mockRejectedValueOnce(new Error('unavailable'));
		await state.next();
		expect([state.active, state.error, state.navigating]).toEqual([-1, 'navigation', false]);
		const pending = deferred<void>();
		reader.goToSearchResult.mockReturnValueOnce(pending.promise);
		const task = state.next();
		await state.select(20);
		expect(reader.goToSearchResult).toHaveBeenCalledTimes(2);
		state.clear();
		pending.resolve();
		await task;
		expect([state.active, state.results.length, state.error]).toEqual([-1, 0, null]);
	});
});
