import type { Book } from '#lib/catalog/types.js';
import { resumeFile, ResumeFileUnavailableError } from '#lib/dashboard/resume.js';
import { readerFormat } from '#lib/reader/types.js';
import { defaultFile, sortedFormats } from './cover.js';

export interface ReadTarget {
	bookId: number;
	fileId: number;
}

/** Opens the file the reader last used, then the admin-chosen default, then the best readable format. */
export async function readTarget(book: Book, account: number): Promise<ReadTarget | null> {
	const firstFormat = sortedFormats(book.files).find((format) => readerFormat(format) !== null);
	if (!firstFormat) return null;
	try {
		const file = await resumeFile(account, book);
		return { bookId: book.id, fileId: file.id };
	} catch (error) {
		if (!(error instanceof ResumeFileUnavailableError)) throw error;
	}
	const preferred = defaultFile(book.files);
	if (preferred && readerFormat(preferred.format) !== null) return { bookId: book.id, fileId: preferred.id };
	const file = book.files.find((candidate) => candidate.format.trim().toLowerCase() === firstFormat);
	if (!file) throw new Error('The selected readable file is missing.');
	return { bookId: book.id, fileId: file.id };
}
