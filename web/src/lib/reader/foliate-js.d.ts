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
		id?: string;
		size?: number;
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
		getProgressOf?(index: number, range: Range): { tocItem?: FoliateTocItem | null };
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

declare module 'foliate-js/vendor/zip.js' {
	export interface ZipEntry {
		filename: string;
		uncompressedSize: number;
		getData<T>(writer: unknown): Promise<T>;
	}

	export class ZipReader {
		constructor(reader: unknown);
		getEntries(): Promise<ZipEntry[]>;
		close(): Promise<void>;
	}

	export class BlobReader {
		constructor(blob: unknown);
	}

	export class TextWriter {
		constructor(encoding?: string);
	}

	export class BlobWriter {
		constructor(type?: string);
	}

	export function configure(options: { useWebWorkers?: boolean }): void;
}

declare module 'foliate-js/vendor/fflate.js' {
	export function unzlibSync(data: Uint8Array): Uint8Array;
}

declare module 'foliate-js/epub.js' {
	import type { FoliateBook } from 'foliate-js/view.js';
	export class EPUB {
		constructor(loader: {
			loadText(name: string): Promise<string | null>;
			loadBlob(name: string, type?: string): Promise<Blob | null>;
			getSize(name: string): number;
		});
		init(): Promise<FoliateBook>;
	}
}

declare module 'foliate-js/comic-book.js' {
	import type { FoliateBook } from 'foliate-js/view.js';
	export function makeComicBook(
		loader: unknown,
		file: { name: string; type: string }
	): Promise<FoliateBook>;
}

declare module 'foliate-js/fb2.js' {
	import type { FoliateBook } from 'foliate-js/view.js';
	export function makeFB2(blob: Blob): Promise<FoliateBook>;
}

declare module 'foliate-js/mobi.js' {
	import type { FoliateBook } from 'foliate-js/view.js';
	export interface MobiFile {
		readonly size: number;
		slice(start: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
	}
	export function isMOBI(file: MobiFile): Promise<boolean>;
	export class MOBI {
		constructor(options: { unzlib(data: Uint8Array): Uint8Array });
		open(file: MobiFile): Promise<FoliateBook>;
	}
}
