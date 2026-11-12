import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import type { Book, BookFile, Library, Page } from '#lib/catalog/types.js';
import {
	applyMetadata,
	buildApplyBody,
	fetchCoverPreview,
	InvalidMetadataResponseError,
	lookupCandidates,
	normalizeLookup,
	uploadPdfCover
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
import { MAX_PDF_BYTES, needsPdfCover, runPdfCoverBatch, type PdfCoverDeps, type PdfCoverResult } from './pdf-covers.js';
import { coverRenderSize, PDF_COVER_MAX_EDGE } from './pdf-render.js';
import type { Candidate, ProviderResult } from './types.js';

afterEach(() => vi.restoreAllMocks());

const pdf = (id: number, size = 1024): BookFile => ({
	id,
	format: 'pdf',
	size_bytes: size,
	download_url: `/api/v1/books/${id}/files/${id}?v=${'a'.repeat(64)}`,
	original_filename: `book-${id}.pdf`,
	created_at: '2026-11-01T00:00:00Z'
});

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

	it('uploads raw generated image bytes as a pdfjs cover', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
		const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
		await uploadPdfCover(9, image, fetcher);
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe('/api/v1/books/9/cover?source=pdfjs');
		expect(init?.method).toBe('PUT');
		expect(init?.body).toBe(image);
		expect(new Headers(init?.headers).get('content-type')).toBe('image/jpeg');

		fetcher.mockResolvedValue(new Response('', { status: 413 }));
		await expect(uploadPdfCover(9, image, fetcher)).rejects.toMatchObject({ status: 413 });
		await expect(uploadPdfCover(9, new Blob(['x'], { type: 'text/plain' }), fetcher)).rejects.toThrow();
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

describe('PDF cover rendering bounds', () => {
	it('fits the long edge within the bound and caps upscaling', () => {
		const portrait = coverRenderSize(612, 792);
		expect(portrait.height).toBe(PDF_COVER_MAX_EDGE);
		expect(portrait.width).toBeLessThanOrEqual(PDF_COVER_MAX_EDGE);
		const huge = coverRenderSize(14400, 14400);
		expect(huge.width).toBe(PDF_COVER_MAX_EDGE);
		expect(huge.scale).toBeLessThan(1);
		const tiny = coverRenderSize(10, 20);
		expect(tiny.scale).toBe(4);
		expect(tiny.height).toBe(80);
		expect(() => coverRenderSize(0, 10)).toThrow();
		expect(() => coverRenderSize(Number.NaN, 10)).toThrow();
	});
});

describe('PDF cover batch', () => {
	const library = (id: number): Library => ({ id, name: `L${id}`, slug: `l${id}`, created_at: '', updated_at: '' });
	const page = <T,>(items: T[], next_cursor: string | null = null): Page<T> => ({ items, next_cursor });

	function deps(overrides: Partial<PdfCoverDeps> = {}, books = new Map<number, Book>()): PdfCoverDeps & { calls: string[] } {
		const calls: string[] = [];
		return {
			calls,
			listLibraries: vi.fn(async (cursor: string | null) => {
				calls.push(`libraries:${cursor}`);
				return cursor === null ? page([library(1)], 'lib/+next') : page([library(2)]);
			}),
			listBooks: vi.fn(async (libraryId: number, cursor: string | null) => {
				calls.push(`books:${libraryId}:${cursor}`);
				const items = [...books.values()].filter((item) => item.library_id === libraryId);
				if (libraryId === 1 && cursor === null) return page(items.slice(0, 2), 'opaque=');
				if (libraryId === 1) return page(items.slice(2));
				return page(items);
			}),
			getBook: vi.fn(async (id: number) => {
				const found = books.get(id);
				if (!found) throw new ApiError(404, 'Not Found', '');
				return found;
			}),
			download: vi.fn(async () => new Blob(['%PDF'], { type: 'application/pdf' })),
			render: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
			upload: vi.fn(async () => undefined),
			...overrides
		};
	}

	function catalog(): Map<number, Book> {
		return new Map([
			[1, book({ id: 1, title: 'PDF no cover', files: [pdf(1)] })],
			[2, book({ id: 2, title: 'PDF with cover', cover_url: '/api/v1/books/2/cover', files: [pdf(2)] })],
			[3, book({ id: 3, title: 'EPUB', files: [{ ...pdf(3), format: 'epub' }] })],
			[4, book({ id: 4, library_id: 2, title: 'Second library PDF', files: [pdf(4)] })]
		]);
	}

	it('filters visible PDFs without covers and follows returned cursors verbatim', async () => {
		const books = catalog();
		const d = deps({}, books);
		const results: PdfCoverResult[] = [];
		const summary = await runPdfCoverBatch(d, { onResult: (result) => results.push(result) });
		expect(needsPdfCover(books.get(1)!)).toBe(true);
		expect(needsPdfCover(books.get(2)!)).toBe(false);
		expect(results.map((result) => [result.bookId, result.outcome])).toEqual([[1, 'generated'], [4, 'generated']]);
		expect(d.calls).toEqual(['libraries:null', 'books:1:null', 'books:1:opaque=', 'libraries:lib/+next', 'books:2:null']);
		expect(d.upload).toHaveBeenCalledTimes(2);
		expect(summary).toMatchObject({ scanned: 4, eligible: 2, generated: 2, failed: 0, cancelled: false });
	});

	it('never uploads when a cover appears before upload', async () => {
		const books = catalog();
		const d = deps({
			render: vi.fn(async () => {
				books.set(1, { ...books.get(1)!, cover_url: '/api/v1/books/1/cover' });
				return new Blob(['jpeg'], { type: 'image/jpeg' });
			})
		}, books);
		const results: PdfCoverResult[] = [];
		await runPdfCoverBatch(d, { onResult: (result) => results.push(result) });
		expect(results[0]).toMatchObject({ bookId: 1, outcome: 'skipped', reason: 'has_cover' });
		expect(d.upload).not.toHaveBeenCalledWith(1, expect.anything());
	});

	it('reports per-book download, render, upload, and size failures and continues', async () => {
		const books = new Map<number, Book>([
			[1, book({ id: 1, files: [pdf(1)] })],
			[2, book({ id: 2, files: [pdf(2)] })],
			[3, book({ id: 3, files: [pdf(3)] })],
			[4, book({ id: 4, library_id: 2, files: [pdf(4, MAX_PDF_BYTES + 1)] })]
		]);
		const d = deps({
			download: vi.fn(async (item: Book) => {
				if (item.id === 1) throw new TypeError('network');
				return new Blob([String(item.id)]);
			}),
			render: vi.fn(async (blob: Blob) => {
				if ((await blob.text()) === '2') throw new Error('bad pdf');
				return new Blob(['jpeg'], { type: 'image/jpeg' });
			}),
			upload: vi.fn(async () => {
				throw new ApiError(413, '', '');
			})
		}, books);
		const results: PdfCoverResult[] = [];
		const summary = await runPdfCoverBatch(d, { onResult: (result) => results.push(result) });
		expect(results.map((result) => result.reason)).toEqual(['download', 'render', 'upload', 'too_large']);
		expect(summary.failed).toBe(4);
		expect(d.download).not.toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), expect.anything());
	});

	it('stops between books when cancelled and lets the current book finish', async () => {
		const books = catalog();
		const controller = new AbortController();
		const d = deps({
			upload: vi.fn(async () => {
				controller.abort();
			})
		}, books);
		const results: PdfCoverResult[] = [];
		const summary = await runPdfCoverBatch(d, { signal: controller.signal, onResult: (result) => results.push(result) });
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ bookId: 1, outcome: 'generated' });
		expect(summary.cancelled).toBe(true);
		expect(d.calls).not.toContain('libraries:lib/+next');
	});

	it('rejects repeated cursors instead of looping', async () => {
		const d = deps({ listLibraries: vi.fn(async () => page([], 'same')) });
		await expect(runPdfCoverBatch(d)).rejects.toThrow('repeated');
	});
});

describe('metadata translations', () => {
	it('defines the same W6 keys in English and Chinese', () => {
		const english = Object.keys(en).filter((key) => key.startsWith('metadata.'));
		const chinese = Object.keys(zh).filter((key) => key.startsWith('metadata.'));
		expect(english.length).toBeGreaterThan(50);
		expect(chinese.sort()).toEqual(english.sort());
	});
});
