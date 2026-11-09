import type { PDFPageProxy } from 'pdfjs-dist';
import type { JsonValue } from '#lib/api/client.js';
import { isPdfLocator, type NormalizedRect, type PdfLayout, type PdfZoom } from '../types.js';

export type { NormalizedRect, PdfLayout, PdfZoom };
export type PdfRotation = 0 | 90 | 180 | 270;
export type PdfTool = 'select' | 'hand' | 'insert';
export type NormalizedPoint = { x: number; y: number };

export interface PdfViewState {
	page: number;
	pageCount: number;
	fraction: number;
	offset: number;
	zoom: PdfZoom;
	scale: number;
	layout: PdfLayout;
	coverAlone: boolean;
	rotation: PdfRotation;
}

export type PdfViewLocator = { type: 'pdf'; page: number; offset?: number; rects?: NormalizedRect[] };

export function isPdfViewLocator(value: JsonValue): value is PdfViewLocator {
	if (!isPdfLocator(value)) return false;
	const offset = (value as { offset?: JsonValue }).offset;
	return offset === undefined || (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0 && offset < 1);
}

export interface PageLayerContext {
	page: number;
	/** Absolutely positioned div in unrotated page space; the engine rotates it with the page. */
	layer: HTMLElement;
	/** Unrotated page size in CSS px. */
	width: number;
	height: number;
	rotation: PdfRotation;
	/** Percentages of the unrotated page. */
	toCss(rect: NormalizedRect): { left: string; top: string; width: string; height: string };
	fromClient(clientX: number, clientY: number): NormalizedPoint;
}

export interface PageLayerPainter {
	name: string;
	z: number;
	paint(context: PageLayerContext): void;
}

export interface PageEnhancerContext {
	page: number;
	pdfPage: PDFPageProxy;
	pageDiv: HTMLElement;
	textLayer: HTMLElement | null;
	textChars: number;
	hasImages: boolean;
	rotation: PdfRotation;
	/** Enhancer-owned layer in unrotated page space, above the canvas and below painter layers. */
	overlay: HTMLElement;
	/** Aborted when the page is recycled or re-rendered, or the document closes. */
	signal: AbortSignal;
}

export type PageEnhancer = (context: PageEnhancerContext) => void | Promise<void>;
