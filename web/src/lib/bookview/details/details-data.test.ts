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
vi.mock('../events.js', () => ({ notifyBookStateChanged: vi.fn() }));

import type { Book } from '#lib/catalog/types.js';
import { SyncError } from '#lib/reader/api.js';
import type { BookState, Note } from '#lib/reader/types.js';
import { offlineAvailable } from '#lib/sync/client.js';
import { readerState } from '#lib/sync/state.js';
import { notifyBookStateChanged } from '../events.js';
import type { ReadingSummary } from '../log-api.js';
import { loadDetailsState, loadRelated, saveReview } from './details-data.js';

const stamp = '2026-11-07T10:00:00Z';
const summary: ReadingSummary = {
	progress: 0.21, sessions: 1, total_seconds: 300, average_seconds: 300,
	active_days: 1, span_days: 1, first_read_at: stamp, last_read_at: stamp,
	pace_percent_per_hour: null, estimated_seconds_left: null,
	records: { longest_session: null, best_day: null, longest_streak_days: 1 },
	attempts: [], days: []
};
const emptyState: BookState = {
	user_book: null, progress: null, notes: [], highlights: [], bookmarks: []
};

function note(id: string, updatedAt: string, overrides: Partial<Note> = {}): Note {
	return {
		id, book_id: 21, highlight_id: null, body_md: id, created_at: stamp,
		updated_at: updatedAt, deleted_at: null, rev: 1, ...overrides
	};
}

function book(id: number, index: number | null = id): Book {
	return {
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
	vi.mocked(notifyBookStateChanged).mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('details state', () => {
	it('loads the summary and the newest live book-level note', async () => {
		const state: BookState = {
			...emptyState,
			notes: [
				note('old', '2026-11-05T00:00:00Z'),
				note('review', '2026-11-06T00:00:00Z'),
				note('highlight', '2026-11-08T00:00:00Z', { highlight_id: 'highlight' }),
				note('deleted', '2026-11-09T00:00:00Z', { deleted_at: stamp })
			]
		};
		fetchMock.mockImplementation(async (input) =>
			String(input).includes('reading-summary') ? json({ summary }) : json(state)
		);
		const controller = new AbortController();
		const result = await loadDetailsState(21, controller.signal);
		expect(result).toEqual({ userBook: null, progress: null, review: state.notes[1], summary });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
			'/api/v1/me/books/21',
			expect.stringContaining('/api/v1/me/books/21/reading-summary?timezone=')
		]));
		const summaryRequest = fetchMock.mock.calls.find(([url]) => String(url).includes('reading-summary'));
		expect(summaryRequest?.[1]?.signal).toBe(controller.signal);
	});

	it('uses synchronized offline data without requesting a summary', async () => {
		const offlineState: BookState = {
			...emptyState,
			user_book: {
				status: 'reading', rating: 7, started_at: Date.parse(stamp), finished_at: null,
				updated_at: stamp, rev: 0
			},
			notes: [note('offline', stamp)]
		};
		vi.mocked(readerState).mockResolvedValue({ state: offlineState, settings: [] });
		const result = await loadDetailsState(21, undefined, true);
		expect(readerState).toHaveBeenCalledWith(4, 21);
		expect(result).toMatchObject({
			userBook: { status: 'reading', rating: 7, started_at: '2026-11-07T10:00:00.000Z' },
			review: { body_md: 'offline' }, summary: null
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('overlays queued local changes on the online state', async () => {
		vi.mocked(offlineAvailable).mockReturnValue(true);
		const local = { ...emptyState, notes: [note('queued', stamp)] };
		vi.mocked(readerState).mockResolvedValue({ state: local, settings: [] });
		fetchMock.mockImplementation(async (input) =>
			String(input).includes('reading-summary') ? json({ summary }) : json(emptyState)
		);
		expect((await loadDetailsState(21)).review?.body_md).toBe('queued');
		expect(readerState).toHaveBeenCalledWith(4, 21, { state: emptyState, settings: [] });
	});

	it('propagates invalid state, API failures, and cancellation', async () => {
		fetchMock.mockImplementation(async (input) =>
			String(input).includes('reading-summary') ? json({ summary }) : json({ ...emptyState, user_book: {} })
		);
		await expect(loadDetailsState(21)).rejects.toThrow('Invalid user book state');
		fetchMock.mockImplementation(async () => json({ title: 'Unavailable' }, 503));
		await expect(loadDetailsState(21)).rejects.toMatchObject({ status: 503 });
		const controller = new AbortController();
		controller.abort();
		await expect(loadDetailsState(21, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
		await expect(loadDetailsState(0, undefined, true)).rejects.toThrow(RangeError);
	});
});

describe('review mutations', () => {
	it('creates a UUIDv7 note, edits it, and deletes it when cleared', async () => {
		fetchMock.mockImplementation(async () => json({ results: [{ index: 0, status: 'applied' }] }));
		await saveReview(21, null, 'A review');
		const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).mutations[0];
		expect(first).toMatchObject({
			entity: 'notes', op: 'upsert', data: { book_id: 21, highlight_id: null, body_md: 'A review' }
		});
		expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const existing = note(first.id, stamp);
		await saveReview(21, existing, 'Updated');
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).mutations[0]).toMatchObject({
			id: first.id, op: 'upsert', data: { body_md: 'Updated' }
		});
		await saveReview(21, existing, '   ');
		expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).mutations[0]).toMatchObject({
			id: first.id, op: 'delete', data: {}
		});
		expect(notifyBookStateChanged).toHaveBeenCalledTimes(3);
		expect(notifyBookStateChanged).toHaveBeenCalledWith(21);
	});

	it('reports rejected writes and validates review boundaries', async () => {
		fetchMock.mockResolvedValue(json({ results: [{ index: 0, status: 'rejected', reason: 'invalid' }] }));
		await expect(saveReview(21, null, 'Review')).rejects.toBeInstanceOf(SyncError);
		await expect(saveReview(21, null, 'x'.repeat(10_001))).rejects.toThrow(RangeError);
		await expect(saveReview(21, note('other', stamp, { book_id: 22 }), '')).rejects.toThrow(RangeError);
		await saveReview(21, null, '');
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(notifyBookStateChanged).not.toHaveBeenCalled();
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
