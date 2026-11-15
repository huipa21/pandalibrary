import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictionaryEntry } from '#lib/dictionary/types.js';
import { activeWordbookCount, notifyWordbooksChanged, WORDBOOKS_CHANGED_EVENT, wordbooks, type EntrySource } from './api.js';

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

describe('wordbook sidebar count', () => {
	it('counts only active wordbooks', () => {
		expect(activeWordbookCount([])).toBe(0);
		expect(activeWordbookCount([{ archived: false }, { archived: true }, { archived: false }])).toBe(2);
	});

	it('announces wordbook changes on the target', () => {
		const target = new EventTarget();
		const listener = vi.fn();
		target.addEventListener(WORDBOOKS_CHANGED_EVENT, listener);
		notifyWordbooksChanged(target);
		expect(listener).toHaveBeenCalledOnce();
	});
});

describe('wordbook API contract', () => {
	it('passes multi-language preferences and explicit empty selections without dropping legacy writes', async () => {
		request.mockResolvedValue({ id: 1, meaning_language: 'zh', meaning_languages: ['zh', 'ja'] });
		await expect(wordbooks.create('Study', { meaning_languages: ['zh', 'ja'] })).resolves.toMatchObject({ meaning_languages: ['zh', 'ja'] });
		expect(request).toHaveBeenLastCalledWith('/wordbooks', { method: 'POST', body: { name: 'Study', meaning_languages: ['zh', 'ja'] } });
		await wordbooks.update(1, { meaning_languages: [] });
		expect(request).toHaveBeenLastCalledWith('/wordbooks/1', { method: 'PATCH', body: { meaning_languages: [] } });
	});

	it('preserves meaning language options on creation and editing, including unspecified', async () => {
		request.mockResolvedValue({ id: 1 });
		await wordbooks.create('Study', { language: 'en', meaning_language: 'zh' });
		expect(request).toHaveBeenLastCalledWith('/wordbooks', { method: 'POST', body: { name: 'Study', language: 'en', meaning_language: 'zh' } });
		await wordbooks.update(1, { language: 'ja', meaning_language: '' });
		expect(request).toHaveBeenLastCalledWith('/wordbooks/1', { method: 'PATCH', body: { language: 'ja', meaning_language: '' } });
	});

	it('deletes a wordbook with no body or explicitly merges into the chosen target', async () => {
		request.mockResolvedValue(undefined);
		await wordbooks.deleteBook(1);
		expect(request).toHaveBeenLastCalledWith('/wordbooks/1', { method: 'DELETE' });
		await wordbooks.deleteBook(1, 2);
		expect(request).toHaveBeenLastCalledWith('/wordbooks/1', { method: 'DELETE', body: { merge_into_id: 2 } });
	});

	it('sends a selected language when creating or updating a wordbook', async () => {
		request.mockResolvedValue({ id: 1 });
		await wordbooks.create('Study', { language: 'ja' });
		expect(request).toHaveBeenLastCalledWith('/wordbooks', { method: 'POST', body: { name: 'Study', language: 'ja' } });
		await wordbooks.update(1, { language: '' });
		expect(request).toHaveBeenLastCalledWith('/wordbooks/1', { method: 'PATCH', body: { language: '' } });
	});

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
	it('persists generated cover palettes and uploaded covers, including clearing them', async () => {
		request.mockResolvedValue({ id: 1 });
		const cover = { cover_color: 'forest', cover_image: 'data:image/jpeg;base64,fixture' };
		await wordbooks.create('Study', { description: 'Notes', ...cover });
		expect(request).toHaveBeenLastCalledWith('/wordbooks', {
			method: 'POST', body: { name: 'Study', description: 'Notes', ...cover }
		});
		await wordbooks.update(1, cover);
		expect(request).toHaveBeenLastCalledWith('/wordbooks/1', { method: 'PATCH', body: cover });
		await wordbooks.update(1, { cover_color: '', cover_image: '' });
		expect(request).toHaveBeenLastCalledWith('/wordbooks/1', {
			method: 'PATCH', body: { cover_color: '', cover_image: '' }
		});
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
