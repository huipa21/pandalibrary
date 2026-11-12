import type { PdfLayout, PdfZoom, ReaderSettings } from './types.js';

export const REFLOW_PAGE = { width: 720, height: 960 };

export function reflowLayout(settings: ReaderSettings): PdfLayout {
	return settings.reflowLayout ?? (settings.flow === 'scrolled' ? 'single-continuous' : 'single');
}

export function reflowZoom(settings: ReaderSettings, fixed = false): PdfZoom {
	// Older image readers used the typography size as their numeric magnification.
	return settings.reflowZoom ?? (fixed && settings.size !== 100 ? settings.size / 100 : 'auto');
}

export function reflowScale(
	zoom: PdfZoom, layout: PdfLayout, width: number, height: number,
	page = REFLOW_PAGE
): number {
	const columns = layout.startsWith('split') ? 2 : 1;
	const fitWidth = Math.max(1, width) / (page.width * columns);
	const fitPage = Math.min(fitWidth, Math.max(1, height) / page.height);
	if (typeof zoom === 'number') return Math.max(0.1, Math.min(5, zoom));
	if (zoom === 'page-actual') return 1;
	if (zoom === 'page-width') return fitWidth;
	if (zoom === 'page-fit') return fitPage;
	return Math.min(1.25, fitPage);
}

export function stepReflowZoom(scale: number, step: -1 | 1): number {
	return Math.max(0.1, Math.min(5, Math.round((scale + step * 0.1) * 100) / 100));
}
