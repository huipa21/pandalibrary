import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '#lib/catalog/types.js';
import { resumeFile, ResumeFileUnavailableError } from '#lib/dashboard/resume.js';
import { readTarget } from './read.js';

vi.mock('#lib/dashboard/resume.js', async (importOriginal) => ({
	...await importOriginal<typeof import('#lib/dashboard/resume.js')>(),
	resumeFile: vi.fn()
}));

const book: Book = {
	id: 21, library_id: 1, title: 'Book', sort_title: 'Book', subtitle: null, description: null,
	language: null, publisher: null, published_date: null, page_count: null, cover_url: null,
	cover_source: null, authors: [], series: null, tags: [], identifiers: [], field_sources: [],
	files: [
		{ id: 11, format: 'pdf', size_bytes: 10, download_url: '', original_filename: 'book.pdf', created_at: '2026-11-07T00:00:00Z' },
		{ id: 12, format: 'EPUB', size_bytes: 10, download_url: '', original_filename: 'book.epub', created_at: '2026-11-07T00:00:00Z' },
		{ id: 13, format: 'zip', size_bytes: 10, download_url: '', original_filename: 'book.zip', created_at: '2026-11-07T00:00:00Z' }
	],
	created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:00:00Z'
};

afterEach(() => vi.resetAllMocks());

describe('readTarget', () => {
	it('prefers the account-scoped saved file even when another format ranks first', async () => {
		vi.mocked(resumeFile).mockResolvedValue(book.files[0]);
		await expect(readTarget(book, 4)).resolves.toEqual({ bookId: 21, fileId: 11 });
		expect(resumeFile).toHaveBeenCalledWith(4, book);
	});

	it('falls back in format order when the saved file is missing or unsupported', async () => {
		vi.mocked(resumeFile).mockRejectedValue(new ResumeFileUnavailableError());
		await expect(readTarget(book, 4)).resolves.toEqual({ bookId: 21, fileId: 12 });
	});

	it('does not make a request when no format is readable', async () => {
		await expect(readTarget({ ...book, files: [book.files[2]] }, 4)).resolves.toBeNull();
		await expect(readTarget({ ...book, files: [] }, 4)).resolves.toBeNull();
		expect(resumeFile).not.toHaveBeenCalled();
	});

	it('surfaces account, network, and storage failures instead of silently falling back', async () => {
		vi.mocked(resumeFile).mockRejectedValue(new Error('offline storage failed'));
		await expect(readTarget(book, 4)).rejects.toThrow('offline storage failed');
	});
});
