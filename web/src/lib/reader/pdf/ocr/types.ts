import type { PDFPageProxy } from 'pdfjs-dist';
import type { NormalizedRect } from '../../types.js';

export interface OcrWord {
	text: string;
	box: NormalizedRect;
	conf: number;
}

export interface OcrPage {
	lines: { text: string; box: NormalizedRect; words: OcrWord[] }[];
	width: number;
	height: number;
	createdAt: number;
	lastUsedAt: number;
}

// Structural contract until PV2 supplies its exported PageEnhancer type.
export interface OcrPageContext {
	page: number;
	pdfPage: PDFPageProxy;
	pageDiv: HTMLElement;
	textLayer: HTMLElement | null;
	textChars: number;
	hasImages: boolean;
	rotation: 0 | 90 | 180 | 270;
	overlay: HTMLElement;
	signal: AbortSignal;
}

export type OcrEnhancer = (context: OcrPageContext) => Promise<void>;
