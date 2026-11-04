import { annotationQueryIssue, MAX_ANNOTATION_RESULTS, normalizeAnnotationQuery, resultBooks, searchAnnotations } from './api.js';
import type { AnnotationResult, ResultBook } from './types.js';

export type AnnotationFetcher = (query: string, signal: AbortSignal) => Promise<AnnotationResult[]>;
export type AnnotationSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Runs one annotation search at a time. A request for the query already in flight is
 * shared rather than repeated, and responses for superseded queries are discarded.
 */
export class AnnotationSearch {
	query = $state('');
	results = $state<AnnotationResult[]>([]);
	status = $state<AnnotationSearchStatus>('idle');
	error = $state<unknown>(null);

	#fetcher: AnnotationFetcher;
	#version = 0;
	#controller: AbortController | null = null;
	#pending: { query: string; promise: Promise<void> } | null = null;

	constructor(fetcher: AnnotationFetcher = searchAnnotations) {
		this.#fetcher = fetcher;
	}

	get books(): ResultBook[] {
		return resultBooks(this.results);
	}

	get empty(): boolean {
		return this.status === 'ready' && this.results.length === 0;
	}

	/** True when the server's result cap was reached, so older matches may be omitted. */
	get capped(): boolean {
		return this.status === 'ready' && this.results.length >= MAX_ANNOTATION_RESULTS;
	}

	/** Searches for a query; empty or over-long queries clear the results without a request. */
	search(raw: string): Promise<void> {
		const query = normalizeAnnotationQuery(raw);
		if (annotationQueryIssue(query)) {
			this.clear();
			return Promise.resolve();
		}
		if (this.#pending?.query === query) return this.#pending.promise;

		this.#invalidate();
		const version = this.#version;
		const controller = new AbortController();
		this.#controller = controller;
		this.query = query;
		this.results = [];
		this.error = null;
		this.status = 'loading';
		const promise = (async () => {
			try {
				const results = await this.#fetcher(query, controller.signal);
				if (version !== this.#version) return;
				this.results = results;
				this.status = 'ready';
			} catch (cause) {
				if (version !== this.#version) return;
				this.error = cause;
				this.status = 'error';
			} finally {
				if (version === this.#version) {
					this.#pending = null;
					this.#controller = null;
				}
			}
		})();
		this.#pending = { query, promise };
		return promise;
	}

	retry(): Promise<void> {
		return this.search(this.query);
	}

	clear(): void {
		this.#invalidate();
		this.query = '';
		this.results = [];
		this.error = null;
		this.status = 'idle';
	}

	dispose(): void {
		this.#invalidate();
	}

	#invalidate(): void {
		this.#version += 1;
		this.#controller?.abort();
		this.#controller = null;
		this.#pending = null;
	}
}
