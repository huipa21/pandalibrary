import { listBooks } from '#lib/catalog/api.js';
import type { Book } from '#lib/catalog/types.js';
import { makeNote, deleteAnnotation } from '#lib/reader/annotations.js';
import { getBookState, pushMutation } from '#lib/reader/api.js';
import type { BookState, Note, Progress } from '#lib/reader/types.js';
import { currentAccount, offlineAvailable } from '#lib/sync/client.js';
import { readerState } from '#lib/sync/state.js';
import { notifyBookStateChanged } from '../events.js';
import { parseDate } from '../format.js';
import { getReadingSummary, type ReadingSummary } from '../log-api.js';
import { userBookFromState, type UserBook } from '../user-book.js';

export interface DetailsState {
	userBook: UserBook | null;
	progress: Progress | null;
	review: Note | null;
	summary: ReadingSummary | null;
}

export interface RelatedBooks {
	byAuthor: Book[];
	similar: Book[];
}

function latestReview(notes: readonly Note[]): Note | null {
	return notes
		.filter((note) => note.highlight_id === null && note.deleted_at === null)
		.sort((left, right) =>
			parseDate(right.updated_at).getTime() - parseDate(left.updated_at).getTime() ||
			parseDate(right.created_at).getTime() - parseDate(left.created_at).getTime() ||
			left.id.localeCompare(right.id)
		)[0] ?? null;
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
	const [state, summary] = await Promise.all([
		loadReaderBookState(bookId, useOffline),
		useOffline ? Promise.resolve(null) : getReadingSummary(bookId, { signal })
	]);
	signal?.throwIfAborted();
	return {
		userBook: userBookFromState(state.user_book),
		progress: state.progress,
		review: latestReview(state.notes),
		summary
	};
}

export async function saveReview(bookId: number, existing: Note | null, body: string): Promise<void> {
	if (!Number.isSafeInteger(bookId) || bookId < 1) throw new RangeError('Invalid book ID.');
	if (body.length > 10_000) throw new RangeError('Review exceeds 10,000 characters.');
	if (existing && (existing.book_id !== bookId || existing.highlight_id !== null || existing.deleted_at !== null)) {
		throw new RangeError('Invalid book review.');
	}
	const mutation = body.trim()
		? makeNote(bookId, body, null, existing?.id)
		: existing ? deleteAnnotation('notes', existing.id) : null;
	if (!mutation) return;
	await pushMutation(mutation);
	notifyBookStateChanged(bookId);
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
