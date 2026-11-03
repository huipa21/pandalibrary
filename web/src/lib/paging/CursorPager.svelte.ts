import type { Page } from '#lib/catalog/types.js';

export type PageFetcher<T> = (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>;
export type PagerStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Loads a cursor-paginated list, passing each server cursor back verbatim.
 * Responses from superseded requests are discarded, and a request that is
 * already pending is never issued twice.
 */
export class CursorPager<T> {
	items = $state<T[]>([]);
	nextCursor = $state<string | null>(null);
	status = $state<PagerStatus>('idle');
	error = $state<unknown>(null);
	loadingMore = $state(false);
	moreError = $state<unknown>(null);

	#fetcher: PageFetcher<T> | null = null;
	#version = 0;
	#controller: AbortController | null = null;
	#pendingFirst: Promise<void> | null = null;
	#pendingMore: Promise<void> | null = null;

	get hasMore(): boolean {
		return this.status === 'ready' && this.nextCursor !== null;
	}

	get ended(): boolean {
		return this.status === 'ready' && this.nextCursor === null;
	}

	get empty(): boolean {
		return this.status === 'ready' && this.items.length === 0;
	}

	/** Replaces the source and starts again from the first page, or clears the list when null. */
	reset(fetcher: PageFetcher<T> | null): Promise<void> {
		this.#fetcher = fetcher;
		this.#invalidate();
		this.items = [];
		this.nextCursor = null;
		this.error = null;
		this.moreError = null;
		this.loadingMore = false;
		this.status = 'idle';
		return fetcher ? this.#loadFirst() : Promise.resolve();
	}

	/** Restarts the current source from the first page, for example after a stale cursor. */
	reload(): Promise<void> {
		return this.reset(this.#fetcher);
	}

	/** Retries a failed first page without issuing a duplicate while one is pending. */
	retry(): Promise<void> {
		if (this.#pendingFirst) return this.#pendingFirst;
		return this.reload();
	}

	loadMore(): Promise<void> {
		if (this.#pendingMore) return this.#pendingMore;
		const fetcher = this.#fetcher;
		const cursor = this.nextCursor;
		if (!fetcher || cursor === null || this.status !== 'ready') return Promise.resolve();

		const version = this.#version;
		const signal = this.#signal();
		this.loadingMore = true;
		this.moreError = null;
		const pending = (async () => {
			try {
				const page = await fetcher(cursor, signal);
				if (version !== this.#version) return;
				this.items = [...this.items, ...page.items];
				this.nextCursor = page.next_cursor;
			} catch (cause) {
				if (version !== this.#version) return;
				this.moreError = cause;
			} finally {
				if (version === this.#version) {
					this.loadingMore = false;
					this.#pendingMore = null;
				}
			}
		})();
		this.#pendingMore = pending;
		return pending;
	}

	/** Cancels in-flight requests and ignores any late responses. */
	dispose(): void {
		this.#fetcher = null;
		this.#invalidate();
	}

	#loadFirst(): Promise<void> {
		const fetcher = this.#fetcher;
		if (!fetcher) return Promise.resolve();

		const version = this.#version;
		const signal = this.#signal();
		this.status = 'loading';
		const pending = (async () => {
			try {
				const page = await fetcher(null, signal);
				if (version !== this.#version) return;
				this.items = page.items;
				this.nextCursor = page.next_cursor;
				this.status = 'ready';
			} catch (cause) {
				if (version !== this.#version) return;
				this.error = cause;
				this.status = 'error';
			} finally {
				if (version === this.#version) this.#pendingFirst = null;
			}
		})();
		this.#pendingFirst = pending;
		return pending;
	}

	#signal(): AbortSignal {
		this.#controller ??= new AbortController();
		return this.#controller.signal;
	}

	#invalidate(): void {
		this.#version += 1;
		this.#controller?.abort();
		this.#controller = null;
		this.#pendingFirst = null;
		this.#pendingMore = null;
	}
}
