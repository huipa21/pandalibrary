import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
import type { PageFetcher } from '#lib/paging/CursorPager.svelte.js';
import { listImports } from './api.js';
import { isActiveImport, mergeImportPage } from './jobs.js';
import type { ImportJob } from './types.js';

/**
 * I1 import history with cursor paging plus a silent first-page refresh. A refresh merges
 * into the displayed list instead of resetting it, never overlaps another refresh, and is
 * discarded if the list was reset while it was in flight.
 */
export class ImportHistory extends CursorPager<ImportJob> {
	refreshError = $state<unknown>(null);
	refreshing = $state(false);

	#epoch = 0;
	#inflight: Promise<boolean> | null = null;
	#controller = new AbortController();
	#fetchFirst: (signal: AbortSignal) => Promise<{ items: ImportJob[] }>;

	constructor(fetchFirst: (signal: AbortSignal) => Promise<{ items: ImportJob[] }> = (signal) => listImports({ signal })) {
		super();
		this.#fetchFirst = fetchFirst;
	}

	get hasActive(): boolean {
		return this.items.some(isActiveImport);
	}

	/** Shows a job returned by an upload without waiting for the next refresh. */
	include(job: ImportJob): void {
		if (this.status === 'ready') this.items = mergeImportPage(this.items, [job]);
	}

	override reset(fetcher: PageFetcher<ImportJob> | null): Promise<void> {
		this.#epoch += 1;
		this.refreshError = null;
		return super.reset(fetcher);
	}

	/** Refreshes the newest page; resolves to whether any displayed job is still active. */
	refresh(): Promise<boolean> {
		if (this.#inflight) return this.#inflight;
		const epoch = this.#epoch;
		this.refreshing = true;
		const pending = (async () => {
			try {
				const page = await this.#fetchFirst(this.#controller.signal);
				if (epoch !== this.#epoch || this.status !== 'ready') return this.hasActive;
				this.items = mergeImportPage(this.items, page.items);
				this.refreshError = null;
			} catch (cause) {
				if (epoch === this.#epoch) this.refreshError = cause;
				throw cause;
			} finally {
				this.refreshing = false;
				this.#inflight = null;
			}
			return this.hasActive;
		})();
		this.#inflight = pending;
		return pending;
	}

	override dispose(): void {
		this.#controller.abort();
		this.#epoch += 1;
		super.dispose();
	}
}
