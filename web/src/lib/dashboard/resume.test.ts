import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Book } from '#lib/catalog/types.js';
import * as readerApi from '#lib/reader/api.js';
import type { Progress } from '#lib/reader/types.js';
import { enqueue, setActiveViewer } from '#lib/sync/db.js';
import { resumeFile, ResumeFileUnavailableError, savedReadingFile } from './resume.js';

const state = vi.hoisted(() => ({ account: 1 }));
vi.mock('#lib/sync/client.js', () => ({
	currentAccount: () => state.account,
	offlineAvailable: () => true
}));

const timestamp = '2026-11-04T00:00:00Z';
const book: Book = {
	id: 21, library_id: 1, title: 'Book', sort_title: 'Book', subtitle: null, description: null,
	language: null, publisher: null, published_date: null, page_count: null, cover_url: null,
	cover_source: null, authors: [], series: null, tags: [], identifiers: [], field_sources: [],
	files: [
		{ id: 11, format: 'epub', size_bytes: 10, download_url: '' },
		{ id: 12, format: 'PDF', size_bytes: 10, download_url: '' },
		{ id: 13, format: 'unknown', size_bytes: 10, download_url: '' }
	],
	created_at: timestamp, updated_at: timestamp
};
const progress = (fileId: number | null): Progress => ({
	book_file_id: fileId, source: 'web', locator: null, percentage: 0.5,
	device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
});

beforeEach(async () => {
	state.account = 1;
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal('IDBKeyRange', IDBKeyRange);
	vi.stubGlobal('navigator', {
		onLine: true,
		locks: { request: async (_name: string, action: () => Promise<unknown>) => action() }
	});
	await setActiveViewer({ id: 1, username: 'reader', display_name: '', role: 'user', locale: 'en' });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('chooses only the exact saved, supported file rather than the first available format', () => {
	expect(savedReadingFile(book, progress(12))?.id).toBe(12);
	expect(savedReadingFile(book, progress(null))).toBeNull();
	expect(savedReadingFile(book, progress(13))).toBeNull();
	expect(savedReadingFile(book, progress(99))).toBeNull();
});

it('resumes using account-scoped queued progress over the online snapshot', async () => {
	vi.spyOn(readerApi, 'getBookState').mockResolvedValue({
		user_book: null, progress: progress(11), highlights: [], notes: []
	});
	await enqueue(1, {
		entity: 'reading_progress', key: '21', op: 'upsert', updated_at: Date.parse(timestamp),
		data: {
			book_id: 21, book_file_id: 12, source: 'web', locator: null, percentage: 0.5,
			device: 'Web', device_id: 'device'
		}
	});
	expect((await resumeFile(1, book)).id).toBe(12);
	await expect(resumeFile(2, book)).rejects.toThrow('account has changed');
});

it('reports missing or unsupported saved files instead of choosing another file', async () => {
	vi.spyOn(readerApi, 'getBookState').mockResolvedValue({
		user_book: null, progress: progress(13), highlights: [], notes: []
	});
	await expect(resumeFile(1, book)).rejects.toBeInstanceOf(ResumeFileUnavailableError);
});
