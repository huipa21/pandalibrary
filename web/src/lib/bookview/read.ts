import type { Book } from '#lib/catalog/types.js';
import { resumeFile, ResumeFileUnavailableError } from '#lib/dashboard/resume.js';
import { readerFormat } from '#lib/reader/types.js';
import { sortedFormats } from './cover.js';

export interface ReadTarget {
	bookId: number;
	fileId: number;
}

export async function readTarget(book: Book, account: number): Promise<ReadTarget | null> {
	const firstFormat = sortedFormats(book.files).find((format) => readerFormat(format) !== null);
	if (!firstFormat) return null;
	try {
		const file = await resumeFile(account, book);
		return { bookId: book.id, fileId: file.id };
	} catch (error) {
		if (!(error instanceof ResumeFileUnavailableError)) throw error;
	}
	const file = book.files.find((candidate) => candidate.format.trim().toLowerCase() === firstFormat);
	if (!file) throw new Error('The selected readable file is missing.');
	return { bookId: book.id, fileId: file.id };
}
