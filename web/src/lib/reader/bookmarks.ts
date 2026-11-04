import { v7 as uuidv7 } from 'uuid';
import type { Mutation } from './api.js';
import { isLocatorForFormat, type Bookmark, type ReaderFormat, type Relocation } from './types.js';

function bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function makeBookmark(
	bookId: number,
	fileId: number,
	location: Relocation,
	label: string,
	existing?: Bookmark
): Mutation {
	if (
		!Number.isFinite(location.fraction) ||
		location.fraction < 0 ||
		location.fraction > 1 ||
		bytes(JSON.stringify(location.locator)) > 16 * 1024 ||
		bytes(label) > 512
	) {
		throw new Error('Bookmark exceeds the server limits.');
	}
	return {
		entity: 'bookmarks',
		id: existing?.id ?? uuidv7(),
		op: 'upsert',
		updated_at: Date.now(),
		data: {
			book_id: bookId,
			book_file_id: fileId,
			locator: location.locator,
			position: location.fraction,
			label,
			chapter: existing?.chapter ?? null
		}
	};
}

export function updateBookmarkLabel(
	bookmarkId: string,
	bookId: number,
	fileId: number,
	location: Relocation,
	label: string,
	existing: Bookmark
): Mutation {
	return makeBookmark(bookId, fileId, location, label, { ...existing, id: bookmarkId });
}

export function deleteBookmark(id: string): Mutation {
	return { entity: 'bookmarks', id, op: 'delete', data: {}, updated_at: Date.now() };
}

export function bookmarkForPosition(
	bookmark: Bookmark,
	fileId: number,
	format: ReaderFormat
): boolean {
	if (bookmark.book_file_id !== fileId || !isLocatorForFormat(bookmark.locator, format)) return false;
	return true;
}

export function bookmarkPositionPercent(bookmark: Bookmark): number | null {
	if (!Number.isFinite(bookmark.position)) return null;
	if (bookmark.position < 0 || bookmark.position > 1) return null;
	return Math.round(bookmark.position * 1000) / 10;
}
