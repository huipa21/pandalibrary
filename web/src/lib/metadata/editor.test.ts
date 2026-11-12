import { describe, expect, it } from 'vitest';
import type { JsonValue } from '#lib/api/client.js';
import type { Book } from '#lib/catalog/types.js';
import {
	buildManualPatch,
	copyCandidateField,
	createDraft,
	InvalidMetadataDraftError,
	metadataDirty,
	restoreField,
	type MetadataDraft,
	type MetadataPatch
} from './editor.js';
import { InvalidTagsError } from './tags.js';
import { MERGE_FIELDS, type Candidate } from './types.js';

const book: Book = {
	id: 1, library_id: 1, owner_id: null, visibility: 'library', can_manage_visibility: false,
	title: 'Current', sort_title: 'Current', subtitle: 'Subtitle', description: 'Description',
	language: 'en', publisher: 'Publisher', published_date: '2020-05', page_count: 100,
	cover_url: '/cover', cover_source: 'upload',
	authors: [
		{ id: 2, name: 'Second', role: 'translator', position: 1 },
		{ id: 1, name: 'First', role: 'author', position: 0 }
	],
	series: { id: 3, name: 'Saga', index: null }, tags: [{ id: 4, name: 'Fantasy' }],
	identifiers: [{ scheme: 'isbn13', value: '9780000000001' }],
	files: [], field_sources: [], created_at: '', updated_at: ''
};

const candidate: Candidate = {
	provider: 'openlibrary', reference: '/works/OL1W', title: 'Candidate', subtitle: null,
	description: 'Candidate description', language: null, publisher: 'New publisher',
	published_date: '2024', page_count: 321, authors: [{ name: 'Editor', role: 'editor' }],
	series: { name: 'New series', index: 2.5 }, tags: ['Epic'],
	identifiers: [{ scheme: 'doi', value: '10.123/test' }], cover_url: 'https://example.org/cover'
};

function patch(overrides: Partial<MetadataDraft>): MetadataPatch {
	return buildManualPatch(book, { ...createDraft(book), ...overrides }, {});
}

