import { isPdfLocator, type Bookmark } from '../../../types.js';

export function bookmarkPage(bookmark: Bookmark): number | null {
	return isPdfLocator(bookmark.locator) ? bookmark.locator.page : null;
}

function bookmarkY(bookmark: Bookmark): number {
	return isPdfLocator(bookmark.locator) ? bookmark.locator.rects?.[0]?.y ?? 0 : 0;
}

export function buildBookmarks(bookmarks: readonly Bookmark[], fileId: number) {
	const current: Bookmark[] = [];
	const other: Bookmark[] = [];
	for (const bookmark of bookmarks) {
		if (bookmark.deleted_at) continue;
		(bookmark.book_file_id === fileId && isPdfLocator(bookmark.locator) ? current : other).push(bookmark);
	}
	const compare = (a: Bookmark, b: Bookmark) =>
		(bookmarkPage(a) ?? Infinity) - (bookmarkPage(b) ?? Infinity) ||
		bookmarkY(a) - bookmarkY(b) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
	return { current: current.sort(compare), other: other.sort(compare) };
}

export function pageBookmark(bookmarks: readonly Bookmark[], fileId: number, page: number): Bookmark | undefined {
	return bookmarks.find((bookmark) => !bookmark.deleted_at && bookmark.book_file_id === fileId &&
		isPdfLocator(bookmark.locator) && bookmark.locator.page === page && bookmark.locator.rects === undefined);
}

type PageTextItem = { str?: string; hasEOL?: boolean; transform?: readonly number[] };

export function defaultPdfBookmarkLabel(selected: string, items: readonly PageTextItem[], fallback: string): string {
	const line: string[] = [];
	let baseline: number | undefined;
	for (const item of items) {
		if (typeof item.str !== 'string') continue;
		const text = item.str.trim();
		const y = item.transform?.[5];
		if (line.length && y !== undefined && baseline !== undefined && Math.abs(y - baseline) > 0.5) break;
		if (text) {
			line.push(text);
			baseline ??= y;
		}
		if (item.hasEOL && line.length) break;
	}
	const text = (selected.trim() || line.join(' ') || fallback).replace(/\s+/gu, ' ').trim();
	const encoder = new TextEncoder();
	let label = '';
	for (const character of Array.from(text).slice(0, 200)) {
		if (encoder.encode(label + character).length > 512) break;
		label += character;
	}
	return label;
}

export function validateBookmarkLabel(value: string):
	{ label: string; error: null } | { label: null; error: 'length' | 'bytes' } {
	const label = value.trim();
	const length = Array.from(label).length;
	if (length < 1 || length > 200) return { label: null, error: 'length' };
	// The sync API caps labels at 512 UTF-8 bytes, independently of character count.
	if (new TextEncoder().encode(label).length > 512) return { label: null, error: 'bytes' };
	return { label, error: null };
}
