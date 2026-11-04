import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { highlightColor } from './annotations.js';
import { fraction } from './progress.js';
import {
	isPdfLocator,
	type NormalizedRect,
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

const COLOR_VALUES = {
	yellow: '#facc15',
	green: '#4ade80',
	blue: '#60a5fa',
	pink: '#f472b6'
};

export class PdfReader implements Reader {
	private document: PDFDocumentProxy | null = null;
	private loadingTask: PDFDocumentLoadingTask | null = null;
	private renderTask: RenderTask | null = null;
	private textLayer: { cancel(): void } | null = null;
	private page = 1;
	private generation = 0;
	private settings: ReaderSettings = { font: 'serif', size: 100, spacing: 1.5, theme: 'light', flow: 'paginated' };
	private annotations = new Map<string, ReaderAnnotation>();
	private pageElement: HTMLElement | null = null;
	private highlightsElement: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private width = 0;
	private disposed = false;
	private readonly listeners = new AbortController();

	constructor(private readonly container: HTMLElement, private readonly events: ReaderEvents) {}

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
		this.resizeObserver = new ResizeObserver(() => {
			const width = this.container.clientWidth;
			if (width && this.width && Math.abs(width - this.width) > 1) {
				void this.render().catch(this.events.error);
			}
			this.width = width;
		});
		this.resizeObserver.observe(this.container);
	}

	async goTo(target: ReaderLocator | number): Promise<void> {
		const doc = this.requireDocument();
		if (typeof target === 'number') {
			this.page = Math.min(doc.numPages, Math.max(1, Math.floor(fraction(target) * doc.numPages) + 1));
		} else {
			if (!isPdfLocator(target) || target.page > doc.numPages) throw new Error('PDF locator is unavailable.');
			this.page = target.page;
		}
		await this.render();
	}

	async previous(): Promise<void> {
		if (this.page > 1) {
			this.page -= 1;
			await this.render();
		}
	}

	async next(): Promise<void> {
		if (this.page < this.requireDocument().numPages) {
			this.page += 1;
			await this.render();
		}
	}

	async applySettings(settings: ReaderSettings): Promise<void> {
		this.settings = { ...settings };
		if (this.pageElement) await this.render();
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
		this.renderTask?.cancel();
		this.textLayer?.cancel();
		await this.loadingTask?.destroy();
		this.document = null;
		this.container.replaceChildren();
		this.container.classList.remove('reader-pdf');
	}

	private requireDocument(): PDFDocumentProxy {
		if (!this.document) throw new Error('The PDF reader is not open.');
		return this.document;
	}

	private async render(): Promise<void> {
		const generation = ++this.generation;
		this.renderTask?.cancel();
		this.textLayer?.cancel();
		this.events.selection(null);
		const document = this.requireDocument();
		const page = await document.getPage(this.page);
		if (generation !== this.generation || this.disposed) return;
		const pdfjs = await import('pdfjs-dist');
		if (generation !== this.generation || this.disposed) return;
		const natural = page.getViewport({ scale: 1 });
		const fit = Math.max(0.1, (this.container.clientWidth || natural.width) / natural.width);
		const scale = fit * this.settings.size / 100;
		const viewport = page.getViewport({ scale });
		const outputScale = Math.min(window.devicePixelRatio || 1, 2);
		const wrapper = window.document.createElement('div');
		wrapper.className = 'reader-pdf-page';
		wrapper.dataset.theme = this.settings.theme;
		wrapper.style.width = `${viewport.width}px`;
		wrapper.style.height = `${viewport.height}px`;
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
		this.container.replaceChildren(wrapper);
		this.pageElement = wrapper;
		this.highlightsElement = highlights;
		this.paintAnnotations();
		const renderTask = page.render({
			canvas,
			canvasContext: context,
			viewport,
			transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
		});
		this.renderTask = renderTask;
		try {
			await renderTask.promise;
		} catch (error) {
			if (error instanceof pdfjs.RenderingCancelledException) return;
			throw error;
		}
		if (generation !== this.generation || this.disposed) return;
		const textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
		this.textLayer = textLayer;
		try {
			await textLayer.render();
		} catch (error) {
			if (error instanceof pdfjs.AbortException) return;
			throw error;
		}
		if (generation !== this.generation || this.disposed) return;
		this.events.relocate({
			fraction: document.numPages === 1 ? 0 : (this.page - 1) / (document.numPages - 1),
			locator: { type: 'pdf', page: this.page }
		});
	}

	private captureSelection(): void {
		const selection = document.getSelection();
		const page = this.pageElement;
		if (!selection || selection.isCollapsed || !selection.rangeCount || !page) {
			this.events.selection(null);
			return;
		}
		const range = selection.getRangeAt(0);
		if (!page.contains(range.commonAncestorContainer)) {
			this.events.selection(null);
			return;
		}
		const bounds = page.getBoundingClientRect();
		const rects: NormalizedRect[] = [];
		for (const rect of Array.from(range.getClientRects())) {
			const left = Math.max(0, rect.left - bounds.left);
			const top = Math.max(0, rect.top - bounds.top);
			const right = Math.min(bounds.width, rect.right - bounds.left);
			const bottom = Math.min(bounds.height, rect.bottom - bounds.top);
			if (right > left && bottom > top) {
				rects.push({ x: left / bounds.width, y: top / bounds.height, width: (right - left) / bounds.width, height: (bottom - top) / bounds.height });
			}
		}
		const text = selection.toString();
		if (!text.trim() || !rects.length || rects.length > 200) {
			this.events.selection(null);
			return;
		}
		this.events.selection({
			text,
			fraction: this.requireDocument().numPages === 1 ? 0 : (this.page - 1) / (this.requireDocument().numPages - 1),
			locator: { type: 'pdf', page: this.page, rects }
		});
	}

	private paintAnnotations(): void {
		const layer = this.highlightsElement;
		if (!layer) return;
		layer.replaceChildren();
		for (const annotation of this.annotations.values()) {
			if (!isPdfLocator(annotation.locator) || annotation.locator.page !== this.page) continue;
			for (const rect of annotation.locator.rects ?? []) {
				const mark = document.createElement('span');
				mark.className = 'reader-pdf-highlight';
				mark.dataset.annotationId = annotation.id;
				mark.style.left = `${rect.x * 100}%`;
				mark.style.top = `${rect.y * 100}%`;
				mark.style.width = `${rect.width * 100}%`;
				mark.style.height = `${rect.height * 100}%`;
				mark.style.backgroundColor = COLOR_VALUES[highlightColor(annotation.color)];
				layer.append(mark);
			}
		}
	}
}
