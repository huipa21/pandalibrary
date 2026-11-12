import type { ReaderSearchEngine, ReaderSearchResult } from './search.js';

export const SEARCH_PAGE_SIZE = 20;

export function createReaderSearchState(engine: ReaderSearchEngine) {
	let query = $state('');
	let results = $state<ReaderSearchResult[]>([]);
	let loading = $state(false);
	let searched = $state(false);
	let error = $state<'search' | 'navigation' | null>(null);
	let page = $state(0);
	let active = $state(-1);
	let navigating = $state(false);
	let request: AbortController | null = null;
	let revision = 0;
	let disposed = false;

	function reset() {
		revision++;
		request?.abort();
		request = null;
		loading = false;
		searched = false;
		results = [];
		error = null;
		page = 0;
		active = -1;
		navigating = false;
		engine.clearSearch();
	}

	async function search() {
		if (disposed) return;
		reset();
		const text = query.trim();
		if (!text) return;
		const current = revision;
		const controller = new AbortController();
		request = controller;
		loading = true;
		try {
			const found = await engine.search(text, controller.signal);
			if (disposed || current !== revision) return;
			results = found;
			searched = true;
		} catch {
			if (!disposed && current === revision) error = 'search';
		} finally {
			if (!disposed && current === revision) {
				loading = false;
				request = null;
			}
		}
	}

	async function select(index: number) {
		const result = results[index];
		if (disposed || loading || navigating || !result) return;
		const current = revision;
		navigating = true;
		error = null;
		try {
			await engine.goToSearchResult(result);
			if (disposed || current !== revision) return;
			active = index;
			page = Math.floor(index / SEARCH_PAGE_SIZE);
		} catch {
			if (!disposed && current === revision) error = 'navigation';
		} finally {
			if (!disposed && current === revision) navigating = false;
		}
	}

	return {
		get query() { return query; },
		get results() { return results; },
		get visibleResults() { return results.slice(page * SEARCH_PAGE_SIZE, (page + 1) * SEARCH_PAGE_SIZE); },
		get loading() { return loading; },
		get searched() { return searched; },
		get error() { return error; },
		get page() { return page; },
		get pageCount() { return Math.ceil(results.length / SEARCH_PAGE_SIZE); },
		get active() { return active; },
		get navigating() { return navigating; },
		setQuery(value: string) {
			if (disposed || value === query) return;
			reset();
			query = value;
		},
		clear() {
			if (disposed) return;
			reset();
			query = '';
		},
		search,
		select,
		next: () => select(active + 1),
		previous: () => select(active - 1),
		setPage(value: number) {
			if (!disposed && !navigating && Number.isInteger(value) && value >= 0 && value < Math.ceil(results.length / SEARCH_PAGE_SIZE)) page = value;
		},
		dispose() {
			if (disposed) return;
			reset();
			disposed = true;
		}
	};
}
