import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import type { Book } from '#lib/catalog/types.js';
import {
	applyMetadata,
	buildApplyBody,
	fetchCoverPreview,
	InvalidMetadataResponseError,
	lookupCandidates,
	normalizeLookup
} from './api.js';
import {
	candidateClears,
	candidateOffers,
	candidateValues,
	currentValues,
	matchesCurrent,
	pruneSelections,
	selectCandidateValues,
	selectField,
	selectionCount
} from './merge.js';
import { ObjectUrlSlot } from './object-url.js';
import type { Candidate, ProviderResult } from './types.js';

afterEach(() => vi.restoreAllMocks());

const book = (overrides: Partial<Book> = {}): Book => ({
	id: 1,
	library_id: 1,
	owner_id: null,
	visibility: 'library',
	can_manage_visibility: false,
	title: 'Current',
	sort_title: 'Current',
	subtitle: 'Old subtitle',
	description: null,
	language: 'en',
	publisher: null,
	published_date: null,
	page_count: 100,
	cover_url: null,
	cover_source: null,
	authors: [
		{ id: 2, name: 'Second', role: 'translator', position: 1 },
		{ id: 1, name: 'First', role: 'author', position: 0 }
	],
	series: { id: 3, name: 'Saga', index: null },
	tags: [{ id: 1, name: 'Fantasy' }],
	identifiers: [{ scheme: 'isbn13', value: '9780000000001' }],
	files: [],
	field_sources: [],
	created_at: '2026-11-04T00:00:00Z',
	updated_at: '2026-11-04T00:00:00Z',
	...overrides
});

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
	provider: 'openlibrary',
	reference: '/works/OL1W',
	title: 'Candidate',
	subtitle: null,
	authors: [{ name: 'B', role: 'author' }, { name: 'A', role: 'translator' }],
	description: 'A description',
	publisher: 'Pub',
	published_date: '2020-05',
	language: 'en',
	page_count: 321,
	series: { name: 'Saga', index: 2.5 },
	tags: ['Fantasy', 'Epic'],
	identifiers: [{ scheme: 'isbn13', value: '9780000000002' }],
	cover_url: 'https://covers.openlibrary.org/b/id/1-L.jpg',
	...overrides
});

const providers = (): ProviderResult[] => [
	{ provider: 'openlibrary', candidates: [candidate()], error: null },
	{ provider: 'google', candidates: [], error: { code: 'upstream_error', message: 'Provider failed' } },
	{ provider: 'neodb', candidates: [candidate({ provider: 'neodb', reference: 'uuid-1', cover_url: null })], error: null }
];

describe('metadata lookup and apply API', () => {
	it('keeps successful providers when another provider fails and normalizes null arrays', async () => {
		const spy = vi.spyOn(api, 'request').mockResolvedValue({
			request_key: 'key-1',
			query: { title: 'Current' },
			providers: [
				{ provider: 'openlibrary', candidates: [{ ...candidate(), tags: null, identifiers: null }], error: null },
				{ provider: 'google', candidates: null, error: { code: 'unavailable', message: 'x' } }
			]
		});
		const result = await lookupCandidates(1);
		expect(spy).toHaveBeenCalledWith('/books/1/metadata/candidates', expect.objectContaining({ method: 'POST' }));
		expect(spy.mock.calls[0][1]).not.toHaveProperty('body');
		expect(result.request_key).toBe('key-1');
		expect(result.providers[0].candidates[0].tags).toEqual([]);
		expect(result.providers[1]).toEqual({ provider: 'google', candidates: [], error: { code: 'unavailable', message: 'x' } });
	});

	it('rejects lookups without an opaque request key', () => {
		expect(() => normalizeLookup({ providers: [] })).toThrow(InvalidMetadataResponseError);
		expect(() => normalizeLookup({ request_key: 'k', providers: [{ provider: 'x', candidates: [{}] }] })).toThrow(
			InvalidMetadataResponseError
		);
	});

	it('sends only provider references with the retained request key, never values', async () => {
		const updated = book({ title: 'Candidate' });
		const spy = vi.spyOn(api, 'request').mockResolvedValue({ book: updated });
		const selections = selectField(selectField({}, 'title', candidate()), 'cover', candidate());
		await expect(applyMetadata(1, 'key-1', selections)).resolves.toBe(updated);
		expect(spy).toHaveBeenCalledWith('/books/1/metadata/apply', {
			method: 'POST',
			body: {
				request_key: 'key-1',
				fields: {
					title: { provider: 'openlibrary', reference: '/works/OL1W' },
					cover: { provider: 'openlibrary', reference: '/works/OL1W' }
				}
			}
		});
		expect(JSON.stringify(spy.mock.calls[0][1])).not.toContain('covers.openlibrary.org');
	});

	it('omits unselected fields instead of clearing them and refuses empty applies', async () => {
		expect(buildApplyBody('k', { subtitle: undefined, title: candidate() })).toEqual({
			request_key: 'k',
			fields: { title: { provider: 'openlibrary', reference: '/works/OL1W' } }
		});
		const spy = vi.spyOn(api, 'request');
		await expect(applyMetadata(1, 'k', {})).rejects.toThrow();
		expect(spy).not.toHaveBeenCalled();
	});

	it('surfaces 409 conflicts so the caller can repeat the lookup', async () => {
		vi.spyOn(api, 'request').mockRejectedValue(new ApiError(409, 'Conflict', '{}', { status: 409 }));
		await expect(applyMetadata(1, 'stale', { title: candidate() })).rejects.toMatchObject({ status: 409 });
	});

	it('fetches cover previews through the server with the same request key', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(new Blob([new Uint8Array([0xff, 0xd8])]), { headers: { 'content-type': 'image/jpeg' } })
		);
		const blob = await fetchCoverPreview(4, 'key-1', candidate(), undefined, fetcher);
		expect(blob.type).toBe('image/jpeg');
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe('/api/v1/books/4/metadata/cover');
		expect(JSON.parse(String(init?.body))).toEqual({ request_key: 'key-1', provider: 'openlibrary', reference: '/works/OL1W' });
		expect(init?.redirect).toBe('error');

		fetcher.mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
		await expect(fetchCoverPreview(4, 'key-1', candidate(), undefined, fetcher)).rejects.toThrow(InvalidMetadataResponseError);
		fetcher.mockResolvedValue(new Response('{"status":409}', { status: 409, headers: { 'content-type': 'application/problem+json' } }));
		await expect(fetchCoverPreview(4, 'key-1', candidate(), undefined, fetcher)).rejects.toMatchObject({ status: 409 });
	});

});

