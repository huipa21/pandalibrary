import { getContext, setContext } from 'svelte';
import { ApiError } from '#lib/api/client.js';
import * as m from '#lib/paraglide/messages.js';
import { catalogErrorMessage } from '#lib/catalog/errors.js';
import { getBook } from '#lib/catalog/api.js';
import type { Book } from '#lib/catalog/types.js';
import { getSessionViewer } from '#lib/shelves/api.js';
import { isAdministrator } from '#lib/shelves/form.js';
import { currentAccount, offlineAvailable } from '#lib/sync/client.js';
import { downloadedBooks, OfflineStorageError } from '#lib/sync/db.js';
import { loadBook as loadOfflineBook, loadCover } from '#lib/sync/library.js';

// BV10: import from events.ts
const BOOK_STATE_CHANGED = 'pandalibrary-book-state-changed';
const SHELVES_CHANGED = 'pandalibrary-shelves-changed';
const BOOK_CONTEXT_KEY = Symbol('pandalibrary.book-context');

export function parseBookID(raw: string): number | null {
	const id = Number(raw);
	return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

/**
 * Loads one book (online or from the offline store) for the whole tab area.
 * Tabs read it through `getBookContext()` and never fetch the book themselves.
 */
export class BookContext {
	/** The numeric ID from the route, or null when the route ID is invalid. */
	bookId = $state<number | null>(null);
	book = $state<Book | null>(null);
	offline = $state(false);
	coverSource = $state<string | null>(null);
	coverError = $state('');
	canEditMetadata = $state(false);
	/** File IDs of this book saved for offline reading (empty when offline storage is unavailable). */
	savedFileIds = $state<number[]>([]);
	loading = $state(true);
	error = $state('');

	#rawID: string | null = null;
	#requestVersion = 0;
	#objectUrl: string | null = null;

	/** Loads the book for a route ID. Calling it again with the same ID does nothing. */
	load(rawID: string): Promise<void> {
		if (rawID === this.#rawID) return Promise.resolve();
		this.#rawID = rawID;
		return this.#fetch(rawID, false);
	}

	/**
	 * Fetches the current book again. While a loaded book is refreshed it stays
	 * visible; after an error the state starts from scratch like a first load.
	 */
	reload(): Promise<void> {
		const rawID = this.#rawID ?? '';
		this.#rawID = rawID;
		return this.#fetch(rawID, this.book !== null && !this.error);
	}

	/** Reloads on book-state and shelf changes; returns the cleanup function. */
	listen(target: Window = window): () => void {
		const onBookState = (event: Event) => {
			const detail = (event as CustomEvent<{ bookId?: unknown } | null>).detail;
			if (this.bookId !== null && detail?.bookId === this.bookId) void this.reload();
		};
		const onShelves = () => {
			if (this.bookId !== null) void this.reload();
		};
		target.addEventListener(BOOK_STATE_CHANGED, onBookState);
		target.addEventListener(SHELVES_CHANGED, onShelves);
		return () => {
			target.removeEventListener(BOOK_STATE_CHANGED, onBookState);
			target.removeEventListener(SHELVES_CHANGED, onShelves);
		};
	}

	destroy() {
		this.#requestVersion += 1;
		this.#revokeCover();
	}

	#revokeCover() {
		if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
		this.#objectUrl = null;
	}

	#clear() {
		this.#revokeCover();
		this.book = null;
		this.coverSource = null;
		this.coverError = '';
		this.savedFileIds = [];
		this.canEditMetadata = false;
	}

	async #fetch(rawID: string, quiet: boolean) {
		const request = ++this.#requestVersion;
		if (!quiet) this.#clear();
		this.loading = true;
		this.error = '';
		const parsedID = parseBookID(rawID);
		this.bookId = parsedID;
		if (parsedID === null) {
			this.#clear();
			this.error = m['catalog.error.not_found']();
			this.loading = false;
			return;
		}
		try {
			const loaded = offlineAvailable()
				? await loadOfflineBook(currentAccount(), parsedID)
				: { book: await getBook(parsedID), offline: false };
			if (request !== this.#requestVersion) return;
			let coverSource: string | null = null;
			let objectUrl: string | null = null;
			let coverError = '';
			let savedFileIds: number[] = [];
			if (offlineAvailable()) {
				const stored = (await downloadedBooks(currentAccount())).find((item) => item.book.id === parsedID);
				if (request !== this.#requestVersion) return;
				savedFileIds = stored?.fileIds ?? [];
				if (loaded.book.cover_url) {
					try {
						const cover = await loadCover(currentAccount(), loaded.book, loaded.offline);
						if (request !== this.#requestVersion) return;
						if (cover) {
							objectUrl = URL.createObjectURL(cover);
							coverSource = objectUrl;
						}
					} catch (cause) {
						if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) throw cause;
						console.error('Could not load the book cover', cause);
						coverError = m['offline.cover_failure']();
					}
				}
			} else {
				coverSource = loaded.book.cover_url;
			}
			this.#revokeCover();
			this.#objectUrl = objectUrl;
			this.book = loaded.book;
			this.offline = loaded.offline;
			this.coverSource = coverSource;
			this.coverError = coverError;
			this.savedFileIds = savedFileIds;
			if (loaded.offline) {
				this.canEditMetadata = false;
			} else {
				// Only hides the entry point; the edit route and API enforce authorization.
				void getSessionViewer().then(
					(viewer) => {
						if (request === this.#requestVersion) this.canEditMetadata = isAdministrator(viewer);
					},
					() => undefined
				);
			}
		} catch (cause) {
			if (request !== this.#requestVersion) return;
			this.#clear();
			this.error = cause instanceof OfflineStorageError ? m['offline.missing']() : catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			if (request === this.#requestVersion) this.loading = false;
		}
	}
}

export function createBookContext(): BookContext {
	return new BookContext();
}

export function setBookContext(context: BookContext): BookContext {
	return setContext(BOOK_CONTEXT_KEY, context);
}

export function getBookContext(): BookContext {
	const context = getContext<BookContext | undefined>(BOOK_CONTEXT_KEY);
	if (!context) throw new Error('getBookContext() must be called inside the book tab layout.');
	return context;
}
