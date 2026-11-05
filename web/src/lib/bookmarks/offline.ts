import { downloadedBooks, outbox, rows } from '#lib/sync/db.js';
import { replayMutations } from '#lib/sync/state.js';
import type { Bookmark } from '#lib/reader/types.js';
import type { BookmarkItem } from './api.js';

export async function localBookmarks(account: number): Promise<BookmarkItem[]> {
	const [saved, queued, downloads] = await Promise.all([rows(account), outbox(account), downloadedBooks(account)]);
	const bookmarks = saved.flatMap((row) => row.entity === 'bookmarks' && !row.value.deleted_at ? [row.value] : []);
	const bookIDs = new Set(bookmarks.map((item) => item.book_id));
	for (const { mutation } of queued) {
		if (mutation.entity === 'bookmarks' && mutation.op === 'upsert' &&
			typeof mutation.data.book_id === 'number' && Number.isSafeInteger(mutation.data.book_id) &&
			mutation.data.book_id > 0) bookIDs.add(mutation.data.book_id);
	}
	const result: BookmarkItem[] = [];
	for (const bookID of bookIDs) {
		const base: Bookmark[] = bookmarks.filter((item) => item.book_id === bookID);
		const state = replayMutations(bookID, {
			user_book: null, progress: null, highlights: [], bookmarks: base, notes: []
		}, [], queued).state;
		const download = downloads.find((item) => item.book.id === bookID);
		for (const bookmark of state.bookmarks) {
			result.push({
				...bookmark,
				book: download ? { id: bookID, title: download.book.title, cover_url: null } : null,
				availableOffline: bookmark.book_file_id !== null && (download?.fileIds.includes(bookmark.book_file_id) ?? false)
			});
		}
	}
	return result.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}
