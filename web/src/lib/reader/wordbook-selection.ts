import type { EntryKind, EntrySource, NewEntry } from '#lib/wordbooks/api.js';
import type { ReaderSelection } from './types.js';
import type { PdfSelection } from './pdf/marks/selection.js';
import { toFraction } from './pdf/progress.js';

export function selectionKind(text: string, paragraphCount = 0): EntryKind {
	const value = text.trim();
	if (paragraphCount > 1 || /\r?\n\s*\r?\n/u.test(value)) return 'passage';
	if (/[.!?。！？](?:["'”’」』）)]*)?(?:\s|$)/u.test(value)) return 'sentence';
	return /\s/u.test(value) ? 'phrase' : 'word';
}

/** Detached from engine state and native ranges before toolbar focus can collapse them. */
export function captureWordbookSelection(selection: ReaderSelection | null): ReaderSelection | null {
	if (!selection?.text.trim()) return null;
	return JSON.parse(JSON.stringify(selection)) as ReaderSelection;
}

export function pdfWordbookSelection(selection: PdfSelection | null, pageCount: number, text?: string): ReaderSelection | null {
	const first = selection?.parts[0];
	if (!selection || !first) return null;
	const locator = {
		type: 'pdf' as const, page: first.page, rects: first.rects,
		...(selection.parts.length > 1 ? { parts: selection.parts } : {})
	};
	return captureWordbookSelection({
		text: text?.trim() ? text : selection.text,
		locator,
		fraction: toFraction(first.page, Math.min(...first.rects.map((rect) => rect.y)), pageCount)
	});
}

export function wordbookEntry(
	selection: ReaderSelection,
	book: { id: number; title: string },
	fileId: number,
	kind: EntryKind = selectionKind(selection.text, selection.paragraphCount),
	chapter: string | undefined = selection.chapter
): NewEntry {
	const chosen = captureWordbookSelection(selection);
	if (!chosen) throw new Error('No selected text.');
	const source: EntrySource = {
		book_id: book.id, book_file_id: fileId, book_title: book.title,
		locator: chosen.locator, fraction: chosen.fraction,
		...(chapter ? { chapter } : {})
	};
	return { kind, text: chosen.text, source };
}
