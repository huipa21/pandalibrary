import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { HIGHLIGHT_HEX, highlightColor } from './annotations.js';
import { fraction } from './progress.js';
import { pdfPageAtFraction, pdfPageFraction, rotatePdfRect } from './pdf-layout.js';
import { DEFAULT_SETTINGS, isReaderSettings } from './settings.js';
import {
	isPdfLocator,
	type NormalizedRect,
	type PdfLayout,
	type PdfZoom,
	type PdfViewState,
	type Reader,
	type ReaderAnnotation,
	type ReaderEvents,
	type ReaderLocator,
	type ReaderSettings
} from './types.js';
import './pdf.css';

const assets = import.meta.glob('/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', {
	eager: true,
	query: '?url&no-inline',
	import: 'default'
});

export class PdfBinaryDataFactory {
	async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
		const directories: Record<string, string> = {
			cMapUrl: 'cmaps',
			standardFontDataUrl: 'standard_fonts',
			wasmUrl: 'wasm'
		};
		const directory = directories[kind];
		const url = assets[`/node_modules/pdfjs-dist/${directory}/${filename}`];
		if (typeof url !== 'string') throw new Error('A PDF decoding resource is unavailable.');
		const response = await fetch(url);
		if (!response.ok) throw new Error('Could not load a PDF decoding resource.');
		return new Uint8Array(await response.arrayBuffer());
	}
}

interface PageView {
	page: PDFPageProxy;
	viewport: PageViewport;
	element: HTMLDivElement;
	highlights: HTMLDivElement | null;
	renderTask?: RenderTask;
	textLayer?: { cancel(): void };
	promise?: Promise<void>;
	version: number;
}

export class PdfReader implements Reader {
	private document: PDFDocumentProxy | null = null;
	private loadingTask: PDFDocumentLoadingTask | null = null;
	private page = 1;
	private generation = 0;
	private settings: ReaderSettings = { ...DEFAULT_SETTINGS };
	private annotations = new Map<string, ReaderAnnotation>();
	private views = new Map<number, PageView>();
	private rows: HTMLDivElement[] = [];
	private intersectionObserver: IntersectionObserver | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private width = 0;
	private height = 0;
	private layingOut = false;
	private hasRendered = false;
	private effectiveScale = 1;
	private disposed = false;
	private readonly viewListeners = new Set<(state: PdfViewState) => void>();
	private readonly listeners = new AbortController();

	constructor(private readonly container: HTMLElement, private readonly events: ReaderEvents) {}

	get viewState(): PdfViewState {
		return {
			page: this.page,
			pageCount: this.document?.numPages ?? 0,
			layout: this.settings.pdfLayout ?? 'single',
			zoom: this.settings.pdfZoom ?? 'page-width',
			scale: this.views.get(this.page)?.viewport.scale ?? this.effectiveScale,
			rotation: this.settings.pdfRotation ?? 0,
			coverAlone: this.settings.pdfCoverAlone ?? false,
			theme: this.settings.theme
		};
	}

	subscribeView(listener: (state: PdfViewState) => void): () => void {
		this.viewListeners.add(listener);
		listener(this.viewState);
		return () => { this.viewListeners.delete(listener); };
	}

	async setLayout(layout: PdfLayout): Promise<void> {
		await this.applySettings({ ...this.settings, pdfLayout: layout });
	}

	async setZoom(zoom: PdfZoom): Promise<void> {
		await this.applySettings({ ...this.settings, pdfZoom: zoom });
	}

	async zoomBy(direction: -1 | 1): Promise<void> {
		const scale = typeof this.settings.pdfZoom === 'number' ? this.settings.pdfZoom : this.viewState.scale;
		await this.setZoom(Math.min(5, Math.max(0.1, scale * (direction === 1 ? 1.1 : 1 / 1.1))));
	}

