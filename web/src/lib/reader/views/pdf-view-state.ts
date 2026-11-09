import type { ReaderSettings } from '#lib/reader/types.js';
import type { PdfTool, PdfViewState } from '#lib/reader/pdf/types.js';
import { pdfViewStatePatch } from '#lib/reader/pdf/view-state.js';

export type { PdfTool };
export const PDF_TOOL_KEY = 'pandalibrary.pdf-tool';

/** The persisted part of the engine view state, in ReaderSettings field names. */
export const viewSettings = pdfViewStatePatch;

export function viewSettingsChanged(settings: ReaderSettings, state: PdfViewState): boolean {
	const next = viewSettings(state);
	return (Object.keys(next) as (keyof typeof next)[]).some((key) => settings[key] !== next[key]);
}

export function storedTool(value: string | null): 'select' | 'hand' {
	return value === 'hand' ? 'hand' : 'select';
}

/** V/H/I tool shortcuts; null when the key is not a tool key or focus is in an editable field. */
export function toolShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>, target: EventTarget | null): PdfTool | null {
	if (event.ctrlKey || event.metaKey || event.altKey) return null;
	if (typeof Element !== 'undefined' && target instanceof Element && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return null;
	switch (event.key.toLowerCase()) {
		case 'v': return 'select';
		case 'h': return 'hand';
		case 'i': return 'insert';
		default: return null;
	}
}
