import { describe, expect, it } from 'vitest';
import type { Book, BookFile } from '#lib/catalog/types.js';
import type { Progress } from '#lib/reader/types.js';
import { buildFilesModel, readerGroup, sortFiles, splitFileName } from './files-model.js';

function file(id: number, format: string, name: string, size: number, date: string): BookFile {
	return {
		id, format, original_filename: name, size_bytes: size,
		created_at: date, download_url: `/files/${id}`
	};
}

const files = [
	file(3, 'mobi', 'Zulu.mobi', 30, '2026-03-01T00:00:00Z'),
	file(4, 'cbz', 'Comic.cbz', 40, '2026-04-01T00:00:00Z'),
	file(2, 'PDF', 'Document.pdf', 20, '2026-02-01T00:00:00Z'),
	file(5, 'EPUB', 'Beta.epub', 50, '2026-05-01T00:00:00Z'),
	file(1, 'epub', 'Alpha.epub', 10, '2026-01-01T00:00:00Z')
];

const book: Book = {
	owner_id: null, visibility: 'library', can_manage_visibility: false,
	id: 21, library_id: 1, title: 'Book', sort_title: 'Book', subtitle: null, description: null,
	language: null, publisher: null, published_date: null, page_count: null, cover_url: null,
	cover_source: null, authors: [], series: null, tags: [], identifiers: [], field_sources: [],
	files, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
};

const progress: Progress = {
	book_file_id: 2, percentage: 0.21, updated_at: '2026-06-01T00:00:00Z',
	source: 'web', device: 'browser', device_id: 'device', locator: null, rev: 1
};

describe('files model', () => {
	it('groups every known reader format and leaves unknown formats visible', () => {
		expect(['epub', 'mobi', 'azw3', 'fb2', 'fbz'].map(readerGroup)).toEqual([
			'ebook', 'ebook', 'ebook', 'ebook', 'ebook'
		]);
		expect(readerGroup(' PDF ')).toBe('document');
		expect(readerGroup('CBZ')).toBe('comic');
		expect(readerGroup('zip')).toBe('other');

		const model = buildFilesModel({
			...book, files: [...files, file(6, 'zip', 'Other.zip', 60, '2026-06-01T00:00:00Z')]
		}, progress, [2, 4]);
		expect(model.groups.map(({ key, count, bytes }) => ({ key, count, bytes }))).toEqual([
			{ key: 'ebook', count: 3, bytes: 90 },
			{ key: 'document', count: 1, bytes: 20 },
			{ key: 'comic', count: 1, bytes: 40 },
			{ key: 'other', count: 1, bytes: 60 }
		]);
		expect(model.groups[0].files.map((item) => item.id)).toEqual([1, 5, 3]);
		expect(model.totalBytes).toBe(210);
		expect(model.formats).toEqual([
			{ format: 'epub', count: 2 }, { format: 'pdf', count: 1 }, { format: 'cbz', count: 1 },
			{ format: 'mobi', count: 1 }, { format: 'zip', count: 1 }
		]);
		expect(model.groups[3].files[0].readable).toBe(false);
		expect(model.groups[1].files[0]).toMatchObject({ progress: 0.21, saved: true, readable: true });
		expect(model.groups[0].files.every((item) => item.progress === null && !item.saved)).toBe(true);
		expect(model.groups[2].files[0].saved).toBe(true);
		expect(model.primaryFileId).toBe(2);
		expect(book.files).toEqual(files);
	});

	it('falls back to the preferred format when progress is absent or points to a missing file', () => {
		expect(buildFilesModel(book, null, []).primaryFileId).toBe(1);
		const missing = buildFilesModel(book, { ...progress, book_file_id: 999 }, []);
		expect(missing.primaryFileId).toBe(1);
		expect(missing.groups.flatMap((group) => group.files).every((item) => item.progress === null)).toBe(true);
		expect(buildFilesModel({ ...book, files: [] }, progress, [])).toEqual({
			groups: [], totalBytes: 0, formats: [], primaryFileId: null, defaultFileId: null
		});
	});

	it('prefers the default file over format order but keeps the file being read primary', () => {
		const withDefault = { ...book, files: files.map((item) => ({ ...item, is_default: item.id === 3 })) };
		expect(buildFilesModel(withDefault, null, [])).toMatchObject({ primaryFileId: 3, defaultFileId: 3 });
		expect(buildFilesModel(withDefault, progress, [])).toMatchObject({ primaryFileId: 2, defaultFileId: 3 });
	});

	it('sorts only the supplied group and handles older offline snapshots with missing metadata', () => {
		const model = buildFilesModel(book, null, []);
		const group = model.groups[0].files;
		expect(sortFiles(group, 'name').map((item) => item.id)).toEqual([1, 5, 3]);
		expect(sortFiles(group, 'size').map((item) => item.id)).toEqual([5, 3, 1]);
		expect(sortFiles(group, 'added').map((item) => item.id)).toEqual([5, 3, 1]);
		expect(group.map((item) => item.id)).toEqual([1, 5, 3]);

		const legacy = JSON.parse(JSON.stringify(files[0])) as BookFile;
		Reflect.deleteProperty(legacy, 'original_filename');
		Reflect.deleteProperty(legacy, 'created_at');
		const item = buildFilesModel({ ...book, files: [legacy] }, null, []).groups[0].files[0];
		expect(item.original_filename).toBe('Book.mobi');
		expect(item.created_at).toBe('');
		expect(sortFiles([item, group[0]], 'added').at(-1)?.id).toBe(item.id);
		expect(buildFilesModel({ ...book, title: 'Folder\\Part/Book\u0000', files: [legacy] }, null, [])
			.groups[0].files[0].original_filename).toBe('Folder_Part_Book_.mobi');
		const spaced = file(7, ' pdf ', 'Unrecognized.pdf', 5, '2026-01-01T00:00:00Z');
		expect(buildFilesModel({ ...book, files: [spaced] }, null, []).groups[0].files[0].readable).toBe(false);
	});

	it('separates an extension without treating dotfiles or a trailing dot as one', () => {
		expect(splitFileName('My.Book.epub')).toEqual({ stem: 'My.Book', extension: '.epub' });
		expect(splitFileName('.hidden')).toEqual({ stem: '.hidden', extension: '' });
		expect(splitFileName('book.')).toEqual({ stem: 'book.', extension: '' });
	});
});
