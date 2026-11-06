import type { HeapPage } from './api.js';
import type { HeapItem } from './types.js';
import { isActive } from './selection.svelte.js';

export type HeapPageFetcher = (cursor: string | null, signal: AbortSignal) => Promise<HeapPage>;
export type HeapListStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Upper bound on pages re-read by a background refresh. */
export const MAX_REFRESH_PAGES = 10;

/**
 * Cursor-paged Bookheap list with "Load more". Unlike `CursorPager` it keeps `total` and supports a
 * silent refresh that re-reads the pages already shown without clearing the list, so selection
 * checkboxes and scroll position survive live updates. Superseded responses are discarded.
 */
export class HeapList {
	items = $state<HeapItem[]>([]);
	total = $state<number | null>(null);
	nextCursor = $state<string | null>(null);
	status = $state<HeapListStatus>('idle');
	error = $state<unknown>(null);
	loadingMore = $state(false);
	moreError = $state<unknown>(null);
	refreshing = $state(false);

	#fetcher: HeapPageFetcher | null = null;
	#version = 0;
	#pages = 0;
	#controller: AbortController | null = null;
	#pending: Promise<void> | null = null;

	get hasMore(): boolean {
		return this.status === 'ready' && this.nextCursor !== null;
	}

	get ended(): boolean {
		return this.status === 'ready' && this.nextCursor === null;
	}

	get empty(): boolean {
		return this.status === 'ready' && this.items.length === 0;
	}

	get hasActive(): boolean {
		return this.items.some(isActive);
	}

	/** Starts again from the first page with a new source, clearing the list. */
	reset(fetcher: HeapPageFetcher | null): Promise<void> {
		this.#fetcher = fetcher;
		this.#invalidate();
		this.items = [];
		this.total = null;
		this.nextCursor = null;
		this.error = null;
		this.moreError = null;
		this.loadingMore = false;
		this.refreshing = false;
		this.#pages = 0;
		this.status = fetcher ? 'loading' : 'idle';
		if (!fetcher) return Promise.resolve();
		const version = this.#version;
		const signal = this.#signal();
		const pending = (async () => {
			try {
				const page = await fetcher(null, signal);
				if (version !== this.#version) return;
				this.#apply([page], 1);
				this.status = 'ready';
			} catch (cause) {
				if (version !== this.#version) return;
				this.error = cause;
				this.status = 'error';
			} finally {
				if (version === this.#version) this.#pending = null;
			}
		})();
		this.#pending = pending;
		return pending;
	}

	retry(): Promise<void> {
		return this.#pending ?? this.reset(this.#fetcher);
	}

	loadMore(): Promise<void> {
		const fetcher = this.#fetcher;
		const cursor = this.nextCursor;
		if (!fetcher || cursor === null || this.status !== 'ready' || this.loadingMore || this.refreshing) {
			return this.#pending ?? Promise.resolve();
		}
		const version = this.#version;
		const signal = this.#signal();
		this.loadingMore = true;
		this.moreError = null;
		const pending = (async () => {
			try {
				const page = await fetcher(cursor, signal);
				if (version !== this.#version) return;
				const known = new Set(this.items.map((item) => item.id));
				this.items = [...this.items, ...page.items.filter((item) => !known.has(item.id))];
				this.nextCursor = page.next_cursor;
				this.total = page.total;
				this.#pages += 1;
			} catch (cause) {
				if (version !== this.#version) return;
				this.moreError = cause;
			} finally {
				if (version === this.#version) {
					this.loadingMore = false;
					this.#pending = null;
				}
			}
		})();
		this.#pending = pending;
		return pending;
	}

	/**
	 * Re-reads the pages already shown and replaces the list in one step. Resolves to true when the
	 * refresh reached the end of the list (so anything missing is really gone), false when it was
	 * superseded, failed, or stopped early. A failed refresh keeps the current list.
	 */
	async refresh(): Promise<boolean> {
		const fetcher = this.#fetcher;
		if (!fetcher) return false;
		if (this.status !== 'ready') {
			if (this.status === 'loading' && this.#pending) await this.#pending;
			else await this.reset(fetcher);
			return this.ended;
		}
		this.#invalidate();
		this.loadingMore = false;
		this.refreshing = true;
		const version = this.#version;
		const signal = this.#signal();
		const wanted = Math.max(1, Math.min(this.#pages, MAX_REFRESH_PAGES));
		const pages: HeapPage[] = [];
		try {
			let cursor: string | null = null;
			do {
				const page: HeapPage = await fetcher(cursor, signal);
				if (version !== this.#version) return false;
				pages.push(page);
				cursor = page.next_cursor;
			} while (cursor !== null && pages.length < wanted);
			this.#apply(pages, pages.length);
			this.moreError = null;
			return cursor === null;
		} catch {
			return false;
		} finally {
			if (version === this.#version) this.refreshing = false;
		}
	}

	dispose(): void {
		this.#fetcher = null;
		this.#invalidate();
	}

	#apply(pages: readonly HeapPage[], count: number): void {
		const seen = new Set<number>();
		const items: HeapItem[] = [];
		for (const page of pages) {
			for (const item of page.items) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				items.push(item);
			}
		}
		const last = pages[pages.length - 1];
		this.items = items;
		this.nextCursor = last?.next_cursor ?? null;
		this.total = last?.total ?? items.length;
		this.#pages = count;
	}

	#signal(): AbortSignal {
		this.#controller ??= new AbortController();
		return this.#controller.signal;
	}

	#invalidate(): void {
		this.#version += 1;
		this.#controller?.abort();
		this.#controller = null;
		this.#pending = null;
	}
}
