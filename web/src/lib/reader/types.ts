import type { JsonValue } from '#lib/api/client.js';

export const FORMATS = ['epub', 'mobi', 'azw3', 'fb2', 'fbz', 'cbz', 'pdf'] as const;
export type ReaderFormat = (typeof FORMATS)[number];
export type ReflowableFormat = Exclude<ReaderFormat, 'pdf'>;

export type CfiLocator = { type: 'cfi'; value: string };
export type NormalizedRect = { x: number; y: number; width: number; height: number };
export type PdfLocator = { type: 'pdf'; page: number; rects?: NormalizedRect[] };
export type ReaderLocator = CfiLocator | PdfLocator;

export interface Relocation {
	fraction: number;
	locator: ReaderLocator;
}

export interface ReaderSelection extends Relocation {
	text: string;
}

export interface ReaderAnnotation {
	id: string;
	locator: ReaderLocator;
	color: string;
}

export interface ReaderSettings {
	font: 'serif' | 'sans-serif' | 'system';
	size: number;
	spacing: number;
	theme: 'light' | 'sepia' | 'dark';
	flow: 'paginated' | 'scrolled';
}

export interface ReaderEvents {
	relocate: (location: Relocation) => void;
	selection: (selection: ReaderSelection | null) => void;
	activity: () => void;
	keyboard: (event: KeyboardEvent) => void;
	error: (error: unknown) => void;
}

export interface Reader {
	open(blob: Blob): Promise<void>;
	goTo(target: ReaderLocator | number): Promise<void>;
	previous(): Promise<void>;
	next(): Promise<void>;
	applySettings(settings: ReaderSettings): Promise<void>;
	addAnnotation(annotation: ReaderAnnotation): Promise<void>;
	removeAnnotation(annotation: ReaderAnnotation): Promise<void>;
	destroy(): Promise<void>;
}

export interface Progress {
	book_file_id: number | null;
	source: string;
	locator: JsonValue;
	percentage: number;
	device: string;
	device_id: string;
	updated_at: string;
	rev: number;
}

export interface Highlight {
	id: string;
	book_id: number;
	book_file_id: number | null;
	locator: JsonValue;
	position: number;
	text: string;
	color: string;
	chapter: string | null;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
	rev: number;
}

export interface Note {
	id: string;
	book_id: number;
	highlight_id: string | null;
	body_md: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
	rev: number;
}

export interface Bookmark {
	id: string;
	book_id: number;
	book_file_id: number | null;
	locator: JsonValue;
	position: number;
	label: string;
	chapter: string | null;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
	rev: number;
}

export interface BookState {
	user_book: unknown;
	progress: Progress | null;
	highlights: Highlight[];
	bookmarks: Bookmark[];
	notes: Note[];
}

export interface Setting {
	key: string;
	value: JsonValue;
	updated_at: string;
	rev: number;
}

export function readerFormat(value: string): ReaderFormat | null {
	const normalized = value.toLowerCase();
	return FORMATS.find((format) => format === normalized) ?? null;
}

export function isCfiLocator(value: JsonValue): value is CfiLocator {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		value.type === 'cfi' &&
		typeof value.value === 'string' &&
		value.value.startsWith('epubcfi(') &&
		value.value.length <= 16000
	);
}

export function isPdfLocator(value: JsonValue): value is PdfLocator {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		value.type !== 'pdf' ||
		typeof value.page !== 'number' ||
		!Number.isSafeInteger(value.page) ||
		value.page < 1
	) return false;
	if (value.rects === undefined) return true;
	return Array.isArray(value.rects) && value.rects.length <= 200 && value.rects.every((rect) => {
		if (typeof rect !== 'object' || rect === null || Array.isArray(rect)) return false;
		const { x, y, width, height } = rect;
		return (
			typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1 &&
			typeof y === 'number' && Number.isFinite(y) && y >= 0 && y <= 1 &&
			typeof width === 'number' && Number.isFinite(width) && width > 0 && x + width <= 1.00001 &&
			typeof height === 'number' && Number.isFinite(height) && height > 0 && y + height <= 1.00001
		);
	});
}

export function isLocatorForFormat(value: JsonValue, format: ReaderFormat): value is ReaderLocator {
	return format === 'pdf' ? isPdfLocator(value) : isCfiLocator(value);
}
