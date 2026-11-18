import type { FoliateBook, FoliateRenderer, FoliateResolved } from 'foliate-js/view.js';
import { REFLOW_PAGE, reflowLayout, reflowScale, reflowZoom } from './reflow-display.js';
import type { PagePosition, PdfLayout, ReaderSettings } from './types.js';

type Overlay = { element: Element; redraw(): void };
/** Raw pagination detail, as dispatched by the renderer's relocate event. */
export type PaginationDetail = { fraction?: number; size?: number };
type NativeRenderer = FoliateRenderer & {
	open(book: FoliateBook): void;
	goTo(target: FoliateResolved | Promise<FoliateResolved>): Promise<void>;
	next(): Promise<void>;
	prev(): Promise<void>;
	destroy(): void;
};
type Page = { index: number; frame: HTMLIFrameElement; ready: Promise<void>; doc?: Document; overlayer?: Overlay };

/**
 * Upstream paginators report `fraction = (page - 1) / (pages - 2)` and
 * `size = 1 / (pages - 2)`, because the outermost columns only hold the
 * neighbouring sections. Continuous scrolling reports viewport proportions
 * instead, so a detail that does not invert to whole columns is not pagination.
 */
export function pagePosition(detail: PaginationDetail | null | undefined): PagePosition | null {
	const fraction = detail?.fraction;
	const size = detail?.size;
	if (typeof fraction !== 'number' || typeof size !== 'number') return null;
	if (!Number.isFinite(fraction) || !Number.isFinite(size) || size <= 0 || size > 1) return null;
	const pageCount = Math.round(1 / size);
	if (pageCount < 1 || Math.abs(pageCount * size - 1) > 1e-6) return null;
	const page = Math.round(fraction / size) + 1;
	return { page: Math.min(pageCount, Math.max(1, page)), pageCount };
}

