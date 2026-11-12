import type { FoliateAnnotation, FoliateBook, FoliateResolved, View } from 'foliate-js/view.js';
import * as m from '#lib/paraglide/messages.js';
import { resolveMarkColor } from './annotations.js';
import { backgroundFor } from './appearance.js';
import { fraction } from './progress.js';
import { captureBookBlobs, isolateBookSections } from './safe-content.js';
import type { ReaderSearchEngine, ReaderSearchResult } from './search.js';
import {
	isCfiLocator,
	type Reader,
	type ReaderAnnotation,
	type ReaderEvents,
	type ReaderSettings,
	type ReflowableFormat,
	type Relocation
} from './types.js';

const MIME_TYPES: Record<ReflowableFormat, string> = {
	epub: 'application/epub+zip',
	mobi: 'application/x-mobipocket-ebook',
	azw3: 'application/vnd.amazon.ebook',
	fb2: 'application/x-fictionbook+xml',
	fbz: 'application/x-zip-compressed-fb2',
	cbz: 'application/vnd.comicbook+zip'
};

interface FoliateLocation {
	fraction?: number;
	cfi?: string;
}

interface FoliateLoad {
	doc: Document;
	index: number;
}

interface DrawAnnotation {
	annotation: FoliateAnnotation;
	doc?: Document;
	draw: (shape: typeof import('foliate-js/overlayer.js').Overlayer.highlight, options: { color: string; writingMode?: string }) => void;
}

interface SelectionBounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

function textSelectionRange(doc: Document, range: Range): Range {
	const isText = (node: Node) => node.nodeType === 3 || node.nodeType === 4;
	if (isText(range.startContainer) && isText(range.endContainer)) return range;
	// Upstream CFIs cannot round-trip child offsets on element boundaries.
	// Normalize only the serialized range, leaving native selection geometry intact.
	const walker = doc.createTreeWalker(range.commonAncestorContainer, 4 | 8);
	let first: Node | null = null;
	let last: Node | null = null;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.nodeValue?.length || !range.intersectsNode(node)) continue;
		const start = node === range.startContainer ? range.startOffset : 0;
		const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
		if (start === end) continue;
		first ??= node;
		last = node;
	}
	if (!first || !last) return range;
	const normalized = range.cloneRange();
	normalized.setStart(first, first === range.startContainer ? range.startOffset : 0);
	normalized.setEnd(last, last === range.endContainer ? range.endOffset : last.nodeValue!.length);
	return normalized;
}

export function foliateStyles(settings: ReaderSettings): string {
	const background = backgroundFor(settings);
	const fonts = { serif: 'serif', 'sans-serif': 'sans-serif', system: 'system-ui' };
	return `
		html { color-scheme: ${background.tone}; }
		html, body { background: ${background.page} !important; color: ${background.text} !important; }
		body { font-family: ${fonts[settings.font]} !important; font-size: ${settings.size}% !important; }
		p, li, blockquote, dd { line-height: ${settings.spacing} !important; }
	`;
}

export class FoliateReader implements Reader, ReaderSearchEngine {
	private view: View | null = null;
	private book: FoliateBook | null = null;
	private annotations = new Map<string, ReaderAnnotation>();
	private documents = new Map<number, Document>();
	private location: Relocation | null = null;
	private lastLoadError: unknown = null;
	private disposed = false;
	private rotation = 0;
	private rotationObserver: ResizeObserver | null = null;
	private rotationMeasurements = new Map<HTMLElement, PropertyDescriptor | undefined>();
	private readonly listeners = new AbortController();
	private searchGeneration = 0;
	private searchAbort: AbortController | null = null;
	private searchTask: Promise<void> = Promise.resolve();
	private searchResults = new Map<string, string>();
	private selectionDocument: Document | null = null;
	private selectionListeners = new Set<(reason?: 'geometry') => void>();
	private selectionKeyboardListeners = new Set<(event: KeyboardEvent) => void>();
	private annotationListeners = new Set<(id: string) => void>();
	private notifySelection = (reason?: 'geometry') => {
		for (const listener of this.selectionListeners) listener(reason);
	};
	private notifySelectionGeometry = () => this.notifySelection('geometry');
	private selectionKeyboard = (event: KeyboardEvent) => {
		for (const listener of this.selectionKeyboardListeners) listener(event);
	};

	constructor(
		private readonly container: HTMLElement,
		private readonly format: ReflowableFormat,
		private readonly events: ReaderEvents
	) {}

