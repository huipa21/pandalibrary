import type { PdfLayout } from './types.js';

/** pdf.js `ScrollMode` / `SpreadMode` values used by the four page displays. */
export const SCROLL_VERTICAL = 0;
export const SCROLL_PAGE = 3;
export const SPREAD_NONE = 0;
export const SPREAD_ODD = 1;
export const SPREAD_EVEN = 2;

export function layoutModes(layout: PdfLayout, coverAlone = false): { scrollMode: number; spreadMode: number } {
	const split = layout === 'split' || layout === 'split-continuous';
	return {
		scrollMode: layout.endsWith('continuous') ? SCROLL_VERTICAL : SCROLL_PAGE,
		spreadMode: !split ? SPREAD_NONE : coverAlone ? SPREAD_EVEN : SPREAD_ODD
	};
}

export function layoutFromModes(scrollMode: number, spreadMode: number): { layout: PdfLayout; coverAlone: boolean } {
	const continuous = scrollMode !== SCROLL_PAGE;
	const split = spreadMode === SPREAD_ODD || spreadMode === SPREAD_EVEN;
	return {
		layout: split ? (continuous ? 'split-continuous' : 'split') : (continuous ? 'single-continuous' : 'single'),
		coverAlone: spreadMode === SPREAD_EVEN
	};
}

export function isContinuous(layout: PdfLayout): boolean {
	return layout === 'single-continuous' || layout === 'split-continuous';
}

/** First page of the spread that contains `page`. */
export function spreadStart(page: number, layout: PdfLayout, coverAlone: boolean): number {
	if (layout === 'single' || layout === 'single-continuous') return page;
	if (coverAlone) return page === 1 ? 1 : page - (page % 2 === 1 ? 1 : 0);
	return page - (page % 2 === 0 ? 1 : 0);
}
