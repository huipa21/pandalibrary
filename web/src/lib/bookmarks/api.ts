import { api } from '#lib/api/client.js';
import type { Bookmark } from '#lib/reader/types.js';

export interface BookmarksListResponse {
	items: BookmarkItem[];
	next_cursor: string | null;
}

export interface BookmarkItem extends Bookmark {
	book: BookmarkBookSummary | null;
	availableOffline?: boolean;
}

export interface BookmarkBookSummary {
	id: number;
	title: string;
	cover_url: string | null;
}

export const MAX_BOOKMARK_LABEL_CHARS = 512;

function labelCharCount(value: string): number {
	return new TextEncoder().encode(value).length;
}

export type BookmarkLabelIssue = 'too_long';

export function bookmarkLabelIssue(label: string): BookmarkLabelIssue | null {
	if (labelCharCount(label) > MAX_BOOKMARK_LABEL_CHARS) return 'too_long';
	return null;
}

export async function listBookmarks(
	limit = 20,
	cursor?: string,
	bookId?: number,
	signal?: AbortSignal
): Promise<BookmarksListResponse> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
		(bookId !== undefined && (!Number.isSafeInteger(bookId) || bookId < 1))) {
		throw new RangeError('Invalid bookmark page options.');
	}
	const params = new URLSearchParams();
	params.set('limit', limit.toString());
	if (cursor) params.set('cursor', cursor);
	if (bookId !== undefined) params.set('book_id', bookId.toString());
	return api.request<BookmarksListResponse>(`/me/bookmarks?${params}`, { signal });
}

export function bookmarkPositionPercent(position: number): number | null {
	if (!Number.isFinite(position)) return null;
	if (position < 0 || position > 1) return null;
	return Math.round(position * 1000) / 10;
}
