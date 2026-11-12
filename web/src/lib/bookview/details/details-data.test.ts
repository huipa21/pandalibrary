import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => {
	const mock = vi.fn<typeof fetch>();
	globalThis.fetch = mock;
	return mock;
});

vi.mock('#lib/sync/client.js', () => ({
	currentAccount: vi.fn(() => 4),
	offlineAvailable: vi.fn(() => false)
}));
vi.mock('#lib/sync/state.js', () => ({ readerState: vi.fn() }));

import type { Book } from '#lib/catalog/types.js';
import type { BookState, Note, Progress } from '#lib/reader/types.js';
import { offlineAvailable } from '#lib/sync/client.js';
import { readerState } from '#lib/sync/state.js';
import { loadDetailsState, loadRelated } from './details-data.js';

const stamp = '2026-11-07T10:00:00Z';
const emptyState: BookState = {
	user_book: null, progress: null, notes: [], highlights: [], bookmarks: []
};
const progress: Progress = {
	book_file_id: 31, source: 'web', locator: null, percentage: 0.21, device: 'Web',
	device_id: 'device', updated_at: stamp, rev: 1
};

function note(id: string): Note {
	return {
		id, book_id: 21, highlight_id: null, body_md: id, created_at: stamp,
		updated_at: stamp, deleted_at: null, rev: 1
	};
}

function book(id: number, index: number | null = id): Book {
	return {
		owner_id: null, visibility: 'library', can_manage_visibility: false,
		id, library_id: 1, title: `Book ${id}`, sort_title: `Book ${id}`, subtitle: null,
		description: null, language: null, publisher: null, published_date: null,
		page_count: null, cover_url: null, cover_source: null,
		authors: [{ id: 8, name: 'Author', role: 'author', position: 0 }],
		series: { id: 9, name: 'Series', index }, tags: [{ id: 10, name: 'Tag' }],
		identifiers: [], files: [], field_sources: [], created_at: stamp, updated_at: stamp
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	fetchMock.mockReset();
	vi.mocked(offlineAvailable).mockReturnValue(false);
	vi.mocked(readerState).mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('details state', () => {
	it('loads only the reader book state and never exposes private notes', async () => {
		const state: BookState = { ...emptyState, progress, notes: [note('private')] };
		fetchMock.mockImplementation(async () => json(state));
		const controller = new AbortController();
		const result = await loadDetailsState(21, controller.signal);
		expect(result).toEqual({ userBook: null, progress });
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/me/books/21');
		expect(fetchMock.mock.calls.some(([url]) => String(url).includes('reading-summary'))).toBe(false);
	});

	it('uses synchronized offline data without network requests', async () => {
		const offlineState: BookState = {
			...emptyState,
			user_book: {
				status: 'reading', rating: 7, started_at: Date.parse(stamp), finished_at: null,
				updated_at: stamp, rev: 0
			},
			notes: [note('offline')]
		};
		vi.mocked(readerState).mockResolvedValue({ state: offlineState, settings: [] });
		const result = await loadDetailsState(21, undefined, true);
		expect(readerState).toHaveBeenCalledWith(4, 21);
		expect(result).toEqual({
			userBook: expect.objectContaining({ status: 'reading', rating: 7, started_at: '2026-11-07T10:00:00.000Z' }),
			progress: null
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('overlays queued local changes on the online state', async () => {
		vi.mocked(offlineAvailable).mockReturnValue(true);
		const local = { ...emptyState, progress };
		vi.mocked(readerState).mockResolvedValue({ state: local, settings: [] });
		fetchMock.mockImplementation(async () => json(emptyState));
		expect((await loadDetailsState(21)).progress).toEqual(progress);
		expect(readerState).toHaveBeenCalledWith(4, 21, { state: { ...emptyState, page_annotations: [] }, settings: [] });
	});

	it('propagates invalid state, API failures, and cancellation', async () => {
		fetchMock.mockImplementation(async () => json({ ...emptyState, user_book: {} }));
		await expect(loadDetailsState(21)).rejects.toThrow('Invalid user book state');
		fetchMock.mockImplementation(async () => json({ title: 'Unavailable' }, 503));
		await expect(loadDetailsState(21)).rejects.toMatchObject({ status: 503 });
		const controller = new AbortController();
		controller.abort();
		await expect(loadDetailsState(21, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
		await expect(loadDetailsState(0, undefined, true)).rejects.toThrow(RangeError);
	});
});

describe('related books', () => {
	it('uses the first author, puts series in index order, deduplicates, and caps results', async () => {
		const current = book(21);
		const requests: URLSearchParams[] = [];
		fetchMock.mockImplementation(async (input) => {
			const query = new URL(String(input), 'http://example.test').searchParams;
			requests.push(query);
			if (query.has('author_id')) return json({ items: [current, book(4)], next_cursor: null });
			if (query.has('series_id')) return json({ items: [book(3, 3), current, book(2, 1)], next_cursor: null });
			return json({ items: [book(3), ...Array.from({ length: 30 }, (_, i) => book(i + 30))], next_cursor: null });
		});
		const result = await loadRelated(current);
		expect(result.byAuthor.map((item) => item.id)).toEqual([4]);
		expect(result.similar.map((item) => item.id).slice(0, 3)).toEqual([2, 3, 30]);
		expect(result.similar).toHaveLength(24);
		expect(new Set(result.similar.map((item) => item.id)).size).toBe(24);
		expect(requests).toHaveLength(3);
		expect(requests.every((query) => query.get('limit') === '24')).toBe(true);
		expect(requests.find((query) => query.has('author_id'))?.get('sort')).toBe('title');
		expect(requests.find((query) => query.has('series_id'))?.get('sort')).toBe('series');
		expect(requests.find((query) => query.has('tag_id'))?.get('tag_id')).toBe('10');
	});

	it('skips missing relationships and propagates errors', async () => {
		const unrelated = { ...book(21), authors: [], series: null, tags: [] };
		await expect(loadRelated(unrelated)).resolves.toEqual({ byAuthor: [], similar: [] });
		expect(fetchMock).not.toHaveBeenCalled();
		fetchMock.mockImplementation(async () => json({ title: 'Unavailable' }, 503));
		await expect(loadRelated(book(21))).rejects.toMatchObject({ status: 503 });
	});
});
