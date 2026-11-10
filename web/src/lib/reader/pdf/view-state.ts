import type { ReaderSettings } from '../types.js';
import type { PdfLayout, PdfRotation, PdfViewState, PdfZoom } from './types.js';

export interface PdfViewConfig {
	layout: PdfLayout;
	zoom: PdfZoom;
	rotation: PdfRotation;
}

export const DEFAULT_PDF_VIEW: PdfViewConfig = { layout: 'single-continuous', zoom: 'auto', rotation: 0 };

/**
 * The view fields of already merged reader settings (book over format over defaults, see
 * `loadReaderSettings`). Settings keys stay camelCase for compatibility with stored values.
 */
export function readPdfViewState(settings: Partial<ReaderSettings>): PdfViewConfig {
	return {
		layout: settings.pdfLayout ?? DEFAULT_PDF_VIEW.layout,
		zoom: settings.pdfZoom ?? DEFAULT_PDF_VIEW.zoom,
		rotation: settings.pdfRotation ?? DEFAULT_PDF_VIEW.rotation
	};
}

export type PdfViewSettings = Required<Pick<ReaderSettings, 'pdfLayout' | 'pdfZoom' | 'pdfRotation'>>;

/** The persisted part of the engine state, in ReaderSettings field names. */
export function pdfViewStatePatch(state: Pick<PdfViewState, 'layout' | 'zoom' | 'rotation'>): PdfViewSettings {
	return { pdfLayout: state.layout, pdfZoom: state.zoom, pdfRotation: state.rotation };
}
