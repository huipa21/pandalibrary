import type { EntryKind, EntrySource, NewEntry, Wordbook } from '#lib/wordbooks/api.js';
import type { ReaderSelection } from './types.js';
import type { PdfSelection } from './pdf/marks/selection.js';
import { toFraction } from './pdf/progress.js';

export interface WordbookUsage {
	lastDestination?: number;
	destinationCounts: Record<string, number>;
}

const WORDBOOK_USAGE_KEY = 'pandalibrary.reader.wordbook-usage';

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export function readWordbookUsage(): WordbookUsage {
	try {
		const stored: unknown = JSON.parse(storage()?.getItem(WORDBOOK_USAGE_KEY) ?? 'null');
		if (typeof stored !== 'object' || stored === null) return { destinationCounts: {} };
		const value = stored as Record<string, unknown>;
		const destinationCounts: Record<string, number> = {};
		if (typeof value.destinationCounts === 'object' && value.destinationCounts !== null) {
			for (const [id, count] of Object.entries(value.destinationCounts)) {
				if (/^[1-9]\d*$/u.test(id) && Number.isSafeInteger(count) && (count as number) > 0) {
					destinationCounts[id] = count as number;
				}
			}
		}
		const last = Number(value.lastDestination);
		return {
			...(Number.isSafeInteger(last) && last > 0 ? { lastDestination: last } : {}),
			destinationCounts
		};
	} catch {
		return { destinationCounts: {} };
	}
}

export function writeWordbookUsage(usage: WordbookUsage): void {
	try {
		storage()?.setItem(WORDBOOK_USAGE_KEY, JSON.stringify(usage));
	} catch {
		// Restricted storage must not prevent adding collected text.
	}
}

export function recordWordbookUsage(usage: WordbookUsage, destination: number): WordbookUsage {
	if (!Number.isSafeInteger(destination) || destination < 1) return usage;
	const key = String(destination);
	return {
		lastDestination: destination,
		destinationCounts: { ...usage.destinationCounts, [key]: (usage.destinationCounts[key] ?? 0) + 1 }
	};
}

/** Last used first, then most frequently used, with the server's default-first order for ties. */
export function orderWordbookDestinations(books: readonly Wordbook[], usage: WordbookUsage): Wordbook[] {
	const positions = new Map(books.map((book, index) => [book.id, index]));
	return [...books].sort((a, b) => {
		if (a.id === usage.lastDestination) return -1;
		if (b.id === usage.lastDestination) return 1;
		const frequency = (usage.destinationCounts[String(b.id)] ?? 0) - (usage.destinationCounts[String(a.id)] ?? 0);
		return frequency || (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0);
	});
}

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
