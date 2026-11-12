declare module 'foliate-js/view.js' {
	export interface FoliateAnnotation {
		id?: string;
		value: string;
		color: string;
		style?: 'highlight' | 'underline' | 'strikeout';
		hasNote?: boolean;
	}

	export interface FoliateTocItem {
		label: string;
		href?: string;
		subitems?: FoliateTocItem[];
	}

	export interface FoliateSection {
		load?(): string | Promise<string>;
		unload?(): void;
		createDocument?(): Document | Promise<Document>;
		linear?: string;
	}

	export interface FoliateSearchMatch {
		cfi: string;
		excerpt: { pre: string; match: string; post: string };
	}

	export type FoliateSearchResult =
		| { progress: number }
		| { label: string; subitems: FoliateSearchMatch[] }
		| FoliateSearchMatch
		| 'done';

	export interface FoliateBook {
		sections: FoliateSection[];
		toc?: FoliateTocItem[];
		rendition?: { layout?: string };
		destroy?(): void;
	}

	export interface FoliateRenderer extends HTMLElement {
		setStyles?(styles: string): void;
		getContents(): Array<{ doc: Document; index?: number }>;
	}

	export interface FoliateResolved {
		index: number;
		anchor?: (document: Document) => Range | Element | null;
	}

	export class View extends HTMLElement {
		book: FoliateBook;
		renderer: FoliateRenderer;
		isFixedLayout: boolean;
		open(book: FoliateBook): Promise<void>;
		close(): void;
		goTo(target: string | number): Promise<FoliateResolved | undefined>;
		goToFraction(fraction: number): Promise<void>;
		prev(): Promise<void>;
		next(): Promise<void>;
		getCFI(index: number, range?: Range): string;
		resolveNavigation(target: string): FoliateResolved | undefined;
		addAnnotation(annotation: FoliateAnnotation): Promise<unknown>;
		deleteAnnotation(annotation: FoliateAnnotation): Promise<unknown>;
		search(options: { query: string }): AsyncGenerator<FoliateSearchResult, void, unknown>;
		clearSearch(): void;
	}

	export function makeBook(file: File): Promise<FoliateBook>;
}

declare module 'foliate-js/overlayer.js' {
	export class Overlayer {
		static highlight(rects: DOMRect[], options: { color: string; writingMode?: string }): SVGElement;
		static underline(rects: DOMRect[], options: { color: string; writingMode?: string }): SVGElement;
		static strikethrough(rects: DOMRect[], options: { color: string; writingMode?: string }): SVGElement;
	}

}

declare module 'foliate-js/epubcfi.js' {
	export function fromRange(range: Range): string;
	export function parse(cfi: string): unknown;
	export function toRange(doc: Document, parts: unknown): Range;
}
