import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { EventBus as PdfEventBus, PDFLinkService as PdfLinkService, PDFViewer as PdfJsViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { fraction as clampFraction } from '../progress.js';
import type { ReaderCacheBookMeta } from '../range-cache.js';
import { isReaderSettings } from '../settings.js';
import type { ReaderSearchEngine, ReaderSearchResult } from '../search.js';
import { BlobSource, RANGE_CHUNK_SIZE, isBlob, type ReaderSource } from '../source.js';
import {
	isPdfLocator,
	type NormalizedRect,
	type Reader,
	type ReaderAnnotation,
	type ReaderEvents,
	type ReaderLocator,
	type ReaderSettings
} from '../types.js';
import { PdfBinaryDataFactory } from './binary-data.js';
import { pointToRotated } from './geometry.js';
import { highlightPainter } from './highlight-painter.js';
import { isContinuous, layoutFromModes, layoutModes, spreadStart } from './layout.js';
import { PageLayers, placeLayer, layerContext, type PageBox } from './page-layers.js';
import { fromFraction, toFraction } from './progress.js';
import { MAX_RECTS, selectionRects } from './selection-legacy.js';
import type {
	NormalizedPoint,
	PageEnhancer,
	PageLayerPainter,
	PdfLayout,
	PdfRotation,
	PdfViewState,
	PdfZoom
} from './types.js';
import { clampScale, nextScale, presetValue } from './zoom.js';
import { readPdfViewState } from './view-state.js';
import { PdfPageCache } from './page-cache.js';
import { PdfSearch } from './search.js';
import 'pdfjs-dist/web/pdf_viewer.css';
import './pdf.css';

export { PdfBinaryDataFactory };

type ViewerModule = typeof import('pdfjs-dist/web/pdf_viewer.mjs');
type PdfjsModule = typeof import('pdfjs-dist');
type PageView = {
	id: number;
	div: HTMLDivElement;
	canvas?: HTMLCanvasElement | null;
	viewport: { width: number; height: number };
	pdfPage: PDFPageProxy | null;
	textLayer: { div: HTMLElement } | null;
};
type Anchor = { clientX: number; clientY: number };

export interface PdfEngineConfig extends ReaderCacheBookMeta {
	account?: number | null;
	initialSettings?: ReaderSettings | null;
	initialTarget?: ReaderLocator | number | null;
}

const IMAGE_OPS = ['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageXObjectRepeat'] as const;
const ENHANCER_Z = 1;
const OFFSET_STEP = 0.005;
const LARGE_BLOB_STREAM_THRESHOLD = 16 * 1024 * 1024;
const PREFETCH_AHEAD_PAGES = 4;
const PREFETCH_BEHIND_PAGES = 1;

let viewerModule: Promise<ViewerModule> | null = null;

/** pdf_viewer.mjs reads `globalThis.pdfjsLib` when it is evaluated. */
async function loadViewer(): Promise<{ pdfjs: typeof import('pdfjs-dist'); viewer: ViewerModule }> {
	const pdfjs = await import('pdfjs-dist');
	(globalThis as { pdfjsLib?: unknown }).pdfjsLib ??= pdfjs;
	viewerModule ??= import('pdfjs-dist/web/pdf_viewer.mjs');
	return { pdfjs, viewer: await viewerModule };
}

function createRangeTransport(pdfjs: PdfjsModule, source: ReaderSource) {
	let rejectFailure!: (error: unknown) => void;
	const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
	class HttpRangeTransport extends pdfjs.PDFDataRangeTransport {
		private stopped = false;

		constructor() {
			super(source.size, null, true, source.name);
		}

		requestDataRange(begin: number, end: number): void {
			void source.read(begin, end - begin).then((chunk) => {
				if (!this.stopped) this.onDataRange(begin, chunk);
			}, (error) => {
				if (this.stopped) return;
				this.stopped = true;
				rejectFailure(error);
				this.onDataRange(begin, new Uint8Array(0));
			});
		}

		abort(): void {
			this.stopped = true;
			source.close();
		}
	}
	return { transport: new HttpRangeTransport(), failure };
}

function maxCanvasPixels(): number {
	return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 8_388_608 : 16_777_216;
}

function normalizeRotation(value: number): PdfRotation {
	return (((value % 360) + 360) % 360) as PdfRotation;
}

interface Enhancement {
	controller: AbortController;
	overlay: HTMLElement;
}

/** The PDF reader engine: pdf.js `PDFViewer` plus page layers, enhancers and the progress contract. */
export class PdfViewerEngine implements Reader, ReaderSearchEngine {
	private container: HTMLElement;
	private scroller: HTMLDivElement | null = null;
	private viewer: PdfJsViewer | null = null;
	private eventBus: PdfEventBus | null = null;
	private linkService: PdfLinkService | null = null;
	private searchEngine: PdfSearch | null = null;
	private document: PDFDocumentProxy | null = null;
	private loadingTask: PDFDocumentLoadingTask | null = null;
	private source: ReaderSource | null = null;
	private pdfjs: typeof import('pdfjs-dist') | null = null;
	private disposed = false;
	private settings: ReaderSettings | null = null;
	private zoom: PdfZoom = 'auto';
	private layout: PdfLayout = 'single-continuous';
	private position = { page: 1, offset: 0 };
	/** The page last navigated to; a spread reports its first page, but a layout change returns here. */
	private intended: number | null = null;
	private emitted: { page: number; offset: number } | null = null;
	private frame = 0;
	private settle: ReturnType<typeof setTimeout> | undefined;
	private suppressScroll = false;
	private readonly listeners = new AbortController();
	private readonly subscribers = new Set<(state: PdfViewState) => void>();
	private readonly annotations = new Map<string, ReaderAnnotation>();
	private readonly enhancers = new Map<PageEnhancer, Map<number, Enhancement>>();
	private readonly textReady = new Set<number>();
	private readonly paintReady = new Set<number>();
	private readonly canvasReady = new Set<number>();
	private readonly pageImages = new Map<number, Promise<boolean>>();
	private pageCache: PdfPageCache | null = null;
	private account: number | null = null;
	private bookMeta: ReaderCacheBookMeta = {};
	private initialTarget: ReaderLocator | number | null = null;
	private scrollDirection: 1 | -1 = 1;
	private preRenderQueue: number[] = [];
	private activePreRender: { page: number; cancel: () => void } | null = null;
	private preRendering = false;
	private selectionCapture: ((selection: Selection) => void) | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private mutationObserver: MutationObserver | null = null;
	private size = { width: 0, height: 0 };
	readonly pageLayers: { register(painter: PageLayerPainter): () => void; repaint(page?: number): void };
	private readonly layers: PageLayers;

	constructor(container: HTMLElement, private readonly events: ReaderEvents) {
		this.container = container;
		this.layers = new PageLayers(() => this.renderedBoxes(), (page) => this.paintReady.has(page) ? this.pageBox(page) : null);
		this.pageLayers = {
			register: (painter) => {
				const remove = this.layers.register(painter);
				return () => {
					remove();
					if (painter.name === 'highlight' && !this.layers.has('highlight') && !this.disposed) {
						this.layers.register(highlightPainter(() => this.annotations.values(), () => this.viewport));
					}
				};
			},
			repaint: (page) => this.layers.repaint(page)
		};
		this.layers.register(highlightPainter(() => this.annotations.values(), () => this.viewport));
	}

	/** The scroll container (the reader surface itself when it is absolutely positioned). */
	get viewport(): HTMLElement {
		return this.scroller ?? this.container;
	}

	get pdf(): PDFDocumentProxy | null {
		return this.document;
	}

	fingerprint(): string {
		return this.document?.fingerprints[0] ?? '';
	}

	get state(): PdfViewState {
		const pageCount = this.document?.numPages ?? 0;
		const { page, offset } = this.position;
		return {
			page,
			pageCount,
			fraction: pageCount ? toFraction(page, offset, pageCount) : 0,
			offset,
			zoom: this.zoom,
			scale: this.viewer?.currentScale ?? 1,
			layout: this.layout,
			rotation: normalizeRotation(this.viewer?.pagesRotation ?? this.settings?.pdfRotation ?? 0)
		};
	}

	subscribe(listener: (state: PdfViewState) => void): () => void {
		this.subscribers.add(listener);
		listener(this.state);
		return () => { this.subscribers.delete(listener); };
	}

	configure(config: PdfEngineConfig): void {
		if (config.account !== undefined) this.account = config.account;
		this.bookMeta = {
			bookId: config.bookId ?? this.bookMeta.bookId,
			fileId: config.fileId ?? this.bookMeta.fileId,
			bookTitle: config.bookTitle ?? this.bookMeta.bookTitle
		};
		if (config.initialSettings && isReaderSettings(config.initialSettings)) {
			this.settings = { ...config.initialSettings };
			const view = readPdfViewState(this.settings);
			this.zoom = view.zoom;
			this.layout = view.layout;
		}
		if (config.initialTarget !== undefined) {
			this.initialTarget = config.initialTarget;
		}
	}

	async open(input: Blob | ReaderSource): Promise<void> {
		let streamSource: ReaderSource | null = null;
		if (!isBlob(input)) {
			streamSource = input;
			if (input.bookMeta) {
				this.bookMeta = {
					bookId: this.bookMeta.bookId ?? input.bookMeta.bookId,
					fileId: this.bookMeta.fileId ?? input.bookMeta.fileId,
					bookTitle: this.bookMeta.bookTitle ?? input.bookMeta.bookTitle
				};
			}
		} else if (input.size > LARGE_BLOB_STREAM_THRESHOLD) {
			streamSource = new BlobSource(input, {
				id: this.bookMeta.fileId ?? 0,
				format: 'pdf',
				original_filename: this.bookMeta.bookTitle || 'book.pdf',
				size_bytes: input.size,
				download_url: '',
				created_at: '',
				is_default: true
			}, this.bookMeta);
		}
		// Warm head and tail chunks in parallel while pdf.js viewer and worker modules load.
		const warmupPromise = streamSource?.warmup ? streamSource.warmup().catch(() => null) : Promise.resolve(null);
		const [{ pdfjs, viewer: module }, worker] = await Promise.all([
			loadViewer(),
			import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
			warmupPromise
		]);
		if (this.disposed) return;
		this.pdfjs = pdfjs;
		pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
		let options: Record<string, unknown>;
		let failure: Promise<never> | null = null;
		if (!streamSource && isBlob(input)) {
			options = { data: new Uint8Array(await input.arrayBuffer()) };
		} else {
			const activeSource = streamSource!;
			this.source = activeSource;
			const range = createRangeTransport(pdfjs, activeSource);
			failure = range.failure;
			options = {
				range: range.transport,
				rangeChunkSize: RANGE_CHUNK_SIZE,
				disableAutoFetch: true
			};
		}
		const loadingTask = pdfjs.getDocument({
			...options,
			BinaryDataFactory: PdfBinaryDataFactory,
			useWorkerFetch: false,
			verbosity: pdfjs.VerbosityLevel.ERRORS,
			enableXfa: false
		});
		this.loadingTask = loadingTask;
		let pdf: PDFDocumentProxy;
		try {
			pdf = failure ? await Promise.race([loadingTask.promise, failure]) : await loadingTask.promise;
		} catch (error) {
			await loadingTask.destroy().catch(() => {});
			this.source?.close();
			this.source = null;
			throw error;
		}
		if (this.disposed) {
			await loadingTask.destroy();
			this.source?.close();
			this.source = null;
			return;
		}
		this.document = pdf;
		this.pageCache?.dispose();
		this.pageCache = new PdfPageCache({
			account: this.account,
			bookId: this.bookMeta.bookId,
			fileId: this.bookMeta.fileId,
			bookTitle: this.bookMeta.bookTitle,
			fingerprint: this.fingerprint()
		});
		this.mount(module);
		const viewer = this.viewer!;
		const initialized = new Promise<void>((resolve) => this.eventBus!.on('pagesinit', () => resolve(), { once: true }));
		viewer.setDocument(pdf);
		this.linkService?.setDocument(pdf);
		this.searchEngine?.controller.setDocument(pdf);
		await initialized;
		if (this.disposed) return;
		this.decoratePages();
		const initialResolved = this.resolveTarget(this.initialTarget, pdf.numPages);
		if (initialResolved) {
			this.position = {
				page: spreadStart(initialResolved.page, this.layout),
				offset: isContinuous(this.layout) ? initialResolved.offset : 0
			};
			this.intended = initialResolved.page;
		}
		this.applyView(this.settings ? readPdfViewState(this.settings) : { layout: this.layout, zoom: this.zoom, rotation: 0 });
		if (initialResolved) {
			await this.goToPage(initialResolved.page, initialResolved.offset).catch(() => {});
		}
		this.showVisiblePreviews();
	}

	private mount(module: ViewerModule): void {
		const { signal } = this.listeners;
		const position = getComputedStyle(this.container).position;
		let scroller: HTMLDivElement;
		if (this.container instanceof HTMLDivElement && (position === 'absolute' || position === 'fixed')) {
			scroller = this.container;
		} else {
			if (position === 'static') this.container.style.position = 'relative';
			scroller = document.createElement('div');
			scroller.style.position = 'absolute';
			scroller.style.inset = '0';
			this.container.append(scroller);
		}
		this.scroller = scroller;
		scroller.classList.add('reader-pdf', 'pv-viewport');
		if (this.settings) scroller.dataset.theme = this.settings.theme;
		const viewerDiv = document.createElement('div');
		viewerDiv.className = 'pdfViewer';
		scroller.replaceChildren(viewerDiv);
		const eventBus = new module.EventBus();
		const linkService = new module.PDFLinkService({ eventBus });
		const searchEngine = new PdfSearch(module.PDFFindController, eventBus, linkService);
		const viewer = new module.PDFViewer({
			container: scroller,
			viewer: viewerDiv,
			eventBus,
			linkService,
			findController: searchEngine.controller,
			textLayerMode: 1,
			annotationMode: this.pdfjs!.AnnotationMode.ENABLE,
			annotationEditorMode: this.pdfjs!.AnnotationEditorType.DISABLE,
			removePageBorders: true,
			maxCanvasPixels: maxCanvasPixels()
		});
		linkService.setViewer(viewer);
		this.viewer = viewer;
		this.eventBus = eventBus;
		this.linkService = linkService;
		this.searchEngine = searchEngine;

		eventBus.on('pagerender', ({ pageNumber }: { pageNumber: number }) => {
			this.canvasReady.delete(pageNumber);
			this.abortEnhancements(pageNumber);
			this.showCachedPagePreview(pageNumber);
		});
		eventBus.on('pagerendered', ({ pageNumber }: { pageNumber: number }) => this.pageRendered(pageNumber));
		eventBus.on('textlayerrendered', ({ pageNumber }: { pageNumber: number }) => this.textRendered(pageNumber));
		eventBus.on('pagesloaded', () => {
			if (typeof this.zoom === 'string') this.preserving(() => { viewer.currentScaleValue = this.zoom as string; });
			this.scheduleRelocate();
		});
		eventBus.on('scalechanging', () => this.notify());
		eventBus.on('rotationchanging', () => this.notify());
		eventBus.on('pagechanging', () => this.scheduleRelocate());
		scroller.addEventListener('scroll', () => this.scheduleRelocate(), { signal, passive: true });
		for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
			scroller.addEventListener(name, this.events.activity, { signal, passive: true });
		}
		document.addEventListener('selectionchange', () => this.captureSelection(), { signal });
		this.size = { width: scroller.clientWidth, height: scroller.clientHeight };
		this.resizeObserver = new ResizeObserver(() => {
			const width = scroller.clientWidth;
			const height = scroller.clientHeight;
			if (Math.abs(width - this.size.width) <= 1 && Math.abs(height - this.size.height) <= 1) return;
			this.size = { width, height };
			if (typeof this.zoom === 'string' && this.document) this.preserving(() => { viewer.currentScaleValue = this.zoom as string; });
		});
		this.resizeObserver.observe(scroller);
		// pdf.js discards unknown page children when it recycles a page; that ends its enhancement.
		this.mutationObserver = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.removedNodes) {
					if (node instanceof HTMLElement && node.classList.contains('reader-pdf-enhancement')) {
						this.abortEnhancements(Number(node.dataset.page), node);
					} else if (node instanceof HTMLElement && (node.classList.contains('canvasWrapper') || node.tagName === 'CANVAS')) {
						const pageDiv = record.target instanceof HTMLElement
							? record.target.closest<HTMLElement>('.page[data-page-number]')
							: null;
						if (pageDiv) {
							this.canvasReady.delete(Number(pageDiv.dataset.pageNumber));
						}
					}
				}
			}
		});
		this.mutationObserver.observe(viewerDiv, { childList: true, subtree: true });
	}

	async goTo(target: ReaderLocator | number): Promise<void> {
		const pages = this.requireDocument().numPages;
		if (typeof target === 'number') {
			const { page, offset } = fromFraction(clampFraction(target), pages);
			return this.goToPage(page, offset);
		}
		if (!isPdfLocator(target) || target.page > pages) throw new Error('PDF locator is unavailable.');
		const offset = (target as { offset?: unknown }).offset;
		return this.goToPage(target.page, typeof offset === 'number' && offset >= 0 && offset < 1 ? offset : 0);
	}

	async search(query: string, signal?: AbortSignal): Promise<ReaderSearchResult[]> {
		this.requireViewer();
		if (this.disposed || !this.searchEngine) throw new Error('The PDF reader is not open.');
		return this.searchEngine.search(query, signal);
	}

	async goToSearchResult(result: ReaderSearchResult): Promise<void> {
		this.requireViewer();
		if (this.disposed || !this.searchEngine) throw new Error('The PDF reader is not open.');
		await this.searchEngine.goToSearchResult(result);
		this.intended = result.page ?? null;
		this.scheduleRelocate();
	}

	clearSearch(): void {
		this.searchEngine?.clearSearch();
	}

	async goToPage(page: number, offset = 0): Promise<void> {
		const viewer = this.requireViewer();
		const pages = this.requireDocument().numPages;
		if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error('PDF locator is unavailable.');
		const off = Number.isFinite(offset) ? Math.min(0.999999, Math.max(0, offset)) : 0;
		this.suppressScroll = true;
		viewer.currentPageNumber = page;
		if (isContinuous(this.layout)) this.scrollToPage(page, off);
		this.position = { page: spreadStart(page, this.layout), offset: isContinuous(this.layout) ? off : 0 };
		if (isContinuous(this.layout)) this.position = this.measure() ?? this.position;
		this.intended = page;
		this.suppressScroll = false;
		this.relocate();
	}

	async previous(): Promise<void> {
		this.requireViewer();
		const { page, offset } = this.position;
		if (offset > 0.01) return this.goToPage(page);
		if (page > 1) return this.goToPage(spreadStart(page - 1, this.layout));
	}

	async next(): Promise<void> {
		this.requireViewer();
		const pages = this.requireDocument().numPages;
		const start = spreadStart(this.position.page, this.layout);
		const size = this.layout.startsWith('split') ? 2 : 1;
		if (start + size <= pages) return this.goToPage(start + size);
	}

	async applySettings(settings: ReaderSettings): Promise<void> {
		if (!isReaderSettings(settings)) throw new Error('Invalid PDF reader settings.');
		this.settings = { ...settings };
		if (this.viewer && this.document) this.applyView(readPdfViewState(settings));
		else {
			const view = readPdfViewState(settings);
			this.zoom = view.zoom;
			this.layout = view.layout;
			this.notify();
		}
	}

	setZoom(zoom: PdfZoom, anchor?: Anchor): void {
		const viewer = this.requireViewer();
		this.zoom = typeof zoom === 'number' ? clampScale(zoom) : zoom;
		const point = anchor ? this.hitTest(anchor.clientX, anchor.clientY) : null;
		if (point && anchor) {
			viewer.currentScaleValue = presetValue(this.zoom);
			this.restoreAnchor(point, anchor);
		} else this.preserving(() => { viewer.currentScaleValue = presetValue(this.zoom); });
		this.scheduleRelocate();
		this.notify();
	}

	zoomBy(steps: number, anchor?: Anchor): void {
		let scale = this.state.scale;
		const direction = steps < 0 ? -1 : 1;
		for (let index = 0; index < Math.max(1, Math.round(Math.abs(steps))); index++) scale = nextScale(scale, direction);
		this.setZoom(scale, anchor);
	}

	setLayout(layout: PdfLayout): void {
		this.applyView({ layout, zoom: this.zoom, rotation: this.state.rotation });
	}

	rotate(delta: 90 | -90): void {
		const viewer = this.requireViewer();
		const rotation = normalizeRotation(viewer.pagesRotation + delta);
		this.applyView({ layout: this.layout, zoom: this.zoom, rotation });
	}

	pageElement(page: number): HTMLElement | null {
		return this.pageView(page)?.div ?? null;
	}

	hitTest(clientX: number, clientY: number): { page: number; point: NormalizedPoint } | null {
		if (!this.viewer || typeof document.elementsFromPoint !== 'function') return null;
		for (const element of document.elementsFromPoint(clientX, clientY)) {
			const div = element.closest<HTMLElement>('.page[data-page-number]');
			if (!div || !this.viewport.contains(div)) continue;
			const page = Number(div.dataset.pageNumber);
			const box = this.pageBox(page);
			if (!box) return null;
			return { page, point: layerContext(box, div).fromClient(clientX, clientY) };
		}
		return null;
	}

	addPageEnhancer(enhancer: PageEnhancer): () => void {
		if (!this.enhancers.has(enhancer)) {
			this.enhancers.set(enhancer, new Map());
			for (const page of this.textReady) this.enhance(enhancer, page);
		}
		return () => {
			const runs = this.enhancers.get(enhancer);
			if (!runs) return;
			this.enhancers.delete(enhancer);
			for (const run of runs.values()) this.endEnhancement(run);
		};
	}

	rerunEnhancers(page?: number): void {
		const pages = page === undefined ? [...this.textReady] : this.textReady.has(page) ? [page] : [];
		for (const target of pages) {
			this.abortEnhancements(target);
			this.textReady.add(target);
			for (const enhancer of this.enhancers.keys()) this.enhance(enhancer, target);
		}
	}

	setSelectionCapture(capture: ((selection: Selection) => void) | null): void {
		this.selectionCapture = capture;
	}

	async addAnnotation(annotation: ReaderAnnotation): Promise<void> {
		if (!isPdfLocator(annotation.locator)) throw new Error('Incompatible highlight locator.');
		this.annotations.set(annotation.id, annotation);
		this.layers.repaint(annotation.locator.page);
	}

	async removeAnnotation(annotation: ReaderAnnotation): Promise<void> {
		const existing = this.annotations.get(annotation.id);
		this.annotations.delete(annotation.id);
		const locator = existing?.locator ?? annotation.locator;
		this.layers.repaint(isPdfLocator(locator) ? locator.page : undefined);
	}

	async destroy(): Promise<void> {
		this.disposed = true;
		this.searchEngine?.destroy();
		this.searchEngine = null;
		this.listeners.abort();
		cancelAnimationFrame(this.frame);
		clearTimeout(this.settle);
		this.resizeObserver?.disconnect();
		this.mutationObserver?.disconnect();
		for (const runs of this.enhancers.values()) for (const run of runs.values()) run.controller.abort();
		this.enhancers.clear();
		this.layers.clear();
		this.subscribers.clear();
		this.pageImages.clear();
		this.textReady.clear();
		this.paintReady.clear();
		this.canvasReady.clear();
		this.activePreRender?.cancel();
		this.activePreRender = null;
		this.preRenderQueue = [];
		this.pageCache?.dispose();
		this.pageCache = null;
		try {
			this.viewer?.cleanup();
			this.viewer?.setDocument(null as unknown as PDFDocumentProxy);
		} catch (error) {
			console.warn('Could not release the PDF viewer', error);
		}
		this.linkService?.setDocument(null);
		await this.loadingTask?.destroy();
		this.loadingTask = null;
		this.source?.close();
		this.source = null;
		this.viewer = null;
		this.document = null;
		if (this.scroller === this.container) {
			this.container.replaceChildren();
			this.container.classList.remove('reader-pdf', 'pv-viewport');
			delete this.container.dataset.layout;
			delete this.container.dataset.theme;
		} else this.container.replaceChildren();
		this.scroller = null;
	}

	private requireDocument(): PDFDocumentProxy {
		if (!this.document) throw new Error('The PDF reader is not open.');
		return this.document;
	}

	private requireViewer(): PdfJsViewer {
		if (!this.viewer || !this.document) throw new Error('The PDF reader is not open.');
		return this.viewer;
	}

	private pageView(page: number): PageView | null {
		if (!this.viewer || page < 1 || page > this.viewer.pagesCount) return null;
		return (this.viewer.getPageView(page - 1) as PageView | undefined) ?? null;
	}

	private pageBox(page: number): PageBox | null {
		const view = this.pageView(page);
		if (!view) return null;
		const rotation = normalizeRotation(this.viewer!.pagesRotation);
		const sideways = rotation === 90 || rotation === 270;
		// pdf.js rounds the page div to device pixels; layers follow the div, not the exact viewport.
		const style = getComputedStyle(view.div);
		const shownWidth = parseFloat(style.width) || view.viewport.width;
		const shownHeight = parseFloat(style.height) || view.viewport.height;
		return {
			page,
			div: view.div,
			width: sideways ? shownHeight : shownWidth,
			height: sideways ? shownWidth : shownHeight,
			rotation
		};
	}

	private *renderedBoxes(): Iterable<PageBox> {
		for (const page of this.paintReady) {
			const box = this.pageBox(page);
			if (box) yield box;
		}
	}

	/** Adds the reader's stable selectors to pdf.js page divs. */
	private decoratePages(): void {
		const viewer = this.viewer!;
		for (let page = 1; page <= viewer.pagesCount; page++) {
			const div = this.pageView(page)?.div;
			if (!div) continue;
			div.classList.add('reader-pdf-page');
			div.dataset.page = String(page);
		}
	}

	private applyView(view: { layout: PdfLayout; zoom: PdfZoom; rotation: PdfRotation }): void {
		const viewer = this.viewer;
		if (!viewer) return;
		const before = this.measure() ?? this.position;
		const target = this.intended !== null && spreadStart(this.intended, this.layout) === before.page ? this.intended : before.page;
		const { scrollMode, spreadMode } = layoutModes(view.layout);
		const zoom = typeof view.zoom === 'number' ? clampScale(view.zoom) : view.zoom;
		const changed = viewer.scrollMode !== scrollMode || viewer.spreadMode !== spreadMode ||
			normalizeRotation(viewer.pagesRotation) !== view.rotation || viewer.currentScaleValue !== presetValue(zoom);
		({ layout: this.layout } = layoutFromModes(scrollMode, spreadMode));
		this.viewport.dataset.layout = this.layout;
		this.zoom = zoom;
		if (!changed) {
			this.notify();
			return;
		}
		this.suppressScroll = true;
		try {
			if (viewer.scrollMode !== scrollMode) viewer.scrollMode = scrollMode;
			if (viewer.spreadMode !== spreadMode) viewer.spreadMode = spreadMode;
			if (normalizeRotation(viewer.pagesRotation) !== view.rotation) viewer.pagesRotation = view.rotation;
			if (viewer.currentScaleValue !== presetValue(zoom)) viewer.currentScaleValue = presetValue(zoom);
		} finally {
			this.suppressScroll = false;
		}
		this.layers.repaint();
		void this.goToPage(target, before.offset).catch(this.events.error);
	}

	/** Keeps the top page and offset across a scale change that pdf.js would otherwise anchor to its own location. */
	private preserving(change: () => void): void {
		const { page, offset } = this.measure() ?? this.position;
		this.suppressScroll = true;
		change();
		if (isContinuous(this.layout)) this.scrollToPage(page, offset);
		this.suppressScroll = false;
	}

	private restoreAnchor(hit: { page: number; point: NormalizedPoint }, anchor: Anchor): void {
		const div = this.pageElement(hit.page);
		const box = this.pageBox(hit.page);
		if (!div || !box) return;
		const rect = div.getBoundingClientRect();
		const rotated = pointToRotated(hit.point, box.rotation);
		this.viewport.scrollLeft += rect.left + rotated.x * rect.width - anchor.clientX;
		this.viewport.scrollTop += rect.top + rotated.y * rect.height - anchor.clientY;
	}

	private scrollToPage(page: number, offset: number): void {
		const div = this.pageElement(page);
		if (!div) return;
		const rect = div.getBoundingClientRect();
		const top = this.viewport.getBoundingClientRect().top + this.viewport.clientTop;
		this.viewport.scrollTop += rect.top - top + offset * rect.height;
	}

	/** Top page and offset of a continuous layout, or the displayed spread of a paged one. */
	private measure(): { page: number; offset: number } | null {
		const viewer = this.viewer;
		const pages = this.document?.numPages ?? 0;
		if (!viewer || !pages) return null;
		if (!isContinuous(this.layout)) {
			return { page: spreadStart(viewer.currentPageNumber, this.layout), offset: 0 };
		}
		const scroller = this.viewport;
		if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) {
			return { page: spreadStart(pages, this.layout), offset: 0 };
		}
		const top = scroller.getBoundingClientRect().top + scroller.clientTop;
		let low = 1;
		let high = pages;
		while (low < high) {
			const middle = (low + high) >> 1;
			const rect = this.pageElement(middle)?.getBoundingClientRect();
			if (rect && rect.bottom > top + 0.5) high = middle;
			else low = middle + 1;
		}
		const page = spreadStart(low, this.layout);
		const rect = this.pageElement(page)?.getBoundingClientRect();
		const offset = rect && rect.height ? Math.min(0.9999, Math.max(0, (top - rect.top) / rect.height)) : 0;
		return { page, offset: Math.round(offset * 10_000) / 10_000 };
	}

	private scheduleRelocate(): void {
		if (this.suppressScroll || this.disposed || !this.document) return;
		if (!this.frame) {
			this.frame = requestAnimationFrame(() => {
				this.frame = 0;
				this.track(false);
			});
		}
		clearTimeout(this.settle);
		this.settle = setTimeout(() => this.track(true), 200);
	}

	private track(final: boolean): void {
		if (this.disposed || !this.document) return;
		const next = this.measure();
		if (!next) return;
		if (next.page !== this.position.page) {
			this.scrollDirection = next.page < this.position.page ? -1 : 1;
			this.intended = null;
		}
		this.position = next;
		this.showVisiblePreviews();
		const last = this.emitted;
		if (last && last.page === next.page && Math.abs(last.offset - next.offset) < (final ? 1e-4 : OFFSET_STEP)) {
			this.notify();
			return;
		}
		this.relocate();
		this.prefetchPages(this.position.page);
	}

	private relocate(): void {
		const pages = this.requireDocument().numPages;
		const { page, offset } = this.position;
		if (this.emitted?.page === page && this.emitted.offset === offset) {
			this.notify();
			return;
		}
		this.emitted = { page, offset };
		this.events.relocate({
			fraction: toFraction(page, offset, pages),
			locator: { type: 'pdf', page, ...(offset > 0 ? { offset } : {}) }
		});
		this.notify();
	}

	private notify(): void {
		if (!this.document) return;
		const state = this.state;
		for (const listener of this.subscribers) listener(state);
	}

	private resolveTarget(target: ReaderLocator | number | null | undefined, pages: number): { page: number; offset: number } | null {
		if (target === null || target === undefined || pages <= 0) return null;
		if (typeof target === 'number') {
			return fromFraction(clampFraction(target), pages);
		}
		if (isPdfLocator(target) && target.page >= 1 && target.page <= pages) {
			const off = (target as { offset?: unknown }).offset;
			return {
				page: target.page,
				offset: typeof off === 'number' && off >= 0 && off < 1 ? off : 0
			};
		}
		return null;
	}

	private showVisiblePreviews(): void {
		if (this.disposed || !this.document || !this.pageCache) return;
		const total = this.document.numPages;
		const center = this.position.page;
		for (let page = Math.max(1, center - 1); page <= Math.min(total, center + 2); page += 1) {
			if (!this.canvasReady.has(page)) {
				this.showCachedPagePreview(page);
			}
		}
	}

	private showCachedPagePreview(page: number): void {
		if (this.disposed || !this.pageCache || this.canvasReady.has(page)) return;
		const view = this.pageView(page);
		if (!view) return;
		const rotation = this.state.rotation;
		const scale = this.state.scale;
		const immediate = this.pageCache.getMemory(page, rotation, scale);
		if (immediate) {
			this.paintPreviewCanvas(view.div, immediate);
			return;
		}
		void this.pageCache.get(page, rotation, scale).then((bitmap) => {
			if (!bitmap || this.disposed || this.canvasReady.has(page)) return;
			const currentView = this.pageView(page);
			if (currentView) this.paintPreviewCanvas(currentView.div, bitmap);
		});
	}

	private paintPreviewCanvas(pageDiv: HTMLElement, bitmap: ImageBitmap): void {
		if (!bitmap.width || !bitmap.height) return;
		let preview = pageDiv.querySelector<HTMLCanvasElement>(':scope > canvas.reader-pdf-page-preview');
		if (!preview) {
			preview = document.createElement('canvas');
			preview.className = 'reader-pdf-page-preview';
			preview.setAttribute('aria-hidden', 'true');
			pageDiv.prepend(preview);
		}
		if (preview.width !== bitmap.width || preview.height !== bitmap.height) {
			preview.width = bitmap.width;
			preview.height = bitmap.height;
		}
		const ctx = preview.getContext('2d');
		if (ctx) {
			ctx.clearRect(0, 0, preview.width, preview.height);
			ctx.drawImage(bitmap, 0, 0, preview.width, preview.height);
		}
	}

	private pageRendered(page: number): void {
		const view = this.pageView(page);
		if (!view) return;
		view.div.classList.add('reader-pdf-page');
		view.div.dataset.page = String(page);
		view.div.querySelector(':scope > canvas.reader-pdf-page-preview')?.remove();
		this.canvasReady.add(page);
		this.paintReady.add(page);
		const box = this.pageBox(page);
		if (box) this.layers.paintPage(box);
		const renderedCanvas = view.canvas ?? view.div.querySelector<HTMLCanvasElement>('canvas:not(.reader-pdf-page-preview)');
		if (renderedCanvas) {
			void this.pageCache?.captureCanvas(page, this.state.rotation, this.state.scale, renderedCanvas);
		}
		this.prefetchPages(this.position.page);
	}

	/**
	 * Sliding-window page prefetcher: warms upcoming pages in the scroll direction
	 * into the persistent page bitmap cache and triggers HttpRangeSource chunk prefetching.
	 */
	private prefetchPages(centerPage: number): void {
		if (!this.document || this.disposed) return;
		const total = this.document.numPages;
		const dir = this.scrollDirection;
		const windowPages: number[] = [];
		for (let step = 1; step <= PREFETCH_AHEAD_PAGES; step += 1) {
			const next = centerPage + step * dir;
			if (next >= 1 && next <= total) windowPages.push(next);
		}
		for (let step = 1; step <= PREFETCH_BEHIND_PAGES; step += 1) {
			const prev = centerPage - step * dir;
			if (prev >= 1 && prev <= total) windowPages.push(prev);
		}
		for (const next of windowPages.slice(0, 2)) {
			void this.document.getPage(next).catch(() => {});
		}
		if (!this.pageCache) return;
		const keepSet = new Set(windowPages);
		if (this.activePreRender && !keepSet.has(this.activePreRender.page)) {
			this.activePreRender.cancel();
			this.activePreRender = null;
		}
		const rotation = this.state.rotation;
		const scale = this.state.scale;
		this.preRenderQueue = windowPages.filter(
			(target) => !this.canvasReady.has(target) && !this.pageCache!.hasMemory(target, rotation, scale)
		);
		void this.pumpPreRenderQueue();
	}

	private async pumpPreRenderQueue(): Promise<void> {
		if (this.preRendering || this.disposed || !this.document || !this.pageCache) return;
		// Yield until the currently visible page has finished rendering so pre-rendering never blocks it.
		if (!this.canvasReady.has(this.position.page)) return;
		this.preRendering = true;
		try {
			while (this.preRenderQueue.length > 0 && !this.disposed && this.document && this.pageCache) {
				if (!this.canvasReady.has(this.position.page)) break;
				const targetPage = this.preRenderQueue.shift()!;
				const rotation = this.state.rotation;
				const scale = this.state.scale;
				if (this.canvasReady.has(targetPage) || this.pageCache.hasMemory(targetPage, rotation, scale)) {
					continue;
				}
				// First check persistent Cache Storage so already-cached pages decode without pdf.js worker work.
				const fromDisk = await this.pageCache.get(targetPage, rotation, scale);
				if (this.disposed) break;
				if (fromDisk) {
					if (!this.canvasReady.has(targetPage)) this.showCachedPagePreview(targetPage);
					continue;
				}
				if (!this.source || typeof document === 'undefined') continue;
				let pdfPage: PDFPageProxy;
				try {
					pdfPage = await this.document.getPage(targetPage);
				} catch {
					continue;
				}
				if (this.disposed || this.canvasReady.has(targetPage)) continue;
				if (typeof pdfPage.getViewport !== 'function' || typeof pdfPage.render !== 'function') continue;
				const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
				const renderScale = Math.max(0.5, Math.min(scale * dpr, 2));
				const viewport = pdfPage.getViewport({ scale: renderScale, rotation });
				const width = Math.max(1, Math.floor(viewport.width));
				const height = Math.max(1, Math.floor(viewport.height));
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const canvasContext = canvas.getContext('2d');
				if (!canvasContext) continue;
				const renderTask = pdfPage.render({
					canvasContext,
					canvas,
					viewport
				});
				this.activePreRender = {
					page: targetPage,
					cancel: () => {
						try { renderTask.cancel(); } catch { /* ignore */ }
					}
				};
				try {
					await renderTask.promise;
					if (!this.disposed && this.pageCache) {
						await this.pageCache.captureCanvas(targetPage, rotation, scale, canvas);
						if (!this.canvasReady.has(targetPage)) this.showCachedPagePreview(targetPage);
					}
				} catch {
					// Pre-render cancellation or transient failure is non-fatal.
				} finally {
					if (this.activePreRender?.page === targetPage) {
						this.activePreRender = null;
					}
					canvas.width = 0;
					canvas.height = 0;
				}
			}
		} finally {
			this.preRendering = false;
		}
	}

	private textRendered(page: number): void {
		const view = this.pageView(page);
		if (!view || this.disposed) return;
		view.textLayer?.div.classList.add('reader-pdf-text');
		this.abortEnhancements(page);
		this.textReady.add(page);
		this.paintReady.add(page);
		const box = this.pageBox(page);
		if (box) this.layers.paintPage(box);
		for (const enhancer of this.enhancers.keys()) this.enhance(enhancer, page);
	}

	private enhance(enhancer: PageEnhancer, page: number): void {
		const view = this.pageView(page);
		const box = this.pageBox(page);
		const runs = this.enhancers.get(enhancer);
		if (!view?.pdfPage || !box || !runs || this.disposed) return;
		const controller = new AbortController();
		const overlay = document.createElement('div');
		overlay.className = 'reader-pdf-enhancement';
		overlay.dataset.page = String(page);
		placeLayer(overlay, box, ENHANCER_Z);
		view.div.append(overlay);
		const run = { controller, overlay };
		runs.set(page, run);
		const textLayer = view.textLayer?.div ?? null;
		const pdfPage = view.pdfPage;
		const textChars = (textLayer?.textContent ?? '').replace(/\s/g, '').length;
		void (async () => {
			// Skip expensive getOperatorList() worker round-trip when page already has selectable text.
			const hasImages = textChars >= 20 ? false : await this.hasImages(pdfPage);
			if (controller.signal.aborted) return;
			await enhancer({
				page,
				pdfPage,
				pageDiv: view.div,
				textLayer,
				textChars,
				hasImages,
				rotation: box.rotation,
				overlay,
				signal: controller.signal
			});
		})().catch((error: unknown) => {
			if (!controller.signal.aborted) console.error('A PDF page enhancer failed', error);
		});
	}

	private abortEnhancements(page: number, overlay?: HTMLElement): void {
		for (const runs of this.enhancers.values()) {
			const run = runs.get(page);
			if (!run || (overlay && run.overlay !== overlay)) continue;
			runs.delete(page);
			this.endEnhancement(run);
		}
		if (!overlay) this.textReady.delete(page);
	}

	private endEnhancement(run: Enhancement): void {
		run.controller.abort();
		run.overlay.remove();
	}

	private hasImages(page: PDFPageProxy): Promise<boolean> {
		let result = this.pageImages.get(page.pageNumber);
		if (!result) {
			const pdfjs = this.pdfjs!;
			result = page.getOperatorList().then((operators) => {
				const images = new Set<number>(IMAGE_OPS.map((name) => pdfjs.OPS[name]));
				return operators.fnArray.some((op) => images.has(op));
			});
			result.catch(() => this.pageImages.delete(page.pageNumber));
			this.pageImages.set(page.pageNumber, result);
		}
		return result;
	}

	private captureSelection(): void {
		const selection = document.getSelection();
		if (this.selectionCapture) {
			if (selection) this.selectionCapture(selection);
			return;
		}
		if (!selection || selection.isCollapsed || !selection.rangeCount || !this.document) {
			this.events.selection(null);
			return;
		}
		const range = selection.getRangeAt(0);
		const start = range.startContainer.parentElement?.closest<HTMLElement>('.page[data-page-number]');
		const end = range.endContainer.parentElement?.closest<HTMLElement>('.page[data-page-number]') ?? start;
		const target = range.commonAncestorContainer instanceof Element
			? range.commonAncestorContainer.closest<HTMLElement>('.page[data-page-number]')
			: range.commonAncestorContainer.parentElement?.closest<HTMLElement>('.page[data-page-number]');
		const div = target ?? (start === end ? start : null);
		if (!div || !this.viewport.contains(div)) {
			this.events.selection(null);
			return;
		}
		const page = Number(div.dataset.pageNumber);
		const rects: NormalizedRect[] = selectionRects(range, div, normalizeRotation(this.viewer?.pagesRotation ?? 0));
		const text = selection.toString();
		if (!text.trim() || !rects.length || rects.length > MAX_RECTS) {
			this.events.selection(null);
			return;
		}
		this.events.selection({
			text,
			fraction: toFraction(page, 0, this.document.numPages),
			locator: { type: 'pdf', page, rects }
		});
	}
}
