import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictionaryEntry } from '#lib/dictionary/types.js';
import { wordbooks, type EntrySource } from './api.js';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('#lib/api/client.js', () => ({ api: { request } }));

const source: EntrySource = {
	book_id: 3,
	book_file_id: 7,
	book_title: 'A reading book',
	locator: { type: 'cfi', value: 'epubcfi(/6/2!/4/2)' },
	fraction: 0.25,
	chapter: 'Chapter 2'
};

beforeEach(() => {
	request.mockReset();
});

describe('wordbook API contract', () => {
	it('creates notebooks with optional descriptions and allows description editing', async () => {
		request.mockResolvedValue({ id: 1 });
		await wordbooks.create('Private');
		expect(request).toHaveBeenLastCalledWith('/wordbooks', { method: 'POST', body: { name: 'Private' } });
		await wordbooks.create('Study', { description: 'Study notes' });
		expect(request).toHaveBeenLastCalledWith('/wordbooks', { method: 'POST', body: { name: 'Study', description: 'Study notes' } });
		await wordbooks.update(1, { description: '' });
		expect(request).toHaveBeenLastCalledWith('/wordbooks/1', { method: 'PATCH', body: { description: '' } });
	});

	it('unwraps entries collected from a book', async () => {
		request.mockResolvedValueOnce({ entries: [{ id: 3 }] });
		await expect(wordbooks.bookEntries(8)).resolves.toEqual([{ id: 3 }]);
		expect(request).toHaveBeenCalledWith('/books/8/words');
	});
	it('collects arbitrary text in the default book without requiring a dictionary', async () => {
		request.mockResolvedValue({ id: 8 });
		const text = 'A paragraph.\n\nAnother paragraph.';
		await wordbooks.add({ kind: 'passage', text, source });
		expect(request).toHaveBeenCalledWith('/wordbooks/entries', {
			method: 'POST',
			body: { kind: 'passage', text, source }
		});
		expect(request.mock.calls[0][1].body).not.toHaveProperty('wordbook_id');
		expect(request.mock.calls[0][1].body).not.toHaveProperty('dictionary_entries');
	});

	it('preserves dictionary snapshots, manual overrides and source when collecting a phrase', async () => {
		const entries: DictionaryEntry[] = [{
			source: 'test',
			sourceName: 'Test dictionary',
			headword: 'take off',
			definitions: ['depart'],
			match: 'exact'
		}];
		request.mockResolvedValue({ id: 9 });
		await wordbooks.add({
			wordbook_id: 4,
			kind: 'phrase',
			text: 'take off',
			definition: 'My definition',
			note: '',
			dictionary_entries: entries,
			source
		});
		expect(request.mock.calls[0]).toEqual(['/wordbooks/entries', {
			method: 'POST',
			body: {
				wordbook_id: 4,
				kind: 'phrase',
				text: 'take off',
				definition: 'My definition',
				note: '',
				dictionary_entries: entries,
				source
			}
		}]);
	});

	it('imports the original JSON file into the chosen book and exports the versioned document', async () => {
		const file = new Blob(['{"version":1}'], { type: 'application/json' });
		request.mockResolvedValueOnce({ imported: 2 }).mockResolvedValueOnce({
			version: 1, wordbook: { name: 'Vocabulary' }, entries: []
		});
		await expect(wordbooks.import(4, file)).resolves.toEqual({ imported: 2 });
		expect(request).toHaveBeenNthCalledWith(1, '/wordbooks/4/import', {
			method: 'POST', body: file, headers: { 'content-type': 'application/json' }
		});
		await expect(wordbooks.export(4)).resolves.toEqual({
			version: 1, wordbook: { name: 'Vocabulary' }, entries: []
		});
	});

	it('surfaces collection failures instead of returning a saved entry', async () => {
		request.mockRejectedValue(new Error('Source book is unavailable'));
		await expect(wordbooks.add({ kind: 'word', text: 'word', source }))
			.rejects.toThrow('Source book is unavailable');
	});
});
