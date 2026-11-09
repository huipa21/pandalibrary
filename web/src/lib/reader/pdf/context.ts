import { getContext, setContext, type Snippet } from 'svelte';
import type { PdfViewerEngine } from './engine.js';
import type { ReaderController } from '../session/reader-controller.svelte.js';
import type { PdfViewState } from './types.js';
import type { HighlightColor } from '../annotations.js';
import type { PdfTool } from './types.js';

export type { PdfTool };

export interface PdfReaderContext {
	readonly engine: PdfViewerEngine;
	readonly controller: ReaderController;
	readonly view: PdfViewState;
	tool: { readonly current: PdfTool; readonly previous: PdfTool; set(tool: PdfTool): void };
	markColor: { readonly current: HighlightColor; set(color: HighlightColor): void };
	readonly offline: boolean;
	readonly bookLanguage: string | null;
	announce(message: string): void;
	panel: {
		readonly open: boolean;
		readonly target: { kind: 'mark' | 'bookmark' | 'insert' | 'note'; id: string } | null;
		toggle(): void;
		reveal(kind: 'mark' | 'bookmark' | 'insert' | 'note', id: string): void;
	};
	ocr: { readonly enabled: boolean; set(enabled: boolean): void };
	setToolbarStatus(owner: string, content: Snippet | null): void;
}

const KEY = Symbol('pdf-reader');

export function setPdfReaderContext(context: PdfReaderContext): void {
	setContext(KEY, context);
}

export function getPdfReaderContext(): PdfReaderContext {
	const context = getContext<PdfReaderContext | undefined>(KEY);
	if (!context) throw new Error('PDF reader context is unavailable.');
	return context;
}
