import { ApiError } from '#lib/api/client.js';
import type { Book, BookFile, Library, Page } from '#lib/catalog/types.js';

/** Larger PDFs are reported as failures rather than loaded into memory. */
export const MAX_PDF_BYTES = 256 * 1024 * 1024;

export type PdfCoverOutcome = 'generated' | 'skipped' | 'failed';
export type PdfCoverReason =
	| 'has_cover'
	| 'no_pdf'
	| 'not_found'
	| 'check'
	| 'too_large'
	| 'download'
	| 'render'
	| 'upload';

export interface PdfCoverResult {
	readonly bookId: number;
	readonly title: string;
	readonly outcome: PdfCoverOutcome;
	readonly reason?: PdfCoverReason;
}

export interface PdfCoverProgress {
	scanned: number;
	eligible: number;
	generated: number;
	skipped: number;
	failed: number;
	current: { readonly bookId: number; readonly title: string } | null;
}

export interface PdfCoverSummary extends PdfCoverProgress {
	readonly cancelled: boolean;
}

export interface PdfCoverDeps {
	listLibraries(cursor: string | null): Promise<Page<Library>>;
	listBooks(libraryId: number, cursor: string | null): Promise<Page<Book>>;
	getBook(id: number): Promise<Book>;
	download(book: Book, file: BookFile): Promise<Blob>;
	render(pdf: Blob): Promise<Blob>;
	upload(bookId: number, image: Blob): Promise<void>;
}

export interface PdfCoverRunOptions {
	readonly signal?: AbortSignal;
	onProgress?(progress: Readonly<PdfCoverProgress>): void;
	onResult?(result: PdfCoverResult): void;
}

export class RepeatedCursorError extends Error {
	constructor() {
		super('The catalog returned a repeated pagination cursor.');
		this.name = 'RepeatedCursorError';
	}
}

export function pdfFile(book: Book): BookFile | undefined {
	return book.files.find((file) => file.format.toLowerCase() === 'pdf');
}

export function needsPdfCover(book: Book): boolean {
	return book.cover_url === null && pdfFile(book) !== undefined;
}

/** Walks server cursors page by page without holding more than one page in memory. */
async function* pages<T>(
	load: (cursor: string | null) => Promise<Page<T>>,
	signal?: AbortSignal
): AsyncGenerator<T[]> {
	const seen = new Set<string>();
	let cursor: string | null = null;
	do {
		if (signal?.aborted) return;
		const page = await load(cursor);
		yield page.items;
		cursor = page.next_cursor;
		if (cursor !== null) {
			if (seen.has(cursor)) throw new RepeatedCursorError();
			seen.add(cursor);
		}
	} while (cursor !== null);
}

function missing(error: unknown): boolean {
	return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

async function processBook(deps: PdfCoverDeps, listed: Book): Promise<PdfCoverResult> {
	const base = { bookId: listed.id, title: listed.title };
	const recheck = async (): Promise<PdfCoverResult | Book> => {
		try {
			const fresh = await deps.getBook(listed.id);
			if (fresh.cover_url !== null) return { ...base, outcome: 'skipped', reason: 'has_cover' };
			if (!pdfFile(fresh)) return { ...base, outcome: 'skipped', reason: 'no_pdf' };
			return fresh;
		} catch (error) {
			if (missing(error)) return { ...base, outcome: 'skipped', reason: 'not_found' };
			throw error;
		}
	};
	const isResult = (value: PdfCoverResult | Book): value is PdfCoverResult => 'outcome' in value;

	let current: PdfCoverResult | Book;
	try {
		current = await recheck();
	} catch {
		return { ...base, outcome: 'failed', reason: 'check' };
	}
	if (isResult(current)) return current;
	const file = pdfFile(current)!;
	if (file.size_bytes > MAX_PDF_BYTES) return { ...base, outcome: 'failed', reason: 'too_large' };

	let image: Blob;
	{
		let pdf: Blob | null;
		try {
			pdf = await deps.download(current, file);
		} catch {
			return { ...base, outcome: 'failed', reason: 'download' };
		}
		try {
			image = await deps.render(pdf);
		} catch {
			return { ...base, outcome: 'failed', reason: 'render' };
		} finally {
			pdf = null;
		}
	}

	// Recheck immediately before upload so a cover added meanwhile is never overwritten.
	try {
		current = await recheck();
	} catch {
		return { ...base, outcome: 'failed', reason: 'check' };
	}
	if (isResult(current)) return current;
	try {
		await deps.upload(listed.id, image);
	} catch {
		return { ...base, outcome: 'failed', reason: 'upload' };
	}
	return { ...base, outcome: 'generated' };
}

/**
 * Generates covers for visible PDF books without one, one book at a time. Cancellation
 * is honoured between books; a book already in progress is allowed to finish.
 */
export async function runPdfCoverBatch(deps: PdfCoverDeps, options: PdfCoverRunOptions = {}): Promise<PdfCoverSummary> {
	const { signal } = options;
	const progress: PdfCoverProgress = { scanned: 0, eligible: 0, generated: 0, skipped: 0, failed: 0, current: null };
	const publish = () => options.onProgress?.({ ...progress });
	const attempted = new Set<number>();
	publish();
	for await (const libraries of pages((cursor) => deps.listLibraries(cursor), signal)) {
		for (const library of libraries) {
			for await (const books of pages((cursor) => deps.listBooks(library.id, cursor), signal)) {
				for (const book of books) {
					if (signal?.aborted) break;
					progress.scanned += 1;
					if (!needsPdfCover(book) || attempted.has(book.id)) continue;
					attempted.add(book.id);
					progress.eligible += 1;
					progress.current = { bookId: book.id, title: book.title };
					publish();
					const result = await processBook(deps, book);
					progress[result.outcome] += 1;
					progress.current = null;
					options.onResult?.(result);
					publish();
				}
				publish();
				if (signal?.aborted) break;
			}
			if (signal?.aborted) break;
		}
		if (signal?.aborted) break;
	}
	progress.current = null;
	publish();
	return { ...progress, cancelled: signal?.aborted ?? false };
}