	get contents() {
		return this.book?.toc ?? [];
	}

	async goToContents(href: string): Promise<void> {
		const view = this.requireView();
		if (!this.isValidResolved(view.resolveNavigation(href))) throw new Error('Book contents destination is unavailable.');
		this.lastLoadError = null;
		const result = await view.goTo(href);
		if (this.lastLoadError) throw this.lastLoadError;
		if (!this.isValidResolved(result)) throw new Error('Book contents destination could not be opened.');
	}

	async open(blob: Blob): Promise<void> {
		const [{ makeBook, View }, { Overlayer }] = await Promise.all([
			import('foliate-js/view.js'),
			import('foliate-js/overlayer.js')
		]);
		const file = new File([blob], `book.${this.format}`, { type: MIME_TYPES[this.format] });
		const { value: book, blobs } = await captureBookBlobs(() => makeBook(file));
		if (!book.sections.length) throw new Error('The book contains no readable sections.');
		this.book = book;
		isolateBookSections(book, blobs, (error) => {
			this.lastLoadError = error;
			this.events.error(error);
		});
		this.isolateSearchDocuments(book);
		if (this.disposed) {
			book.destroy?.();
			return;
		}
		const view = new View();
		this.view = view;
		view.style.display = 'block';
		view.style.width = '100%';
		view.style.height = '100%';
		view.addEventListener('external-link', (event) => event.preventDefault());
		view.addEventListener('relocate', (event) => {
			const detail = (event as CustomEvent<FoliateLocation>).detail;
			if (!detail.cfi || !isCfiLocator({ type: 'cfi', value: detail.cfi })) return;
			this.location = { fraction: fraction(detail.fraction ?? 0), locator: { type: 'cfi', value: detail.cfi } };
			this.events.relocate(this.location);
		});
		view.addEventListener('load', (event) => {
			const { doc, index } = (event as CustomEvent<FoliateLoad>).detail;
			this.prepareRotationMeasurements(doc);
			this.documents.set(index, doc);
			const captureSelection = () => this.captureSelection(doc, index);
			doc.addEventListener('selectionchange', captureSelection, { signal: this.listeners.signal });
			doc.addEventListener('mouseup', captureSelection, { signal: this.listeners.signal });
			doc.addEventListener('keyup', captureSelection, { signal: this.listeners.signal });
			doc.addEventListener('keydown', this.selectionKeyboard, { signal: this.listeners.signal, capture: true });
			doc.addEventListener('keydown', this.events.keyboard, { signal: this.listeners.signal });
			doc.addEventListener('scroll', this.notifySelectionGeometry, { signal: this.listeners.signal, capture: true });
			doc.defaultView?.addEventListener('resize', this.notifySelectionGeometry, { signal: this.listeners.signal });
			// Renderer scrolling lives inside shadow roots and does not cross their boundaries.
			for (const root of [view.shadowRoot, view.renderer?.shadowRoot, this.container.ownerDocument]) {
				root?.addEventListener('scroll', this.notifySelectionGeometry, { signal: this.listeners.signal, capture: true });
			}
			// Foliate uses closed shadow roots: obtain them through the loaded frame,
			// rather than relying on the hosts' (null) shadowRoot properties.
			let root = doc.defaultView?.frameElement?.getRootNode();
			while (root && root !== this.container.ownerDocument) {
				root.addEventListener('scroll', this.notifySelectionGeometry, { signal: this.listeners.signal, capture: true });
				root = 'host' in root ? (root as ShadowRoot).host.getRootNode() : undefined;
			}
			this.container.ownerDocument?.defaultView?.addEventListener('resize', this.notifySelectionGeometry, {
				signal: this.listeners.signal
			});
			for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
				doc.addEventListener(name, this.events.activity, { signal: this.listeners.signal, passive: true });
			}
			if (view.isFixedLayout) this.paintFixedPage(index, doc);
			this.notifySelectionGeometry();
		});
		view.addEventListener('create-overlay', () => {
			queueMicrotask(() => {
				for (const annotation of this.annotations.values()) {
					void this.drawAnnotation(annotation).catch(this.events.error);
				}
			});
		});
		view.addEventListener('draw-annotation', (event) => {
			const { draw, annotation, doc } = (event as CustomEvent<DrawAnnotation>).detail;
			const style = annotation.style ?? 'highlight';
			const shape = style === 'underline' ? Overlayer.underline
				: style === 'strikeout' ? Overlayer.strikethrough : Overlayer.highlight;
			draw((rects, options) => {
				const element = shape(rects, options);
				element.setAttribute('data-annotation-style', style);
				const last = rects.at(-1);
				if (!annotation.hasNote || !last) return element;
				const group = element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
				const marker = element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
				const vertical = options.writingMode?.startsWith('vertical');
				marker.setAttribute('x', String(vertical ? last.left : last.right - 4));
				marker.setAttribute('y', String(vertical ? last.bottom - 4 : last.top - 8));
				marker.setAttribute('width', '18');
				marker.setAttribute('height', '18');
				marker.setAttribute('viewBox', '0 0 16 16');
				marker.setAttribute('data-annotation-note', 'true');
				marker.setAttribute('role', 'button');
				marker.setAttribute('tabindex', '0');
				marker.setAttribute('aria-label', m['pv8.edit_comment']());
				marker.style.pointerEvents = 'auto';
				marker.style.cursor = 'pointer';
				const activate = (event: Event) => {
					event.preventDefault();
					event.stopPropagation();
					if (annotation.id) for (const listener of this.annotationListeners) listener(annotation.id);
				};
				marker.addEventListener('click', activate);
				marker.addEventListener('keydown', (event) => {
					if (event.key === 'Enter' || event.key === ' ') activate(event);
				});
				const path = element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
				path.setAttribute('d', 'M3 1.5h7l3 3v10H3z M10 1.5v3h3 M5 7h6 M5 10h6');
				path.setAttribute('fill', '#fff3af');
				path.setAttribute('stroke', '#493d1b');
				path.setAttribute('stroke-linejoin', 'round');
				marker.append(path);
				group.append(element, marker);
				return group;
			}, {
				color: resolveMarkColor(annotation.color),
				writingMode: doc?.defaultView?.getComputedStyle(doc.documentElement).writingMode
			});
		});
		this.container.replaceChildren(view);
		if (typeof ResizeObserver !== 'undefined') {
			this.rotationObserver = new ResizeObserver(() => {
				if (this.disposed) return;
				this.layoutRotation();
				this.notifySelectionGeometry();
			});
			this.rotationObserver.observe(this.container);
		}
		await view.open(book);
		this.prepareRotationMeasurements();
	}

	/** Rotate only the book viewport; orientation lasts for this reader session. */
	rotate(delta: -90 | 90): void {
		this.requireView();
		this.rotation = (this.rotation + delta + 360) % 360;
		this.layoutRotation();
		this.notifySelectionGeometry();
	}

	private layoutRotation(): void {
		const view = this.view;
		if (!view) return;
		const sideways = this.rotation === 90 || this.rotation === 270;
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;
		view.style.position = 'relative';
		view.style.width = sideways ? `${height}px` : '100%';
		view.style.height = sideways ? `${width}px` : '100%';
		view.style.left = sideways ? `${(width - height) / 2}px` : '0px';
		view.style.top = sideways ? `${(height - width) / 2}px` : '0px';
		view.style.transformOrigin = 'center center';
		view.style.transform = `rotate(${this.rotation}deg)`;
	}

	private prepareRotationMeasurements(doc?: Document): void {
		if (this.disposed) return;
		for (const [element, descriptor] of this.rotationMeasurements) {
			if (!element.isConnected) this.restoreRotationMeasurement(element, descriptor);
		}
		const renderer = this.view?.renderer;
		if (!renderer) return;
		const measure = (element: HTMLElement | null | undefined) => {
			if (!element || this.rotationMeasurements.has(element)) return;
			const original = element.getBoundingClientRect;
			if (typeof original !== 'function') return;
			this.rotationMeasurements.set(element, Object.getOwnPropertyDescriptor(element, 'getBoundingClientRect'));
			// Foliate has no rotation API and sizes/fits pages using visual rects.
			// Its sizing ancestors need logical rectangles, while iframe rectangles
			// must stay visual for selection geometry. Keep the same center and return
			// a fresh, internally consistent DOMRect; never mutate the native result.
			element.getBoundingClientRect = () => {
				const rect = original.call(element);
				if (this.rotation === 90 || this.rotation === 270) {
					return new DOMRect(
						rect.left + (rect.width - rect.height) / 2,
						rect.top + (rect.height - rect.width) / 2,
						rect.height, rect.width
					);
				}
				return rect;
			};
		};
		measure(renderer);
		const frame = doc?.defaultView?.frameElement;
		const root = frame?.getRootNode() as ShadowRoot | undefined;
		if (root?.host !== renderer) return;
		// Follow the loaded frame's sizing ancestors, without querying Foliate's
		// private IDs or requiring its closed shadow root to become public.
		for (let element = frame?.parentElement; element; element = element.parentElement) measure(element);
	}

	private restoreRotationMeasurement(element: HTMLElement, descriptor: PropertyDescriptor | undefined): void {
		if (descriptor) Object.defineProperty(element, 'getBoundingClientRect', descriptor);
		else delete (element as Partial<HTMLElement>).getBoundingClientRect;
		this.rotationMeasurements.delete(element);
	}

	async goTo(target: Relocation['locator'] | number): Promise<void> {
		const view = this.requireView();
		this.lastLoadError = null;
		if (typeof target === 'number') {
			const position = fraction(target);
			const sections = this.book?.sections ?? [];
			const boundary = position === 0
				? sections.findIndex((section) => section.linear !== 'no' && section.load)
				: position === 1
					? sections.findLastIndex((section) => section.linear !== 'no' && section.load)
					: -1;
			const edge = sections[position === 0 ? 0 : sections.length - 1];
			if (boundary >= 0 && (!edge?.load || edge.linear === 'no')) {
				await view.goTo(boundary);
			} else {
				await view.goToFraction(position);
			}
		} else {
			if (!isCfiLocator(target)) throw new Error('Incompatible book locator.');
			const resolved = view.resolveNavigation(target.value);
			if (!this.isValidResolved(resolved)) throw new Error('Book locator is unavailable.');
			const result = await view.goTo(target.value);
			if (!this.isValidResolved(result)) throw new Error('Book locator could not be opened.');
		}
		if (this.lastLoadError) throw this.lastLoadError;
	}

	async previous(): Promise<void> {
		this.lastLoadError = null;
		await this.requireView().prev();
		if (this.lastLoadError) throw this.lastLoadError;
	}

	async next(): Promise<void> {
		this.lastLoadError = null;
		await this.requireView().next();
		if (this.lastLoadError) throw this.lastLoadError;
	}

	async applySettings(settings: ReaderSettings): Promise<void> {
		const view = this.requireView();
		const background = backgroundFor(settings);
		this.container.style.backgroundColor = background.page;
		this.container.style.backgroundImage = background.grain ?? 'none';
		view.renderer.setAttribute('flow', settings.flow);
		if (view.isFixedLayout) {
			view.renderer.setAttribute('zoom', settings.size === 100 ? 'fit-page' : String(settings.size / 100));
			return;
		}
		view.renderer.setStyles?.(foliateStyles(settings));
	}

	async addAnnotation(annotation: ReaderAnnotation): Promise<void> {
		this.annotations.set(annotation.id, annotation);
		await this.drawAnnotation(annotation);
	}

	async removeAnnotation(annotation: ReaderAnnotation): Promise<void> {
		this.annotations.delete(annotation.id);
		const view = this.requireView();
		if (view.isFixedLayout) {
			for (const [index, doc] of this.documents) this.paintFixedPage(index, doc);
		} else if (isCfiLocator(annotation.locator)) {
			await view.deleteAnnotation({ value: annotation.locator.value, color: annotation.color });
		}
	}

	/** Live native text-selection bounds in the reader host's viewport, not page coordinates. */
	getSelectionBounds(): SelectionBounds | null {
		if (this.disposed || !this.selectionDocument) return null;
		let doc = this.selectionDocument;
		const selection = doc.getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return null;
		let { left, top, right, bottom } = selection.getRangeAt(0).getBoundingClientRect();
		const outer = this.container.ownerDocument;
		while (doc !== outer) {
			// frameElement works across Foliate's nested open shadow roots without DOM queries.
			const frame = doc.defaultView?.frameElement as HTMLElement | null;
			if (!frame?.isConnected || !frame.offsetWidth || !frame.offsetHeight) return null;
			const rect = frame.getBoundingClientRect();
			// Only the outermost frame's viewport rect includes the view's rotation.
			// Inner documents still report geometry in their own unrotated coordinates.
			const rotation = frame.ownerDocument === outer ? this.rotation : 0;
			const sideways = rotation === 90 || rotation === 270;
			const scaleX = (sideways ? rect.height : rect.width) / frame.offsetWidth;
			const scaleY = (sideways ? rect.width : rect.height) / frame.offsetHeight;
			const x1 = (frame.clientLeft + left) * scaleX;
			const x2 = (frame.clientLeft + right) * scaleX;
			const y1 = (frame.clientTop + top) * scaleY;
			const y2 = (frame.clientTop + bottom) * scaleY;
			if (rotation === 90) {
				[left, right, top, bottom] = [rect.right - y2, rect.right - y1, rect.top + x1, rect.top + x2];
			} else if (rotation === 180) {
				[left, right, top, bottom] = [rect.right - x2, rect.right - x1, rect.bottom - y2, rect.bottom - y1];
			} else if (rotation === 270) {
				[left, right, top, bottom] = [rect.left + y1, rect.left + y2, rect.bottom - x2, rect.bottom - x1];
			} else {
				[left, right, top, bottom] = [rect.left + x1, rect.left + x2, rect.top + y1, rect.top + y2];
			}
			doc = frame.ownerDocument;
		}
		const width = right - left;
		const height = bottom - top;
		if (![left, top, right, bottom, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
		return { left, top, right, bottom, width, height };
	}

	clearSelection(): void {
		this.selectionDocument = null;
		for (const doc of this.documents.values()) doc.getSelection()?.removeAllRanges();
		this.events.selection(null);
		this.notifySelection();
	}

	/** Notifies after selection events; scroll/resize passes 'geometry'. Read fresh bounds. */
	subscribeSelection(listener: (reason?: 'geometry') => void): () => void {
		this.selectionListeners.add(listener);
		return () => { this.selectionListeners.delete(listener); };
	}

	subscribeSelectionKeyboard(listener: (event: KeyboardEvent) => void): () => void {
		this.selectionKeyboardListeners.add(listener);
		return () => { this.selectionKeyboardListeners.delete(listener); };
	}

	subscribeAnnotation(listener: (id: string) => void): () => void {
		this.annotationListeners.add(listener);
		return () => { this.annotationListeners.delete(listener); };
	}

	async search(query: string, signal?: AbortSignal): Promise<ReaderSearchResult[]> {
		this.clearSearch();
		if (signal?.aborted) throw new DOMException('Search cancelled.', 'AbortError');
		if (!query.trim()) return [];
		const view = this.requireView();
		const generation = this.searchGeneration;
		const controller = new AbortController();
		this.searchAbort = controller;
		const abort = () => {
			if (generation === this.searchGeneration) this.clearSearch();
			else controller.abort();
		};
		signal?.addEventListener('abort', abort, { once: true });
		const cancelled = () => controller.signal.aborted || generation !== this.searchGeneration || this.disposed;
		const check = () => {
			if (cancelled()) throw new DOMException('Search cancelled.', 'AbortError');
		};
		const previous = this.searchTask;
		// Foliate mutates its highlights before yielding and has no cancellation API.
		// Drain the in-flight step and clear it before starting the next generator.
		const task = (async () => {
			await previous;
			const results: ReaderSearchResult[] = [];
			try {
				check();
				for await (const batch of view.search({ query: query.trim() })) {
					check();
					if (batch === 'done' || 'progress' in batch) continue;
					const matches = 'subitems' in batch ? batch.subitems : [batch];
					const label = 'label' in batch ? batch.label : undefined;
					for (const { cfi, excerpt } of matches) {
						if (!isCfiLocator({ type: 'cfi', value: cfi })) continue;
						const id = `${generation}:${cfi}`;
						if (this.searchResults.has(id)) continue;
						this.searchResults.set(id, cfi);
						results.push({
							id,
							excerpt: { before: excerpt.pre, match: excerpt.match, after: excerpt.post },
							...(label ? { label } : {})
						});
					}
				}
				check();
				return results;
			} catch (error) {
				if (generation === this.searchGeneration) {
					this.searchResults.clear();
					view.clearSearch();
				}
				check();
				throw error;
			} finally {
				if (cancelled()) view.clearSearch();
				signal?.removeEventListener('abort', abort);
				if (this.searchAbort === controller) this.searchAbort = null;
			}
		})();
		this.searchTask = task.then(() => {}, () => {});
		return task;
	}

	async goToSearchResult(result: ReaderSearchResult): Promise<void> {
		const cfi = this.searchResults.get(result.id);
		if (!cfi) throw new Error('Book search result is no longer available.');
		await this.goTo({ type: 'cfi', value: cfi });
	}

	clearSearch(): void {
		this.searchGeneration += 1;
		this.searchAbort?.abort();
		this.searchAbort = null;
		this.searchResults.clear();
		this.view?.clearSearch();
	}

	async destroy(): Promise<void> {
		this.disposed = true;
		this.rotationObserver?.disconnect();
		this.rotationObserver = null;
		for (const [element, descriptor] of this.rotationMeasurements) {
			this.restoreRotationMeasurement(element, descriptor);
		}
		this.listeners.abort();
		this.selectionDocument = null;
		this.selectionListeners.clear();
		this.selectionKeyboardListeners.clear();
		this.annotationListeners.clear();
		this.clearSearch();
		await this.searchTask;
		const view = this.view;
		this.view = null;
		try {
			view?.close();
		} finally {
			view?.remove();
			this.book?.destroy?.();
			this.book = null;
			this.documents.clear();
		}
	}

	private requireView(): View {
		if (!this.view || this.disposed) throw new Error('The reader is not open.');
		return this.view;
	}

	private isolateSearchDocuments(book: FoliateBook): void {
		for (const section of book.sections) {
			const load = section.load?.bind(section);
			if (!load) continue;
			const unload = section.unload?.bind(section);
			let cachedUrl: string | null = null;
			let cachedBlob: Blob | null = null;
			// Search the exact isolated markup used by the renderer so CFIs agree.
			// Capturing the Blob also avoids fetching blob: URLs under the host CSP.
			section.load = async () => {
				const { value: url, blobs } = await captureBookBlobs(load);
				const blob = blobs.get(url) ?? (url === cachedUrl ? cachedBlob : null);
				if (!blob) throw new Error('The reader could not isolate a search section.');
				cachedUrl = url;
				cachedBlob = blob;
				return url;
			};
			section.unload = () => {
				cachedUrl = null;
				cachedBlob = null;
				unload?.();
			};
			section.createDocument = async () => {
				const url = await section.load!();
				const blob = url === cachedUrl ? cachedBlob : null;
				if (!blob) throw new Error('The search section was closed while loading.');
				return new DOMParser().parseFromString(await blob.text(), 'text/html');
			};
		}
	}

	private isValidResolved(value: FoliateResolved | undefined): value is FoliateResolved {
		return !!value && Number.isInteger(value.index) && value.index >= 0 &&
			value.index < (this.book?.sections.length ?? 0);
	}

	private captureSelection(doc: Document, index: number): void {
		const selection = doc.getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount) {
			if (this.selectionDocument === doc) this.selectionDocument = null;
			this.events.selection(null);
			this.notifySelection();
			return;
		}
		const range = selection.getRangeAt(0);
		const text = selection.toString();
		if (!text.trim()) {
			if (this.selectionDocument === doc) this.selectionDocument = null;
			this.events.selection(null);
			this.notifySelection();
			return;
		}
		try {
			const value = this.requireView().getCFI(index, textSelectionRange(doc, range));
			this.selectionDocument = doc;
			this.events.selection({
				text,
				fraction: this.location?.fraction ?? 0,
				locator: { type: 'cfi', value }
			});
			this.notifySelection();
		} catch (error) {
			this.events.error(error);
		}
	}

	private async drawAnnotation(annotation: ReaderAnnotation): Promise<void> {
		const view = this.requireView();
		if (!isCfiLocator(annotation.locator)) throw new Error('Incompatible highlight locator.');
		if (view.isFixedLayout) {
			for (const [index, doc] of this.documents) this.paintFixedPage(index, doc);
		} else {
			await view.addAnnotation({
				id: annotation.id, value: annotation.locator.value, color: annotation.color, style: annotation.style,
				...(annotation.hasNote !== undefined ? { hasNote: annotation.hasNote } : {})
			});
		}
	}

	private paintFixedPage(index: number, doc: Document): void {
		const view = this.requireView();
		const match = Array.from(this.annotations.values()).find((annotation) => {
			if (!isCfiLocator(annotation.locator)) return false;
			return view.resolveNavigation(annotation.locator.value)?.index === index;
		});
		doc.documentElement.style.outline = match
			? `4px solid ${resolveMarkColor(match.color)}`
			: '';
		doc.documentElement.style.outlineOffset = '-4px';
	}
}
