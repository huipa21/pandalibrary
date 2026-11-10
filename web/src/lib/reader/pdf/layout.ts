import type { PdfLayout } from './types.js';

/** pdf.js `ScrollMode` / `SpreadMode` values used by the four page displays. */
export const SCROLL_VERTICAL = 0;
export const SCROLL_PAGE = 3;
export const SPREAD_NONE = 0;
export const SPREAD_ODD = 1;

export function layoutModes(layout: PdfLayout): { scrollMode: number; spreadMode: number } {
	const split = layout === 'split' || layout === 'split-continuous';
	return {
		scrollMode: layout.endsWith('continuous') ? SCROLL_VERTICAL : SCROLL_PAGE,
		spreadMode: split ? SPREAD_ODD : SPREAD_NONE
	};
}

export function layoutFromModes(scrollMode: number, spreadMode: number): { layout: PdfLayout } {
	const continuous = scrollMode !== SCROLL_PAGE;
	const split = spreadMode === SPREAD_ODD;
	return {
		layout: split ? (continuous ? 'split-continuous' : 'split') : (continuous ? 'single-continuous' : 'single')
	};
}

export function isContinuous(layout: PdfLayout): boolean {
	return layout === 'single-continuous' || layout === 'split-continuous';
}

/** First page of the spread that contains `page`. */
export function spreadStart(page: number, layout: PdfLayout): number {
	if (layout === 'single' || layout === 'single-continuous') return page;
	return page - (page % 2 === 0 ? 1 : 0);
}