	async rotate(delta: -90 | 90): Promise<void> {
		const rotation = ((this.settings.pdfRotation ?? 0) + delta + 360) % 360;
		if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) {
			await this.applySettings({ ...this.settings, pdfRotation: rotation });
		}
	}

	async setCoverAlone(coverAlone: boolean): Promise<void> {
		await this.applySettings({ ...this.settings, pdfCoverAlone: coverAlone });
	}

	async open(blob: Blob): Promise<void> {
		const [pdfjs, worker, data] = await Promise.all([
			import('pdfjs-dist'),
			import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
			blob.arrayBuffer()
		]);
		if (this.disposed) return;
		pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
		const loadingTask = pdfjs.getDocument({
			data: new Uint8Array(data),
			BinaryDataFactory: PdfBinaryDataFactory,
			useWorkerFetch: false,
			enableXfa: false
		});
		this.loadingTask = loadingTask;
		const loadedDocument = await loadingTask.promise;
		if (this.disposed) {
			await loadingTask.destroy();
			return;
		}
		this.document = loadedDocument;
		this.container.classList.add('reader-pdf');
		document.addEventListener('selectionchange', () => this.captureSelection(), { signal: this.listeners.signal });
		for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
			this.container.addEventListener(name, this.events.activity, { signal: this.listeners.signal, passive: true });
		}
		this.container.addEventListener('scroll', () => this.trackScroll(), { signal: this.listeners.signal, passive: true });
		this.container.addEventListener('wheel', (event) => {
			if (!(event.ctrlKey || event.metaKey) || !event.deltaY) return;
			event.preventDefault();
			void this.zoomBy(event.deltaY < 0 ? 1 : -1).catch(this.events.error);
		}, { signal: this.listeners.signal, passive: false });
		this.container.addEventListener('keydown', (event) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey || !['+', '=', '-', '0'].includes(event.key)) return;
			event.preventDefault();
			void (event.key === '0' ? this.setZoom('auto') : this.zoomBy(event.key === '-' ? -1 : 1)).catch(this.events.error);
		}, { signal: this.listeners.signal });
		this.resizeObserver = new ResizeObserver(() => {
			const width = this.container.clientWidth;
			const height = this.container.clientHeight;
			if (this.views.size && (Math.abs(width - this.width) > 1 || Math.abs(height - this.height) > 1)) {
				void this.render().catch(this.events.error);
			}
			this.width = width;
			this.height = height;
		});
		this.resizeObserver.observe(this.container);
	}

	async goTo(target: ReaderLocator | number): Promise<void> {
		const doc = this.requireDocument();
		if (typeof target === 'number') {
			this.page = pdfPageAtFraction(fraction(target), doc.numPages);
		} else {
			if (!isPdfLocator(target) || target.page > doc.numPages) throw new Error('PDF locator is unavailable.');
			this.page = target.page;
		}
		if (this.continuous && this.views.has(this.page) && !this.layingOut) {
			this.scrollToPage();
			await this.renderSpread();
			this.relocate();
		} else await this.render();
	}

	async previous(): Promise<void> {
		if (this.page > 1) {
			await this.goTo({ type: 'pdf', page: Math.max(1, this.spreadStart(this.page) - this.columns) });
		}
	}

	async next(): Promise<void> {
		const next = this.spreadStart(this.page) + this.spreadSize(this.spreadStart(this.page));
		if (next <= this.requireDocument().numPages) {
			await this.goTo({ type: 'pdf', page: next });
		}
	}

	async applySettings(settings: ReaderSettings): Promise<void> {
		if (!isReaderSettings(settings)) throw new Error('Invalid PDF reader settings.');
		this.settings = { ...settings };
		if (this.hasRendered) await this.render();
		else this.notifyView();
	}

	async addAnnotation(annotation: ReaderAnnotation): Promise<void> {
		if (!isPdfLocator(annotation.locator)) throw new Error('Incompatible highlight locator.');
		this.annotations.set(annotation.id, annotation);
		this.paintAnnotations();
	}

	async removeAnnotation(annotation: ReaderAnnotation): Promise<void> {
		this.annotations.delete(annotation.id);
		this.paintAnnotations();
	}

	async destroy(): Promise<void> {
		this.disposed = true;
		this.generation += 1;
		this.listeners.abort();
		this.resizeObserver?.disconnect();
		this.clearViews();
		this.viewListeners.clear();
		await this.loadingTask?.destroy();
		this.document = null;
		this.container.replaceChildren();
		this.container.classList.remove('reader-pdf');
	}

	private requireDocument(): PDFDocumentProxy {
		if (!this.document) throw new Error('The PDF reader is not open.');
		return this.document;
	}

	private get continuous(): boolean {
		return this.settings.pdfLayout === 'single-continuous' || this.settings.pdfLayout === 'split-continuous';
	}

	private get columns(): number {
		return this.settings.pdfLayout === 'split' || this.settings.pdfLayout === 'split-continuous' ? 2 : 1;
	}

	private spreadStart(page: number): number {
		if (this.columns === 1 || (this.settings.pdfCoverAlone && page === 1)) return page;
		const offset = this.settings.pdfCoverAlone ? 2 : 1;
		return Math.floor((page - offset) / 2) * 2 + offset;
	}

	private spreadSize(first: number): number {
		return this.settings.pdfCoverAlone && first === 1 ? 1 : this.columns;
	}

	private clearViews(): void {
		this.intersectionObserver?.disconnect();
		for (const view of this.views.values()) this.unloadPage(view);
		this.views.clear();
		this.rows = [];
	}

	private unloadPage(view: PageView): void {
		view.version += 1;
		view.renderTask?.cancel();
		view.textLayer?.cancel();
		// Release canvas backing stores, not just their DOM nodes.
		for (const canvas of view.element.querySelectorAll('canvas')) canvas.width = canvas.height = 0;
		view.element.replaceChildren();
		view.highlights = null;
		view.promise = undefined;
	}

	private async render(): Promise<void> {
		this.hasRendered = true;
		const generation = ++this.generation;
		this.layingOut = true;
		this.clearViews();
		this.events.selection(null);
		const doc = this.requireDocument();
		const first = this.continuous ? 1 : this.spreadStart(this.page);
		const last = this.continuous ? doc.numPages : Math.min(doc.numPages, first + this.spreadSize(first) - 1);
		try {
			const pages = await Promise.all(Array.from({ length: last - first + 1 }, (_, index) => doc.getPage(first + index)));
			if (generation !== this.generation || this.disposed) return;
			this.width = this.container.clientWidth;
			this.height = this.container.clientHeight;
			const fragment = document.createDocumentFragment();
			for (let index = 0; index < pages.length;) {
				const count = this.spreadSize(pages[index].pageNumber);
				const spread = pages.slice(index, index + count);
				index += count;
				const natural = spread.map((page) => page.getViewport({ scale: 1, rotation: (page.rotate + (this.settings.pdfRotation ?? 0)) % 360 }));
				const totalWidth = natural.reduce((total, viewport) => total + viewport.width, 0);
				const maxHeight = Math.max(...natural.map((viewport) => viewport.height));
				const fitWidth = Math.max(0.01, (this.width - (spread.length - 1) * 16) / totalWidth);
				const fitPage = Math.min(fitWidth, Math.max(0.01, this.height / maxHeight));
				const zoom = this.settings.pdfZoom ?? 'page-width';
				const scale = typeof zoom === 'number' ? zoom : zoom === 'page-actual' ? 1
					: zoom === 'page-fit' ? fitPage : zoom === 'auto' ? Math.min(1.25, fitWidth) : fitWidth;
				const row = document.createElement('div');
				row.className = 'reader-pdf-row';
				row.dataset.page = String(spread[0].pageNumber);
				for (const page of spread) {
					const viewport = page.getViewport({ scale, rotation: (page.rotate + (this.settings.pdfRotation ?? 0)) % 360 });
					const element = document.createElement('div');
					element.className = 'reader-pdf-page';
					element.dataset.page = String(page.pageNumber);
					element.dataset.theme = this.settings.theme;
					element.style.width = `${viewport.width}px`;
					element.style.height = `${viewport.height}px`;
					this.views.set(page.pageNumber, { page, viewport, element, highlights: null, version: 0 });
					row.append(element);
				}
				this.rows.push(row);
				fragment.append(row);
			}
			if (this.continuous && this.rows.length) this.rows[this.rows.length - 1].style.minHeight = `${this.height}px`;
			this.effectiveScale = this.views.get(this.page)?.viewport.scale ?? this.effectiveScale;
			this.container.dataset.layout = this.settings.pdfLayout ?? 'single';
			this.container.replaceChildren(fragment);
			this.container.scrollLeft = 0;
			this.scrollToPage();
			await this.renderSpread();
			if (generation !== this.generation || this.disposed) return;
			if (this.continuous) {
				this.intersectionObserver = new IntersectionObserver((entries) => {
					if (generation !== this.generation || this.disposed) return;
					for (const entry of entries) {
						const view = this.views.get(Number((entry.target as HTMLElement).dataset.page));
						if (!view) continue;
						if (entry.isIntersecting) void this.renderPage(view, generation).catch(this.events.error);
						else this.unloadPage(view);
					}
				}, { root: this.container, rootMargin: '600px' });
				for (const view of this.views.values()) this.intersectionObserver.observe(view.element);
			}
			this.relocate();
		} finally {
			if (generation === this.generation) this.layingOut = false;
		}
	}

	private scrollToPage(): void {
		const row = this.views.get(this.page)?.element.parentElement;
		if (row) this.container.scrollTop += row.getBoundingClientRect().top - this.container.getBoundingClientRect().top - this.container.clientTop;
	}

	private async renderSpread(): Promise<void> {
		const first = this.spreadStart(this.page);
		await Promise.all(Array.from({ length: this.spreadSize(first) }, (_, index) => {
			const view = this.views.get(first + index);
			return view ? this.renderPage(view, this.generation) : Promise.resolve();
		}));
	}

	private renderPage(view: PageView, generation: number): Promise<void> {
		if (view.promise) return view.promise;
		const promise = this.drawPage(view, generation, view.version).catch((error: unknown) => {
			if (view.promise === promise) view.promise = undefined;
			throw error;
		});
		view.promise = promise;
		return promise;
	}

	private async drawPage(view: PageView, generation: number, version: number): Promise<void> {
		const pdfjs = await import('pdfjs-dist');
		if (generation !== this.generation || this.disposed || version !== view.version || this.views.get(view.page.pageNumber) !== view) return;
		const { viewport, element: wrapper } = view;
		const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
		const canvas = window.document.createElement('canvas');
		canvas.width = Math.ceil(viewport.width * outputScale);
		canvas.height = Math.ceil(viewport.height * outputScale);
		canvas.style.width = `${viewport.width}px`;
		canvas.style.height = `${viewport.height}px`;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas rendering is unavailable.');
		const highlights = window.document.createElement('div');
		highlights.className = 'reader-pdf-highlights';
		const text = window.document.createElement('div');
		text.className = 'reader-pdf-text';
		text.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit));
		wrapper.append(canvas, highlights, text);
		view.highlights = highlights;
		this.paintAnnotations();
		const renderTask = view.page.render({
			canvas,
			canvasContext: context,
			viewport,
			transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
		});
		view.renderTask = renderTask;
		try {
			await renderTask.promise;
		} catch (error) {
			if (error instanceof pdfjs.RenderingCancelledException) return;
			throw error;
		}
		if (generation !== this.generation || this.disposed) return;
		if (!canvas.isConnected) return;
		const textLayer = new pdfjs.TextLayer({ textContentSource: view.page.streamTextContent(), container: text, viewport });
		view.textLayer = textLayer;
		try {
			await textLayer.render();
		} catch (error) {
			if (error instanceof pdfjs.AbortException) return;
			throw error;
		}
	}

	private relocate(): void {
		this.events.relocate({
			fraction: pdfPageFraction(this.page, this.requireDocument().numPages),
			locator: { type: 'pdf', page: this.page }
		});
		this.notifyView();
	}

	private notifyView(): void {
		const state = this.viewState;
		for (const listener of this.viewListeners) listener(state);
	}

	private trackScroll(): void {
		if (!this.continuous || this.layingOut || !this.rows.length) return;
		const top = this.container.getBoundingClientRect().top + this.container.clientTop;
		const row = this.rows.find((row) => row.getBoundingClientRect().bottom > top + 1);
		if (!row) return;
		const first = Number(row.dataset.page);
		if (this.page >= first && this.page < first + this.spreadSize(first)) return;
		this.page = first;
		this.events.selection(null);
		this.relocate();
	}

	private captureSelection(): void {
		const selection = document.getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount) {
			this.events.selection(null);
			return;
		}
		const range = selection.getRangeAt(0);
		const view = [...this.views.values()].find((view) => view.element.contains(range.commonAncestorContainer));
		if (!view) {
			this.events.selection(null);
			return;
		}
		const bounds = view.element.getBoundingClientRect();
		const rects: NormalizedRect[] = [];
		for (const rect of Array.from(range.getClientRects())) {
			const left = Math.max(0, rect.left - bounds.left);
			const top = Math.max(0, rect.top - bounds.top);
			const right = Math.min(bounds.width, rect.right - bounds.left);
			const bottom = Math.min(bounds.height, rect.bottom - bounds.top);
			if (right > left && bottom > top) {
				rects.push(rotatePdfRect({ x: left / bounds.width, y: top / bounds.height, width: (right - left) / bounds.width, height: (bottom - top) / bounds.height }, -(this.settings.pdfRotation ?? 0)));
			}
		}
		const text = selection.toString();
		if (!text.trim() || !rects.length || rects.length > 200) {
			this.events.selection(null);
			return;
		}
		this.events.selection({
			text,
			fraction: pdfPageFraction(view.page.pageNumber, this.requireDocument().numPages),
			locator: { type: 'pdf', page: view.page.pageNumber, rects }
		});
	}

	private paintAnnotations(): void {
		for (const view of this.views.values()) view.highlights?.replaceChildren();
		for (const annotation of this.annotations.values()) {
			if (!isPdfLocator(annotation.locator)) continue;
			const layer = this.views.get(annotation.locator.page)?.highlights;
			if (!layer) continue;
			for (const original of annotation.locator.rects ?? []) {
				const rect = rotatePdfRect(original, this.settings.pdfRotation ?? 0);
				const mark = document.createElement('span');
				mark.className = 'reader-pdf-highlight';
				mark.dataset.annotationId = annotation.id;
				mark.style.left = `${rect.x * 100}%`;
				mark.style.top = `${rect.y * 100}%`;
				mark.style.width = `${rect.width * 100}%`;
				mark.style.height = `${rect.height * 100}%`;
				mark.style.backgroundColor = HIGHLIGHT_HEX[highlightColor(annotation.color)];
				layer.append(mark);
			}
		}
	}
}