describe('metadata editor drafts', () => {
	it('preserves existing author order, roles, nullable series index, and identifiers without sharing arrays', () => {
		const draft = createDraft(book);
		expect(draft.authors).toEqual([{ name: 'First', role: 'author' }, { name: 'Second', role: 'translator' }]);
		expect(draft.series).toEqual({ name: 'Saga', index: '' });
		expect(draft.identifiers).toEqual(book.identifiers);
		draft.tags.push('New');
		draft.authors.pop();
		draft.identifiers.pop();
		expect(book.tags).toHaveLength(1);
		expect(book.authors).toHaveLength(2);
		expect(book.identifiers).toHaveLength(1);
		expect(patch({ title: 'Changed' })).toEqual({ title: 'Changed' });
	});

	it('copies candidate values into editable fields and restores only that field', () => {
		const source = {
			...candidate,
			authors: [...candidate.authors],
			tags: [...candidate.tags],
			identifiers: [...candidate.identifiers]
		};
		const original = createDraft(book);
		let draft = original;
		for (const field of MERGE_FIELDS) draft = copyCandidateField(draft, source, field);
		expect(draft).toMatchObject({
			title: 'Candidate', subtitle: '', language: '', page_count: '321',
			series: { name: 'New series', index: '2.5' }, authors: candidate.authors,
			tags: candidate.tags, identifiers: candidate.identifiers
		});
		expect(original).toEqual(createDraft(book));
		expect(draft).not.toHaveProperty('cover');
		expect(copyCandidateField(draft, candidate, 'cover')).toBe(draft);
		expect(restoreField(draft, book, 'cover')).toBe(draft);
		expect(restoreField(draft, book, 'authors').authors).toEqual(original.authors);
		expect(restoreField(draft, book, 'series').series).toEqual({ name: 'Saga', index: '' });
		expect(restoreField(draft, book, 'title')).toEqual({ ...draft, title: 'Current' });
		expect(copyCandidateField(draft, { ...source, page_count: null }, 'page_count').page_count).toBe('');
		expect(copyCandidateField(draft, { ...source, series: null }, 'series').series).toEqual({ name: '', index: '' });
		draft.authors.pop();
		draft.tags.pop();
		draft.identifiers.pop();
		expect(source.authors).toHaveLength(1);
		expect(source.tags).toHaveLength(1);
		expect(source.identifiers).toHaveLength(1);
	});

	it('omits unchanged and selected fields, even if a selected draft value is invalid', () => {
		expect(buildManualPatch(book, createDraft(book), {})).toEqual({});
		const result = buildManualPatch(book, {
			...createDraft(book), title: '', page_count: 'NaN', tags: [' Epic '], subtitle: '',
			authors: [{ name: '', role: 'unknown' }]
		}, { title: candidate, page_count: candidate, authors: candidate });
		expect(result).toEqual({ subtitle: null, tags: ['Epic'] });
		const json: JsonValue = result;
		expect(json).toEqual(result);
	});

	it('sends optional clears as null and array clears as explicit empty arrays', () => {
		expect(patch({
			subtitle: '', description: '  ', language: '', publisher: '', published_date: '',
			page_count: '', series: { name: '', index: '' }, authors: [], tags: [], identifiers: []
		})).toEqual({
			subtitle: null, description: null, language: null, publisher: null, published_date: null,
			page_count: null, series: null, authors: [], tags: [], identifiers: []
		});
	});

	it('uses backend whitespace trimming for draft fields without trimming BOM characters', () => {
		expect(patch({ title: '\u0085 Revised \u3000', page_count: '\u0085 123 \u3000', subtitle: '\ufeff' }))
			.toEqual({ title: 'Revised', page_count: 123, subtitle: '\ufeff' });
	});

	it('keeps edited authors in order with their roles and keeps a nullable series index', () => {
		expect(patch({
			authors: [{ name: ' First revised ', role: 'author' }, { name: 'Second', role: 'translator' }],
			series: { name: 'Changed saga', index: '' },
			identifiers: [{ scheme: 'isbn13', value: ' 9780000000002 ' }]
		})).toEqual({
			authors: [{ name: 'First revised', role: 'author' }, { name: 'Second', role: 'translator' }],
			series: { name: 'Changed saga', index: null },
			identifiers: [{ scheme: 'isbn13', value: '9780000000002' }]
		});
	});

	it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '1e3', '0x10', '9007199254740992'])(
		'rejects invalid page count %s', (page_count) => {
			expect(() => patch({ page_count })).toThrow(InvalidMetadataDraftError);
			expect(() => patch({ page_count })).toThrow('page_count');
		}
	);

	it('accepts positive safe integer page counts and nonnegative decimal series indexes', () => {
		expect(patch({ page_count: ' 123 ', series: { name: 'Saga', index: '2.5' } }))
			.toEqual({ page_count: 123, series: { name: 'Saga', index: 2.5 } });
		expect(patch({ page_count: String(Number.MAX_SAFE_INTEGER) }).page_count).toBe(Number.MAX_SAFE_INTEGER);
		expect(patch({ series: { name: 'Saga', index: '0' } }).series).toEqual({ name: 'Saga', index: 0 });
		expect(patch({ page_count: '0100', title: ' Current ' })).toEqual({});
	});

	it.each(['-1', 'Infinity', 'NaN', '1e309', '0x10', '1.2.3'])('rejects invalid series index %s', (index) => {
		expect(() => patch({ series: { name: 'Saga', index } })).toThrow('series');
	});

	it('rejects missing title, series name with index, invalid dates, associations and tags', () => {
		expect(() => patch({ title: '  ' })).toThrow('title');
		expect(() => patch({ series: { name: '', index: '1' } })).toThrow('series');
		expect(() => patch({ published_date: '2023-02-29' })).toThrow('published_date');
		expect(patch({ published_date: '2024-02-29' })).toEqual({ published_date: '2024-02-29' });
		expect(() => patch({ authors: [{ name: '', role: 'author' }] })).toThrow('authors');
		expect(() => patch({ authors: [{ name: 'Name', role: 'unknown' }] })).toThrow('authors');
		expect(() => patch({ identifiers: [{ scheme: 'unknown', value: 'x' }] })).toThrow('identifiers');
		expect(() => patch({ identifiers: [{ scheme: 'doi', value: '' }] })).toThrow('identifiers');
		expect(() => patch({ tags: ['Fantasy', ' fantasy '] })).toThrow(InvalidTagsError);
	});

	it('detects manual changes, invalid drafts and provider selections without throwing', () => {
		const draft = createDraft(book);
		expect(metadataDirty(book, draft, {})).toBe(false);
		expect(metadataDirty(book, { ...draft, title: 'Changed' }, {})).toBe(true);
		expect(metadataDirty(book, { ...draft, page_count: 'NaN' }, {})).toBe(true);
		expect(metadataDirty(book, { ...draft, tags: [''] }, {})).toBe(true);
		expect(metadataDirty(book, draft, { cover: candidate })).toBe(true);
		expect(metadataDirty(book, draft, { title: candidate })).toBe(true);
		expect(metadataDirty(book, draft, { title: undefined })).toBe(false);
	});

	it('rethrows unexpected errors instead of reporting a dirty draft', () => {
		const draft = createDraft(book);
		const unexpected = new Error('Unexpected draft access failure');
		Object.defineProperty(draft, 'title', { get() { throw unexpected; } });
		expect(() => metadataDirty(book, draft, {})).toThrow(unexpected);
	});
});
