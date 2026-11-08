import { listBooks } from '#lib/catalog/api.js';
import type { Book } from '#lib/catalog/types.js';
import { getBookState } from '#lib/reader/api.js';
import type { BookState, Progress } from '#lib/reader/types.js';
import { currentAccount, offlineAvailable } from '#lib/sync/client.js';
import { readerState } from '#lib/sync/state.js';
import { userBookFromState, type UserBook } from '../user-book.js';

export interface DetailsState {
	userBook: UserBook | null;
	progress: Progress | null;
}

export interface RelatedBooks {
	byAuthor: Book[];
	similar: Book[];
}

async function loadReaderBookState(bookId: number, offline: boolean): Promise<BookState> {
	if (offline) return (await readerState(currentAccount(), bookId)).state;
	const state = await getBookState(bookId);
	if (!offlineAvailable()) return state;
	return (await readerState(currentAccount(), bookId, { state, settings: [] })).state;
}

export async function loadDetailsState(
	bookId: number,
	signal?: AbortSignal,
	offline = false
): Promise<DetailsState> {
	if (!Number.isSafeInteger(bookId) || bookId < 1) throw new RangeError('Invalid book ID.');
	signal?.throwIfAborted();
	const useOffline = offline || (typeof navigator !== 'undefined' && navigator.onLine === false);
	const state = await loadReaderBookState(bookId, useOffline);
	signal?.throwIfAborted();
	return {
		userBook: userBookFromState(state.user_book),
		progress: state.progress
	};
}

export async function loadRelated(book: Book, signal?: AbortSignal): Promise<RelatedBooks> {
	signal?.throwIfAborted();
	const author = book.authors.find((item) => item.role === 'author');
	const [authorPage, seriesPage, tagPage] = await Promise.all([
		author ? listBooks({ author_id: author.id }, 'title', { limit: 24 }) : null,
		book.series ? listBooks({ series_id: book.series.id }, 'series', { limit: 24 }) : null,
		book.tags[0] ? listBooks({ tag_id: book.tags[0].id }, 'title', { limit: 24 }) : null
	]);
	signal?.throwIfAborted();
	const byAuthor = (authorPage?.items ?? []).filter((item) => item.id !== book.id).slice(0, 24);
	const series = [...(seriesPage?.items ?? [])].sort((left, right) =>
		(left.series?.index ?? Number.POSITIVE_INFINITY) - (right.series?.index ?? Number.POSITIVE_INFINITY) ||
		left.title.localeCompare(right.title) || left.id - right.id
	);
	const seen = new Set([book.id]);
	const similar: Book[] = [];
	for (const item of [...series, ...(tagPage?.items ?? [])]) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		similar.push(item);
		if (similar.length === 24) break;
	}
	return { byAuthor, similar };
}
