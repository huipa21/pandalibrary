import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { EventBus, PDFFindController, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { ReaderSearchEngine, ReaderSearchResult } from '../search.js';

type FindConstructor = typeof PDFFindController;
type Job = {
	query: string;
	generation: number;
	resolve: (results: ReaderSearchResult[]) => void;
	reject: (error: unknown) => void;
	cancelled: boolean;
	cleanup: () => void;
};

function aborted(): DOMException {
	return new DOMException('PDF search was cancelled.', 'AbortError');
}

/**
 * pdf.js owns matching, normalization and text-layer highlighting. Excerpts use
 * its original-text offsets, not a second matcher (which would disagree on
 * ligatures, diacritics and hyphenated line endings).
 */
export class PdfSearch implements ReaderSearchEngine {
	readonly controller: PDFFindController;
	private document: PDFDocumentProxy | null = null;
	private readonly text = new Map<number, string>();
	private readonly failures = new Map<number, unknown>();
	private readonly results = new Map<string, { pageIndex: number; matchIndex: number; ordinal: number }>();
	private running: Job | null = null;
	private queued: Job | null = null;
	private generation = 0;
	private disposed = false;
	private navigation = new AbortController();
	private navigating = false;
	private query = '';

	constructor(Base: FindConstructor, private readonly eventBus: EventBus, private readonly linkService: PDFLinkService) {
		const owner = this;
		this.controller = new (class extends Base {
			override setDocument(document: PDFDocumentProxy): void {
				if (document && document === owner.document) return;
				super.setDocument(owner.setDocument(document));
			}

			override match(query: string | string[], content: string, pageIndex: number) {
				try {
					return super.match(query, content, pageIndex);
				} catch (error) {
					owner.failures.set(pageIndex + 1, error);
					return [];
				}
			}
		})({ eventBus, linkService, delay: 0, updateMatchesCountOnProgress: false });
		eventBus.on('updatefindmatchescount', this.complete);
	}

	private setDocument(document: PDFDocumentProxy | null): PDFDocumentProxy {
		this.cancel();
		this.running = null;
		this.document = document;
		this.text.clear();
		this.failures.clear();
		if (!document) return null as unknown as PDFDocumentProxy;
		// PDFViewer calls setDocument itself. Only the find controller receives
		// this facade; the renderer and custom page/marks layers remain untouched.
		return new Proxy(document, {
			get: (target, key) => {
				if (key !== 'getPage') {
					const value = Reflect.get(target, key, target);
					return typeof value === 'function' ? value.bind(target) : value;
				}
				return async (page: number): Promise<PDFPageProxy> => {
					try {
						const proxy = await target.getPage(page);
						return new Proxy(proxy, {
							get: (target, key) => {
								if (key !== 'getTextContent') {
									const value = Reflect.get(target, key, target);
									return typeof value === 'function' ? value.bind(target) : value;
								}
								return async (options: Parameters<PDFPageProxy['getTextContent']>[0]) => {
									try {
										const content = await target.getTextContent(options);
										if (this.document === document) {
											this.text.set(page - 1, content.items.map((item) => 'str' in item ? item.str : '').join(''));
										}
										return content;
									} catch (error) {
										if (this.document === document) this.failures.set(page, error);
										throw error;
									}
								};
							}
						});
					} catch (error) {
						if (this.document === document) this.failures.set(page, error);
						throw error;
					}
				};
			}
		});
	}

	search(query: string, signal?: AbortSignal): Promise<ReaderSearchResult[]> {
		if (this.disposed || !this.document) return Promise.reject(new Error('The PDF reader is not open.'));
		this.clearSearch();
		if (signal?.aborted) return Promise.reject(aborted());
		if (!query.trim()) return Promise.resolve([]);
		return new Promise((resolve, reject) => {
			const job: Job = { query, generation: this.generation, resolve, reject, cancelled: false, cleanup: () => {} };
			const onAbort = () => {
				this.reject(job);
				if (job.generation === this.generation) this.clearSearch();
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			job.cleanup = () => signal?.removeEventListener('abort', onAbort);
			this.queued = job;
			this.start();
		});
	}

	private start(): void {
		if (this.running || !this.queued || this.disposed) return;
		const job = this.running = this.queued;
		this.queued = null;
		this.query = job.query;
		try {
			this.eventBus.dispatch('find', {
				source: this,
				type: 'casesensitivitychange',
				query: job.query,
				caseSensitive: false,
				entireWord: false,
				matchDiacritics: false,
				highlightAll: true,
				findPrevious: false
			});
		} catch (error) {
			this.running = null;
			job.cleanup();
			job.reject(error);
		}
	}

	private readonly complete = ({ source }: { source: unknown }): void => {
		const job = this.running;
		if (source !== this.controller || !job) return;
		this.running = null;
		job.cleanup();
		if (!job.cancelled) {
			try {
				if (this.failures.size) {
					throw new Error(`Could not search PDF page ${this.failures.keys().next().value}.`, { cause: this.failures.values().next().value });
				}
				const results: ReaderSearchResult[] = [];
				for (let pageIndex = 0; pageIndex < (this.document?.numPages ?? 0); pageIndex++) {
					const text = this.text.get(pageIndex) ?? '';
					const matches: number[] = this.controller.pageMatches?.[pageIndex] ?? [];
					const lengths: number[] = this.controller.pageMatchesLength?.[pageIndex] ?? [];
					for (let matchIndex = 0; matchIndex < matches.length; matchIndex++) {
						const start = matches[matchIndex];
						const end = start + lengths[matchIndex];
						const id = `pdf-search:${job.generation}:${pageIndex}:${matchIndex}`;
						this.results.set(id, { pageIndex, matchIndex, ordinal: results.length });
						results.push({
							id,
							page: pageIndex + 1,
							excerpt: { before: text.slice(Math.max(0, start - 60), start), match: text.slice(start, end), after: text.slice(end, end + 60) }
						});
					}
				}
				job.resolve(results);
			} catch (error) {
				this.results.clear();
				this.eventBus.dispatch('findbarclose', { source: this });
				job.reject(error);
			}
		}
		// Count events fire inside pdf.js's match calculation. Do not start a
		// replacement query reentrantly before that calculation has returned.
		queueMicrotask(() => this.start());
	};

	async goToSearchResult(result: ReaderSearchResult): Promise<void> {
		const target = this.results.get(result.id);
		if (this.disposed || !target) throw new Error('The PDF search result is no longer available.');
		if (this.navigating) throw new Error('PDF search navigation is already in progress.');
		this.navigating = true;
		const { signal } = this.navigation;
		try {
			const total = this.results.size;
			for (let step = 0; step <= total; step++) {
				if (signal.aborted) throw aborted();
				const selected = this.controller.selected;
				if (step > 0 && selected?.pageIdx === target.pageIndex && selected.matchIdx === target.matchIndex) {
					this.linkService.page = target.pageIndex + 1;
					this.eventBus.dispatch('updatetextlayermatches', { source: this.controller, pageIndex: target.pageIndex });
					return;
				}
				// "again" is the installed controller's public match-navigation API.
				// Keep its selected page current so it does not restart the query.
				if (selected && selected.pageIdx >= 0) this.linkService.page = selected.pageIdx + 1;
				let ordinal = selected?.matchIdx ?? -1;
				for (let page = 0; page < (selected?.pageIdx ?? 0); page++) {
					ordinal += this.controller.pageMatches?.[page]?.length ?? 0;
				}
				const forward = (target.ordinal - ordinal + total) % total;
				const findPrevious = forward === 0 ? total > 1 : forward > total / 2;
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => {
						this.eventBus.off('updatefindcontrolstate', changed);
						signal.removeEventListener('abort', abort);
					};
					const abort = () => { cleanup(); reject(aborted()); };
					const changed = ({ source, state }: { source: unknown; state: number }) => {
						if (source !== this.controller || state === 3) return;
						cleanup();
						resolve();
					};
					this.eventBus.on('updatefindcontrolstate', changed);
					signal.addEventListener('abort', abort, { once: true });
					try {
						this.eventBus.dispatch('find', {
							source: this, type: 'again', query: this.query, findPrevious,
							caseSensitive: false, entireWord: false, matchDiacritics: false, highlightAll: true
						});
					} catch (error) { cleanup(); reject(error); }
				});
			}
			throw new Error('The PDF search match is unavailable.');
		} finally {
			this.navigating = false;
		}
	}

	private reject(job: Job): void {
		if (job.cancelled) return;
		job.cancelled = true;
		job.cleanup();
		job.reject(aborted());
	}

	private cancel(): void {
		this.generation++;
		this.navigation.abort();
		this.navigation = new AbortController();
		this.results.clear();
		if (this.running) this.reject(this.running);
		if (this.queued) this.reject(this.queued);
		this.queued = null;
	}

	clearSearch(): void {
		this.cancel();
		if (!this.disposed) this.eventBus.dispatch('findbarclose', { source: this });
	}

	destroy(): void {
		if (this.disposed) return;
		this.clearSearch();
		this.disposed = true;
		this.eventBus.off('updatefindmatchescount', this.complete);
		this.controller.setDocument(null as unknown as PDFDocumentProxy);
		this.running = null;
	}
}
