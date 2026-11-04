import type { Bookmark } from '#lib/reader/types.js';

export type BookmarkWithBook = Bookmark & {
	book_title?: string;
	cover_url?: string | null;
};
