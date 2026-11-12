import { v7 as uuidv7 } from 'uuid';
import type { Mutation } from './api.js';
import {
	isLocatorForFormat, type Highlight, type HighlightStyle, type Note, type ReaderAnnotation, type ReaderFormat, type ReaderSelection
} from './types.js';

export type { HighlightStyle } from './types.js';
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange', 'purple'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
export const HIGHLIGHT_HEX: Record<HighlightColor, string> = {
	yellow: '#facc15',
	green: '#4ade80',
	blue: '#60a5fa',
	pink: '#f472b6',
	orange: '#fb923c',
	purple: '#a78bfa'
};

export type MarkColor = string;
export const MARK_PRESETS = [
	{ value: 'yellow', name: 'rp3.yellow' },
	{ value: 'orange', name: 'rp3.orange' },
	{ value: '#f87171', name: 'rp3.red' },
	{ value: 'pink', name: 'rp3.pink' },
	{ value: 'purple', name: 'rp3.purple' },
	{ value: 'blue', name: 'rp3.blue' },
	{ value: '#22d3ee', name: 'rp3.cyan' },
	{ value: 'green', name: 'rp3.green' },
	{ value: '#a3e635', name: 'rp3.lime' },
	{ value: '#2dd4bf', name: 'rp3.teal' },
	{ value: '#818cf8', name: 'rp3.indigo' },
	{ value: '#fda4af', name: 'rp3.rose' },
	{ value: '#a16207', name: 'rp3.brown' },
	{ value: '#9ca3af', name: 'rp3.gray' },
	{ value: '#4b5563', name: 'rp3.slate' },
	{ value: '#000000', name: 'rp3.black' }
] as const;

const HEX_COLOR = /^#[\da-f]{6}$/i;

export function isMarkColor(value: unknown): value is MarkColor {
	return typeof value === 'string' &&
		(HEX_COLOR.test(value) || HIGHLIGHT_COLORS.some((color) => color === value));
}

export function isHighlightStyle(value: unknown): value is HighlightStyle {
	return value === 'highlight' || value === 'underline' || value === 'strikeout';
}

export function highlightColor(value: string): MarkColor {
	return isMarkColor(value) ? value.toLowerCase() : 'yellow';
}

export function resolveMarkColor(value: string): string {
	const color = highlightColor(value);
	const named = HIGHLIGHT_COLORS.find((candidate) => candidate === color);
	return named ? HIGHLIGHT_HEX[named] : color;
}

export function markInk(hex: string, tone: 'light' | 'dark'): string {
	const color = resolveMarkColor(hex);
	if (tone !== 'dark') return color;
	const channels = [1, 3, 5].map((offset) => {
		const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
	return luminance < 0.2 ? '#e5e7eb' : color;
}

function bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function annotationForReader(
	highlight: Highlight,
	fileId: number,
	format: ReaderFormat,
	notes: readonly Note[] = []
): ReaderAnnotation | null {
	if (highlight.book_file_id !== fileId || !isLocatorForFormat(highlight.locator, format)) return null;
	return {
		id: highlight.id, locator: highlight.locator, color: highlight.color,
		style: highlight.style ?? 'highlight',
		hasNote: notes.some((note) => note.highlight_id === highlight.id && !note.deleted_at && !!note.body_md.trim())
	};
}

export function makeHighlight(
	bookId: number,
	fileId: number,
	selection: ReaderSelection,
	color: MarkColor,
	existing?: Highlight,
	style: HighlightStyle = existing?.style ?? 'highlight'
): Mutation {
	if (!isMarkColor(color)) throw new Error('Invalid highlight color.');
	if (
		bytes(selection.text) > 32 * 1024 ||
		bytes(JSON.stringify(selection.locator)) > 16 * 1024 ||
		!isHighlightStyle(style) ||
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
			color: color.toLowerCase(),
			style,
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
