import type { FoliateBook, FoliateResolved, View } from 'foliate-js/view.js';
import { HIGHLIGHT_HEX, highlightColor } from './annotations.js';
import { fraction } from './progress.js';
import { captureBookBlobs, isolateBookSections } from './safe-content.js';
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
	annotation: { value: string; color: string };
	draw: (shape: typeof import('foliate-js/overlayer.js').Overlayer.highlight, options: { color: string }) => void;
}

export class FoliateReader implements Reader {
	private view: View | null = null;
	private book: FoliateBook | null = null;
	private annotations = new Map<string, ReaderAnnotation>();
	private documents = new Map<number, Document>();
	private location: Relocation | null = null;
	private lastLoadError: unknown = null;
	private disposed = false;
	private readonly listeners = new AbortController();

	constructor(
		private readonly container: HTMLElement,
		private readonly format: ReflowableFormat,
		private readonly events: ReaderEvents
	) {}

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
			this.documents.set(index, doc);
			const captureSelection = () => this.captureSelection(doc, index);
			doc.addEventListener('selectionchange', captureSelection, { signal: this.listeners.signal });
			doc.addEventListener('mouseup', captureSelection, { signal: this.listeners.signal });
			doc.addEventListener('keyup', captureSelection, { signal: this.listeners.signal });
			doc.addEventListener('keydown', this.events.keyboard, { signal: this.listeners.signal });
			for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
				doc.addEventListener(name, this.events.activity, { signal: this.listeners.signal, passive: true });
			}
			if (view.isFixedLayout) this.paintFixedPage(index, doc);
		});
		view.addEventListener('create-overlay', () => {
			queueMicrotask(() => {
				for (const annotation of this.annotations.values()) {
					void this.drawAnnotation(annotation).catch(this.events.error);
				}
			});
		});
		view.addEventListener('draw-annotation', (event) => {
			const { draw, annotation } = (event as CustomEvent<DrawAnnotation>).detail;
			draw(Overlayer.highlight, { color: HIGHLIGHT_HEX[highlightColor(annotation.color)] });
		});
		this.container.replaceChildren(view);
		await view.open(book);
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
		view.renderer.setAttribute('flow', settings.flow);
		if (view.isFixedLayout) {
			view.renderer.setAttribute('zoom', settings.size === 100 ? 'fit-page' : String(settings.size / 100));
			return;
		}
		const themes = {
			light: { background: '#ffffff', foreground: '#172033' },
			sepia: { background: '#f5ecd9', foreground: '#433422' },
			dark: { background: '#171b22', foreground: '#e5e7eb' }
		};
		const theme = themes[settings.theme];
		const fonts = { serif: 'serif', 'sans-serif': 'sans-serif', system: 'system-ui' };
		view.renderer.setStyles?.(`
			html, body { background: ${theme.background} !important; color: ${theme.foreground} !important; }
			body { font-family: ${fonts[settings.font]} !important; font-size: ${settings.size}% !important; }
			p, li, blockquote, dd { line-height: ${settings.spacing} !important; }
		`);
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

	async destroy(): Promise<void> {
		this.disposed = true;
		this.listeners.abort();
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
		if (!this.view) throw new Error('The reader is not open.');
		return this.view;
	}

	private isValidResolved(value: FoliateResolved | undefined): value is FoliateResolved {
		return !!value && Number.isInteger(value.index) && value.index >= 0 &&
			value.index < (this.book?.sections.length ?? 0);
	}

	private captureSelection(doc: Document, index: number): void {
		const selection = doc.getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount) {
			this.events.selection(null);
			return;
		}
		const range = selection.getRangeAt(0);
		const text = selection.toString();
		if (!text.trim()) {
			this.events.selection(null);
			return;
		}
		try {
			const value = this.requireView().getCFI(index, range);
			this.events.selection({
				text,
				fraction: this.location?.fraction ?? 0,
				locator: { type: 'cfi', value }
			});
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
			await view.addAnnotation({ value: annotation.locator.value, color: annotation.color });
		}
	}

	private paintFixedPage(index: number, doc: Document): void {
		const view = this.requireView();
		const match = Array.from(this.annotations.values()).find((annotation) => {
			if (!isCfiLocator(annotation.locator)) return false;
			return view.resolveNavigation(annotation.locator.value)?.index === index;
		});
		doc.documentElement.style.outline = match
			? `4px solid ${HIGHLIGHT_HEX[highlightColor(match.color)]}`
			: '';
		doc.documentElement.style.outlineOffset = '-4px';
	}
}