describe('candidate mapping and selection', () => {
	it('preserves author order and roles, nullable series index, and identifiers', () => {
		const label = (role: string) => role.toUpperCase();
		expect(currentValues(book(), 'authors', label)).toEqual(['First (AUTHOR)', 'Second (TRANSLATOR)']);
		expect(candidateValues(candidate(), 'authors', label)).toEqual(['B (AUTHOR)', 'A (TRANSLATOR)']);
		expect(currentValues(book(), 'series')).toEqual(['Saga']);
		expect(candidateValues(candidate(), 'series')).toEqual(['Saga #2.5']);
		expect(candidateValues(candidate(), 'identifiers')).toEqual(['isbn13: 9780000000002']);
		expect(candidateValues(candidate(), 'tags')).toEqual(['Fantasy', 'Epic']);
	});

	it('only offers covers with a cached URL and marks empty values as explicit clears', () => {
		expect(candidateOffers(candidate({ cover_url: null }), 'cover')).toBe(false);
		expect(candidateOffers(candidate(), 'cover')).toBe(true);
		expect(candidateOffers(candidate({ title: '  ' }), 'title')).toBe(false);
		expect(candidateClears(candidate(), 'subtitle')).toBe(true);
		expect(candidateClears(candidate({ tags: [] }), 'tags')).toBe(true);
		expect(candidateClears(candidate(), 'description')).toBe(false);
		expect(matchesCurrent(book(), candidate({ tags: ['fantasy'] }), 'tags')).toBe(true);
		expect(matchesCurrent(book(), candidate(), 'language')).toBe(true);
	});

	it('selects fields independently and keeps the current value by default', () => {
		let selections = selectField({}, 'title', candidate());
		selections = selectField(selections, 'description', candidate({ provider: 'neodb', reference: 'uuid-1' }));
		expect(selections.title).toEqual({ provider: 'openlibrary', reference: '/works/OL1W' });
		expect(selections.description).toEqual({ provider: 'neodb', reference: 'uuid-1' });
		expect(selectionCount(selections)).toBe(2);
		selections = selectField(selections, 'title', null);
		expect('title' in selections).toBe(false);
	});

	it('chooses all non-empty values from a candidate without selecting clears', () => {
		const selections = selectCandidateValues({}, candidate());
		expect(Object.keys(selections).sort()).toEqual(
			['authors', 'cover', 'description', 'identifiers', 'language', 'page_count', 'published_date', 'publisher', 'series', 'tags', 'title'].sort()
		);
		expect(selections.subtitle).toBeUndefined();
	});

	it('drops selections that are absent from a repeated lookup', () => {
		const selections = selectField(selectField({}, 'title', candidate()), 'cover', { provider: 'neodb', reference: 'uuid-1' });
		const pruned = pruneSelections(selections, providers());
		expect(pruned).toEqual({ title: { provider: 'openlibrary', reference: '/works/OL1W' } });
		expect(pruneSelections(selections, [])).toEqual({});
	});
});

describe('cover object URL lifecycle', () => {
	it('revokes the previous URL when replaced and on clear', () => {
		let next = 0;
		const urls = { createObjectURL: vi.fn(() => `blob:${++next}`), revokeObjectURL: vi.fn() };
		const slot = new ObjectUrlSlot(urls);
		expect(slot.set(new Blob(['a']))).toBe('blob:1');
		expect(slot.set(new Blob(['b']))).toBe('blob:2');
		expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:1');
		slot.clear();
		slot.clear();
		expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2);
		expect(urls.revokeObjectURL).toHaveBeenLastCalledWith('blob:2');
		expect(slot.url).toBeNull();
	});
});

describe('metadata translations', () => {
	it('defines the same W6 keys in English and Chinese', () => {
		const english = Object.keys(en).filter((key) => key.startsWith('metadata.'));
		const chinese = Object.keys(zh).filter((key) => key.startsWith('metadata.'));
		expect(english.length).toBeGreaterThan(40);
		expect(chinese.sort()).toEqual(english.sort());
	});
});
