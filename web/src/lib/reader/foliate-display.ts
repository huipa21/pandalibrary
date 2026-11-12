import type { FoliateBook, FoliateRenderer, FoliateResolved } from 'foliate-js/view.js';
import { REFLOW_PAGE, reflowLayout, reflowScale, reflowZoom } from './reflow-display.js';
import type { PdfLayout, ReaderSettings } from './types.js';

type Overlay = { element: Element; redraw(): void };
type NativeRenderer = FoliateRenderer & {
	open(book: FoliateBook): void;
	goTo(target: FoliateResolved | Promise<FoliateResolved>): Promise<void>;
	next(): Promise<void>;
	prev(): Promise<void>;
	destroy(): void;
};
type Page = { index: number; frame: HTMLIFrameElement; ready: Promise<void>; doc?: Document; overlayer?: Overlay };

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
	private settings: ReaderSettings | null = null;
	private layout: PdfLayout = 'single';
	private fixedLayout: PdfLayout | null = null;
	private styles = '';
	private current = 0;
	private scale = 1;
	private pageSize = { ...REFLOW_PAGE };
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
	}

	private get continuous() { return this.layout.endsWith('continuous'); }

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
		this.resize();
		if (previousLayout !== this.layout && previousContents.length) {
			await this.native.goTo({ index: this.current });
		}
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
			// The upstream portrait rule forces one column; the loaded document gives
			// access to that closed root without depending on private element IDs.
			for (const { doc } of this.original.getContents()) {
				const root = doc.defaultView?.frameElement?.getRootNode() as ShadowRoot | undefined;
				if (root?.host !== this.native) continue;
				const top = root.querySelector<HTMLElement>('[part="container"]')?.parentElement;
				top?.style.setProperty('--_max-column-count-portrait', split ? '2' : '1');
			}
		}
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
