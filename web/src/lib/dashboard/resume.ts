import type { Book, BookFile } from '#lib/catalog/types.js';
import { getBookState } from '#lib/reader/api.js';
import { readerFormat, type BookState, type Progress } from '#lib/reader/types.js';
import { currentAccount, offlineAvailable } from '#lib/sync/client.js';
import { AccountChangedError, OfflineStorageError } from '#lib/sync/db.js';
import { withSessionLock } from '#lib/sync/engine.js';
import { readerState } from '#lib/sync/state.js';

export class ResumeFileUnavailableError extends Error {
	constructor() {
		super('The saved reading file is missing or unsupported.');
		this.name = 'ResumeFileUnavailableError';
	}
}

export function savedReadingFile(book: Book, progress: Progress | null): BookFile | null {
	if (!progress || progress.book_file_id === null) return null;
	return book.files.find((file) => file.id === progress.book_file_id && readerFormat(file.format) !== null) ?? null;
}

export async function resumeFile(account: number, book: Book): Promise<BookFile> {
	const durable = offlineAvailable();
	const load = async () => {
		if (currentAccount() !== account) throw new AccountChangedError();
		let online: BookState | undefined;
		if (navigator.onLine) {
			try {
				online = await getBookState(book.id);
			} catch (error) {
				if (!(error instanceof TypeError) || !durable) throw error;
				console.warn('Could not reach reading progress; using synchronized offline data', error);
			}
		} else if (!durable) {
			throw new OfflineStorageError('Offline storage is unavailable.');
		}
		const state = durable
			? (await readerState(account, book.id, online ? { state: online, settings: [] } : undefined)).state
			: online;
		if (currentAccount() !== account) throw new AccountChangedError();
		const file = savedReadingFile(book, state?.progress ?? null);
		if (!file) throw new ResumeFileUnavailableError();
		return file;
	};
	return durable ? withSessionLock(load, true) : load();
}
