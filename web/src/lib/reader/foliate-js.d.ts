declare module 'foliate-js/view.js' {
	export interface FoliateSection {
		load?(): string | Promise<string>;
		unload?(): void;
		linear?: string;
	}

	export interface FoliateBook {
		sections: FoliateSection[];
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
		addAnnotation(annotation: { value: string; color: string }): Promise<unknown>;
		deleteAnnotation(annotation: { value: string; color: string }): Promise<unknown>;
	}

	export function makeBook(file: File): Promise<FoliateBook>;
}

declare module 'foliate-js/overlayer.js' {
	export class Overlayer {
		static highlight(rects: DOMRect[], options: { color: string }): SVGElement;
	}
}
