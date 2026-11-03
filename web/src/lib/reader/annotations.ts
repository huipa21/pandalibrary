import { v7 as uuidv7 } from 'uuid';
import type { Mutation } from './api.js';
import { isLocatorForFormat, type Highlight, type ReaderAnnotation, type ReaderFormat, type ReaderSelection } from './types.js';

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export function highlightColor(value: string): HighlightColor {
	return HIGHLIGHT_COLORS.find((color) => color === value) ?? 'yellow';
}

function bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function annotationForReader(
	highlight: Highlight,
	fileId: number,
	format: ReaderFormat
): ReaderAnnotation | null {
	if (highlight.book_file_id !== fileId || !isLocatorForFormat(highlight.locator, format)) return null;
	return { id: highlight.id, locator: highlight.locator, color: highlightColor(highlight.color) };
}

export function makeHighlight(
	bookId: number,
	fileId: number,
	selection: ReaderSelection,
	color: HighlightColor,
	existing?: Highlight
): Mutation {
	if (
		bytes(selection.text) > 32 * 1024 ||
		bytes(JSON.stringify(selection.locator)) > 16 * 1024 ||
		!Number.isFinite(selection.fraction) ||
		selection.fraction < 0 ||
		selection.fraction > 1
	) throw new Error('Highlight exceeds the server limits.');
	return {
		entity: 'highlights',
		id: existing?.id ?? uuidv7(),
		op: 'upsert',
		updated_at: Date.now(),
		data: {
			book_id: bookId,
			book_file_id: fileId,
			locator: selection.locator,
			position: selection.fraction,
			text: selection.text,
			color,
			chapter: existing?.chapter ?? null
		}
	};
}

export function makeNote(bookId: number, body: string, highlightId: string | null, id = uuidv7()): Mutation {
	if (bytes(body) > 64 * 1024) throw new Error('Note exceeds the server limit.');
	return {
		entity: 'notes',
		id,
		op: 'upsert',
		updated_at: Date.now(),
		data: { book_id: bookId, highlight_id: highlightId, body_md: body }
	};
}

export function deleteAnnotation(entity: 'highlights' | 'notes', id: string): Mutation {
	return { entity, id, op: 'delete', data: {}, updated_at: Date.now() };
}