/** Animation is decorative; keep page turns still when the platform asks for less motion. */
function motionAllowed(): boolean {
	return typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Continuous pages are separate documents, so their gestures never reach the
 * scrolling pane. Forward single-touch drags and wheels to it, and leave
 * pinch zoom, selections and links to the document.
 */
export function forwardContinuousScrolling(doc: Document, pane: HTMLElement): void {
	let previous: { x: number; y: number } | null = null;
	let claimed = false;
	const pinched = () => (globalThis.visualViewport?.scale ?? 1) > 1;
	doc.addEventListener('touchstart', (event) => {
		const touch = event.changedTouches[0];
		previous = touch && event.touches.length < 2 && !pinched() ? { x: touch.screenX, y: touch.screenY } : null;
		claimed = false;
	}, { passive: true });
	doc.addEventListener('touchmove', (event) => {
		const touch = event.changedTouches[0];
		const state = previous;
		if (event.touches.length > 1 || pinched()) {
			if (claimed) event.preventDefault();
			previous = null;
			claimed = false;
			return;
		}
		if (!state || !touch) return;
		const selection = doc.getSelection();
		if (selection && selection.rangeCount > 0 && !selection.isCollapsed) return;
		event.preventDefault();
		claimed = true;
		pane.scrollLeft += state.x - touch.screenX;
		pane.scrollTop += state.y - touch.screenY;
		previous = { x: touch.screenX, y: touch.screenY };
	}, { passive: false });
	doc.addEventListener('touchend', () => {
		previous = null;
		claimed = false;
	}, { passive: true });
	doc.addEventListener('wheel', (event) => {
		// Trackpad pinch arrives as ctrl+wheel; leave it to the browser's zoom.
		if (event.ctrlKey) return;
		event.preventDefault();
		const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pane.clientHeight : 1;
		pane.scrollLeft += event.deltaX * step;
		pane.scrollTop += event.deltaY * step;
	}, { passive: false });
}

/**
 * Foliate's fixed renderer has no continuous mode and its scrolled paginator
 * ignores column count. Keep the native paginator for page turns, and expose
 * the same load/relocate/overlayer protocol for a genuinely scrolling surface.
 */
export class FoliateDisplay {
	private readonly native: NativeRenderer;
	private paginated: NativeRenderer;
	private readonly original: {
		goTo: NativeRenderer['goTo']; next: NativeRenderer['next']; prev: NativeRenderer['prev'];
		getContents: FoliateRenderer['getContents']; setStyles: FoliateRenderer['setStyles']; destroy: () => void;
	};
	private readonly pane: HTMLDivElement;
	private readonly viewport: HTMLDivElement;
	private readonly pages: HTMLDivElement;
	private readonly frames = new Map<number, Page>();
	private readonly documentIndices = new WeakMap<Document, number>();
	private readonly observer: ResizeObserver;
	private readonly documentObservers: ResizeObserver[] = [];
	private readonly paginationMeasurements = new Map<HTMLElement, {
		descriptor: PropertyDescriptor | undefined; measure: () => DOMRect;
	}>();
	private settings: ReaderSettings | null = null;
	private layout: PdfLayout = 'single';
	private fixedLayout: PdfLayout | null = null;
	private styles = '';
	private current = 0;
	private scale = 1;
	private pageSize = { ...REFLOW_PAGE };
	private pageDetail: PaginationDetail | null = null;
	private disposed = false;
	private scrollFrame = 0;

	constructor(
		renderer: FoliateRenderer,
		private readonly book: FoliateBook,
		private readonly fixed: boolean,
		private readonly onscale: (scale: number) => void,
		private readonly onerror: (error: unknown) => void
	) {
		this.native = renderer as NativeRenderer;
		this.paginated = this.native;
		this.original = {
			goTo: this.native.goTo.bind(this.native), next: this.native.next.bind(this.native),
			prev: this.native.prev.bind(this.native), getContents: this.native.getContents.bind(this.native),
			setStyles: this.native.setStyles?.bind(this.native), destroy: this.native.destroy.bind(this.native)
		};
		const root = renderer.getRootNode() as ShadowRoot;
		this.viewport = document.createElement('div');
		Object.assign(this.viewport.style, { position: 'absolute', inset: '0', overflow: 'auto' });
		renderer.parentNode!.appendChild(this.viewport);
		this.viewport.append(renderer);
		this.pane = document.createElement('div');
		this.pane.dataset.readerContinuous = '';
		Object.assign(this.pane.style, { position: 'absolute', inset: '0', overflow: 'auto', display: 'none' });
		this.pages = document.createElement('div');
		Object.assign(this.pages.style, { display: 'grid', alignItems: 'start', gap: '16px', margin: '0 auto', padding: '16px 0' });
		this.pane.append(this.pages);
		this.viewport.parentNode!.appendChild(this.pane);
		this.pane.addEventListener('scroll', () => {
			if (this.scrollFrame) return;
			this.scrollFrame = requestAnimationFrame(() => { this.scrollFrame = 0; this.reportLocation('scroll'); });
		});
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(root.host);
		this.native.addEventListener('load', (event) => {
			const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail;
			this.documentIndices.set(doc, index);
			this.preparePaginationMeasurements(doc);
		});
		this.native.addEventListener('relocate', (event) => {
			const { index } = (event as CustomEvent<{ index?: number }>).detail;
			if (index !== undefined) this.current = index;
		});
		this.native.goTo = async (target) => {
			const resolved = await target;
			this.current = resolved.index;
			if (this.continuous) await this.goTo(resolved);
			else await (this.paginated === this.native ? this.original.goTo(resolved) : this.paginated.goTo(resolved));
		};
		this.native.next = () => this.continuous ? this.turn(1)
			: this.paginated === this.native ? this.original.next() : this.paginated.next();
		this.native.prev = () => this.continuous ? this.turn(-1)
			: this.paginated === this.native ? this.original.prev() : this.paginated.prev();
		this.native.getContents = () => this.continuous
			? [...this.frames.values()].filter((page) => page.doc).map((page) => ({
				index: page.index, doc: page.doc!, overlayer: page.overlayer
			}))
			: (this.paginated === this.native ? this.original.getContents() : this.paginated.getContents())
				.filter((item) => item.doc).map((item) => ({
					...item, index: item.index ?? this.documentIndices.get(item.doc)
				}));
		this.native.setStyles = (styles) => {
			if (!styles) return;
			this.styles = styles;
			this.original.setStyles?.(styles);
			for (const page of this.frames.values()) if (page.doc) this.stylePage(page);
		};
		this.native.destroy = () => this.destroy();
		const dispatch = this.native.dispatchEvent.bind(this.native);
		// The view re-emits relocate synchronously and drops the paginator's
		// per-section `size`, and listeners run in registration order, so keep the
		// raw detail before it reaches them. Continuous relocates report viewport
		// proportions instead of pagination and are ignored here.
		this.native.dispatchEvent = (event: Event) => {
			if (event.type === 'relocate' && !this.continuous) {
				const { fraction, size } = (event as CustomEvent<PaginationDetail>).detail ?? {};
				this.pageDetail = { fraction, size };
			}
			return dispatch(event);
		};
	}

	private get continuous() { return this.layout.endsWith('continuous'); }

	/** Raw pagination detail of the last paginated relocate, for per-section page numbers. */
	get pagination(): PaginationDetail | null { return this.pageDetail; }

	async apply(settings: ReaderSettings, styles: string): Promise<void> {
		const previousLayout = this.layout;
		const previousContents = this.native.getContents();
		this.current = previousContents.find((item) => item.index !== undefined)?.index ?? this.current;
		this.settings = settings;
		this.layout = reflowLayout(settings);
		this.styles = styles;
		if (this.continuous) {
			if (!this.fixed && !this.original.getContents().length) {
				this.original.setStyles?.(styles);
				const first = this.book.sections.findIndex((section) => section.load && section.linear !== 'no');
				await this.original.goTo({ index: first >= 0 ? first : this.current });
			}
			this.viewport.style.display = 'none';
			this.native.style.display = 'none';
			if (this.paginated !== this.native) this.paginated.style.display = 'none';
			this.pane.style.display = 'block';
			this.pageDetail = null;
			if (!this.frames.size) this.createPages();
			for (const page of this.frames.values()) if (page.doc) this.stylePage(page);
		} else {
			this.viewport.style.display = 'block';
			this.pane.style.display = 'none';
			if (this.fixed && this.fixedLayout !== this.layout) this.createFixedRenderer();
			this.paginated.style.display = 'block';
			if (!this.fixed) {
				this.native.setAttribute('flow', 'paginated');
				this.native.setAttribute('max-column-count', this.layout === 'split' ? '2' : '1');
				this.original.setStyles?.(styles);
			}
		}
		this.animatePageTurns();
		this.resize();
		if (previousLayout !== this.layout && previousContents.length) {
			await this.native.goTo({ index: this.current });
		}
	}

	/**
	 * The upstream paginator slides columns only while it carries `animated`.
	 * The fixed renderer has no such animation, and continuous scrolling is
	 * driven by the pane, so neither should keep the attribute.
	 */
	private animatePageTurns(): void {
		if (!this.continuous && !this.fixed && motionAllowed()) this.paginated.setAttribute('animated', '');
		else this.paginated.removeAttribute('animated');
	}

	private createFixedRenderer(): void {
		const previous = this.paginated;
		const renderer = document.createElement('foliate-fxl') as NativeRenderer;
		for (const name of ['load', 'relocate', 'create-overlayer']) {
			renderer.addEventListener(name, (event) => {
				this.native.dispatchEvent(new CustomEvent(name, { detail: (event as CustomEvent).detail }));
			});
		}
		const split = this.layout === 'split';
		const book = this.book as FoliateBook & { dir?: string; rendition?: Record<string, unknown> };
		renderer.open({
			...book,
			rendition: { ...book.rendition, spread: split ? 'both' : 'none' },
			sections: book.sections.map((section, index) => ({
				...section,
				pageSpread: split ? (index % 2 === (book.dir === 'rtl' ? 1 : 0) ? 'left' : 'right') : undefined
			}))
		} as FoliateBook);
		this.native.parentNode!.appendChild(renderer);
		renderer.style.justifyContent = 'safe center';
		renderer.style.alignItems = 'safe center';
		this.native.style.display = 'none';
		this.paginated = renderer;
		this.fixedLayout = this.layout;
		if (previous !== this.native) { previous.destroy(); previous.remove(); }
		renderer.addEventListener('load', (event) => {
			const doc = (event as CustomEvent<{ doc: Document }>).detail.doc;
			this.readPageSize(doc);
			this.resize();
		});
	}

	private createPages(): void {
		for (const [index, section] of this.book.sections.entries()) {
			if (!section.load || section.linear === 'no') continue;
			const frame = document.createElement('iframe');
			frame.title = String(index + 1);
			frame.loading = 'lazy';
			frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
			frame.setAttribute('scrolling', 'no');
			Object.assign(frame.style, { display: 'block', border: '0', width: '100%', height: `${this.pageSize.height}px`, minWidth: '0' });
			const page: Page = { index, frame, ready: Promise.resolve() };
			page.ready = new Promise<void>((resolve, reject) => {
				const loaded = () => {
					if (this.disposed) { resolve(); return; }
					const doc = frame.contentDocument;
					if (doc?.URL === 'about:blank') return;
					frame.removeEventListener('load', loaded);
					if (!doc || (!this.fixed && !doc.body)) { reject(new Error('The book section is unavailable.')); return; }
					page.doc = doc;
					this.stylePage(page);
					forwardContinuousScrolling(doc, this.pane);
					this.native.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }));
					if (!this.fixed) this.native.dispatchEvent(new CustomEvent('create-overlayer', { detail: {
						doc, index, attach: (overlayer: Overlay) => {
							page.overlayer = overlayer;
							doc.documentElement.append(overlayer.element);
						}
					} }));
					const observer = new ResizeObserver(() => {
						this.sizePage(page);
						page.overlayer?.redraw();
					});
					observer.observe(doc.body ?? doc.documentElement);
					this.documentObservers.push(observer);
					void doc.fonts?.ready.then(() => this.sizePage(page));
					resolve();
				};
				frame.addEventListener('load', loaded);
				frame.addEventListener('error', () => reject(new Error('The book section could not be loaded.')), { once: true });
				void Promise.resolve(section.load!()).then((src) => {
					if (!this.disposed) frame.src = src;
				}).catch(reject);
			});
			void page.ready.catch(this.onerror);
			this.frames.set(index, page);
			this.pages.append(frame);
		}
	}

	private stylePage(page: Page): void {
		const doc = page.doc!;
		let style = doc.getElementById('pandalibrary-display-style');
		if (!style) {
			style = doc.createElementNS(doc.documentElement.namespaceURI ?? 'http://www.w3.org/1999/xhtml', 'style') as HTMLElement;
			style.id = 'pandalibrary-display-style';
			(doc.head ?? doc.documentElement).append(style);
		}
		const split = this.layout.startsWith('split');
		style.textContent = this.fixed ? 'html,body { margin: 0 !important; overflow: hidden !important; }'
			: `${this.styles}
				html { overflow: hidden !important; }
				body { box-sizing: border-box !important; margin: 0 !important; padding: 32px !important;
					column-count: ${split ? 2 : 1} !important; column-gap: 48px !important; }
				img,svg,video { max-width: 100%; }`;
		this.sizePage(page);
	}

	private readPageSize(doc: Document): { width: number; height: number } {
		const meta = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
		const img = doc.querySelector('img');
		const viewBox = doc.documentElement.getAttribute('viewBox')?.split(/\s+/).map(Number);
		const width = Number(meta.match(/width\s*=\s*([\d.]+)/)?.[1]) || viewBox?.[2] || img?.naturalWidth || REFLOW_PAGE.width;
		const height = Number(meta.match(/height\s*=\s*([\d.]+)/)?.[1]) || viewBox?.[3] || img?.naturalHeight || REFLOW_PAGE.height;
		this.pageSize = { width, height };
		return this.pageSize;
	}

	private sizePage(page: Page): void {
		if (this.disposed || !page.doc) return;
		if (this.fixed) {
			const size = this.readPageSize(page.doc);
			page.frame.style.width = `${size.width}px`;
			page.frame.style.height = `${size.height}px`;
			this.resize();
		} else {
			page.frame.style.height = `${Math.ceil(page.doc.body.getBoundingClientRect().height)}px`;
		}
	}

	resize(): void {
		if (!this.settings || this.disposed) return;
		const host = (this.native.getRootNode() as ShadowRoot).host as HTMLElement;
		const width = host.clientWidth;
		const height = host.clientHeight;
		this.scale = reflowScale(reflowZoom(this.settings, this.fixed), this.layout, width, height, this.fixed ? this.pageSize : REFLOW_PAGE);
		this.onscale(this.scale);
		const split = this.layout.startsWith('split');
		if (this.continuous) {
			Object.assign(this.pages.style, {
				zoom: String(this.scale),
				width: `${(this.fixed ? this.pageSize.width : REFLOW_PAGE.width) * (split ? 2 : 1) + (this.fixed && split ? 16 : 0)}px`,
				gridTemplateColumns: this.fixed && split ? 'repeat(2, 1fr)' : '1fr'
			});
		} else if (this.fixed) {
			this.paginated.setAttribute('zoom', String(this.scale));
		} else {
			const logicalWidth = REFLOW_PAGE.width * (split ? 2 : 1);
			Object.assign(this.native.style, {
				zoom: String(this.scale), width: `${logicalWidth}px`,
				height: `${Math.max(1, height / this.scale)}px`, margin: '0 auto'
			});
			this.native.setAttribute('max-inline-size', `${REFLOW_PAGE.width - 1}px`);
			for (const { doc } of this.original.getContents()) {
				this.preparePaginationMeasurements(doc);
			}
		}
	}

	private preparePaginationMeasurements(doc: Document): void {
		if (this.fixed || this.disposed) return;
		for (const [element, measurement] of this.paginationMeasurements) {
			if (!element.isConnected) this.restorePaginationMeasurement(element, measurement);
		}
		const frame = doc.defaultView?.frameElement;
		const root = frame?.getRootNode() as ShadowRoot | undefined;
		if (root?.host !== this.native) return;
		// The load event precedes Foliate's first render. Its container and page
		// probes must use the same logical pixels as CSS sizes and scroll offsets,
		// not zoomed visual rects. Compose with rotation's existing overrides and
		// leave iframe rectangles untouched for selection/annotation geometry.
		for (let element = frame?.parentElement; element; element = element.parentElement) {
			if (this.paginationMeasurements.has(element)) continue;
			const original = element.getBoundingClientRect;
			const measure = () => {
				const rect = original.call(element);
				const scale = Number(this.native.style.zoom) || 1;
				if (scale === 1) return rect;
				const width = rect.width / scale;
				const height = rect.height / scale;
				return new DOMRect(
					rect.left + (rect.width - width) / 2,
					rect.top + (rect.height - height) / 2, width, height
				);
			};
			this.paginationMeasurements.set(element, {
				descriptor: Object.getOwnPropertyDescriptor(element, 'getBoundingClientRect'), measure
			});
			element.getBoundingClientRect = measure;
		}
		// The upstream portrait rule otherwise forces a single column.
		root.querySelector<HTMLElement>('[part="container"]')?.parentElement?.style
			.setProperty('--_max-column-count-portrait', this.layout === 'split' ? '2' : '1');
	}

	private restorePaginationMeasurement(
		element: HTMLElement,
		measurement: { descriptor: PropertyDescriptor | undefined; measure: () => DOMRect }
	): void {
		// Rotation cleanup may already have restored the original method.
		if (element.getBoundingClientRect === measurement.measure) {
			if (measurement.descriptor) Object.defineProperty(element, 'getBoundingClientRect', measurement.descriptor);
			else delete (element as Partial<HTMLElement>).getBoundingClientRect;
		}
		this.paginationMeasurements.delete(element);
	}

	private async goTo(target: FoliateResolved): Promise<void> {
		const page = this.frames.get(target.index);
		if (!page) throw new Error('The book section is unavailable.');
		page.frame.loading = 'eager';
		await page.ready;
		if (this.disposed || !this.continuous) return;
		const destination = target.anchor as number | FoliateResolved['anchor'];
		const anchor = typeof destination === 'function' ? destination(page.doc!) : null;
		const offset = typeof destination === 'number' ? destination * page.frame.offsetHeight
			: anchor?.getBoundingClientRect().top ?? 0;
		const top = page.frame.getBoundingClientRect().top - this.pane.getBoundingClientRect().top + this.pane.scrollTop;
		this.pane.scrollTop = top + offset * this.scale;
		this.current = target.index;
		this.reportLocation('navigation');
	}

	private async turn(direction: -1 | 1): Promise<void> {
		this.pane.scrollBy({ top: direction * this.pane.clientHeight * 0.9 });
		this.reportLocation('page');
	}

	private reportLocation(reason: string): void {
		if (!this.continuous || this.disposed) return;
		const viewport = this.pane.getBoundingClientRect();
		const page = [...this.frames.values()].find((item) => {
			const rect = item.frame.getBoundingClientRect();
			return item.doc && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom;
		});
		if (!page?.doc) return;
		this.current = page.index;
		const rect = page.frame.getBoundingClientRect();
		const start = Math.max(0, (viewport.top - rect.top) / this.scale);
		const end = Math.min(page.frame.offsetHeight, (viewport.bottom - rect.top) / this.scale);
		let range: Range | null = null;
		if (!this.fixed) {
			const doc = page.doc as Document & { caretRangeFromPoint?(x: number, y: number): Range | null };
			const first = doc.caretRangeFromPoint?.(34, start + 2);
			const last = doc.caretRangeFromPoint?.(page.frame.offsetWidth - 34, Math.max(start + 2, end - 2));
			if (first && last) {
				range = first.cloneRange();
				try { range.setEnd(last.startContainer, last.startOffset); } catch { range = first; }
			}
		}
		this.native.dispatchEvent(new CustomEvent('relocate', { detail: {
			reason, index: page.index, range, fraction: start / Math.max(1, page.frame.offsetHeight),
			size: Math.max(0, end - start) / Math.max(1, page.frame.offsetHeight)
		} }));
	}

	private destroy(): void {
		this.disposed = true;
		cancelAnimationFrame(this.scrollFrame);
		this.observer.disconnect();
		for (const observer of this.documentObservers) observer.disconnect();
		for (const [element, measurement] of this.paginationMeasurements) {
			this.restorePaginationMeasurement(element, measurement);
		}
		this.pane.remove();
		// View.close removes the original renderer after calling destroy.
		this.viewport.parentNode?.appendChild(this.native);
		this.viewport.remove();
		this.frames.clear();
		if (this.paginated !== this.native) { this.paginated.destroy(); this.paginated.remove(); }
		// Paginator.destroy assumes that a document has been opened.
		if (this.fixed || this.original.getContents().length) this.original.destroy();
	}
}
