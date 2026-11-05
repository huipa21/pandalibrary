import { v7 as uuidv7 } from 'uuid';
import type { Mutation } from './api.js';
import {
	isCfiLocator, isLocatorForFormat, isPdfLocator,
	type Bookmark, type ReaderFormat, type ReaderLocator, type Relocation
} from './types.js';

function bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function makeBookmark(
	bookId: number,
	fileId: number,
	location: Relocation,
	label: string,
	id = uuidv7(),
	chapter: string | null = null
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
		id,
		op: 'upsert',
		updated_at: Date.now(),
		data: {
			book_id: bookId,
			book_file_id: fileId,
			locator: location.locator,
			position: location.fraction,
			label,
			chapter
		}
	};
}

export function updateBookmarkLabel(
	bookmark: Bookmark,
	label: string
): Mutation {
	if (bookmark.book_file_id === null ||
		(!isCfiLocator(bookmark.locator) && !isPdfLocator(bookmark.locator))) {
		throw new Error('The bookmarked file or locator is unavailable.');
	}
	return makeBookmark(bookmark.book_id, bookmark.book_file_id, {
		fraction: bookmark.position, locator: bookmark.locator
	}, label, bookmark.id, bookmark.chapter);
}

export function deleteBookmark(id: string): Mutation {
	return { entity: 'bookmarks', id, op: 'delete', data: {}, updated_at: Date.now() };
}

export function bookmarkForPosition(
	bookmark: Bookmark,
	fileId: number,
	format: ReaderFormat
): bookmark is Bookmark & { locator: ReaderLocator } {
	if (bookmark.book_file_id !== fileId || !isLocatorForFormat(bookmark.locator, format)) return false;
	return true;
}

export function bookmarkPositionPercent(bookmark: Bookmark): number | null {
	if (!Number.isFinite(bookmark.position)) return null;
	if (bookmark.position < 0 || bookmark.position > 1) return null;
	return Math.round(bookmark.position * 1000) / 10;
}
