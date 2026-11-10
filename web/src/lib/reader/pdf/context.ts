import { getContext, setContext, type Snippet } from 'svelte';
import type { PdfViewerEngine } from './engine.js';
import type { ReaderController } from '../session/reader-controller.svelte.js';
import type { PdfViewState } from './types.js';
import type { HighlightColor } from '../annotations.js';
import type { PdfTool } from './types.js';
import type { PanelAdapter, SidebarState } from './sidebar/sidebar-state.svelte.js';

export type { PdfTool };
export type { SidebarTab } from './sidebar/sidebar-state.svelte.js';

export interface PdfReaderContext {
	readonly engine: PdfViewerEngine;
	readonly controller: ReaderController;
	readonly view: PdfViewState;
	tool: { readonly current: PdfTool; readonly previous: PdfTool; set(tool: PdfTool): void };
	markColor: { readonly current: HighlightColor; set(color: HighlightColor): void };
	readonly offline: boolean;
	readonly bookLanguage: string | null;
	announce(message: string): void;
	/** Left sidebar (RP4): tab rail, panel and reveal targets. */
	sidebar: Omit<SidebarState, 'dispose'>;
	/** Adapter over `sidebar` for the Annotations tab, kept until RP10. */
	panel: PanelAdapter;
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
