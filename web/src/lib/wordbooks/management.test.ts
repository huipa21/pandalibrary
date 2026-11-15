import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntrySource, Wordbook, WordbookEntry } from './api.js';
import { filterEntries, filterWordbooks, involvedBookCount, readPreferences, readWordbookPreferences, sortEntries, sourceHref, writePreferences, writeWordbookPreferences, type WordbookSort } from './management.js';

afterEach(() => vi.unstubAllGlobals());

const source: EntrySource = {
	book_id: 21, book_file_id: 31, book_title: 'Stored title', chapter: 'Chapter 2',
	locator: { type: 'cfi', value: 'epubcfi(/6/4!/4/2:5)' }, fraction: .4
};
const entry = (id: number, text: string, created_at: string): WordbookEntry => ({
	id, text, created_at, updated_at: created_at, wordbook_id: 1, kind: 'word',
	definition: '', note: '', dictionary_entries: [], source
});

describe('entry sorting', () => {
	const entries = [
		entry(1, 'Zebra', '2026-11-01T00:00:00Z'),
		entry(2, 'apple', '2026-11-03T00:00:00Z'),
		entry(3, 'Apple', '2026-11-02T00:00:00Z')
	];
	it('uses creation time, not edit time, for newest first without mutating the input', () => {
		const input = entries.map((item) => ({ ...item, updated_at: item.id === 1 ? '2026-11-10T00:00:00Z' : item.updated_at }));
		expect(sortEntries(input, 'chronological').map((item) => item.id)).toEqual([2, 3, 1]);
		expect(input.map((item) => item.id)).toEqual([1, 2, 3]);
	});

	describe('collection search and categories', () => {
		const book = (id: number, name: string, description = '', archived = false): Wordbook => ({
			id, name, description, archived, entry_count: 0, book_count: 0,
			is_default: id === 1, created_at: '2026-11-01', updated_at: `2026-11-0${id}`
		});
		const books = [book(1, 'Vocabulary', 'Travel notes'), book(2, 'Passages notebook'), book(3, 'Archive', '', true)];
		const entries = {
			1: [{ ...entry(1, 'take off', '2026-11-01'), kind: 'phrase' as const, definition: 'depart' }],
			2: [{ ...entry(2, 'A journey.', '2026-11-02'), kind: 'sentence' as const, note: 'travel' }],
			3: [entry(3, 'archived term', '2026-11-03')]
		};
		it('searches notebook names and descriptions, not entry text, and respects archive settings', () => {
			expect(filterWordbooks(books, entries, 'wordbooks', 'TRAVEL', 'active', 'name-asc').map((book) => book.id)).toEqual([1]);
			expect(filterWordbooks(books, entries, 'wordbooks', 'depart', 'active', 'name-asc')).toEqual([]);
			expect(filterWordbooks(books, entries, 'wordbooks', '', 'all', 'recent').map((book) => book.id)).toEqual([3, 2, 1]);
			expect(filterWordbooks(books, entries, 'wordbooks', '', 'archived', 'recent').map((book) => book.id)).toEqual([3]);
			expect(filterWordbooks(books, entries, 'wordbooks', 'Travel', 'archived', 'recent')).toEqual([]);
			expect(filterWordbooks(books.slice(0, 2), entries, 'wordbooks', '', 'archived', 'recent')).toEqual([]);
		});
		it('finds notebooks by entry text/definition/note and category', () => {
			expect(filterWordbooks(books, entries, 'passages', ' travel ', 'active', 'name-asc').map((book) => book.id)).toEqual([2]);
			expect(filterWordbooks(books, entries, 'lexical', 'depart', 'active', 'name-asc').map((book) => book.id)).toEqual([1]);
			expect(filterWordbooks(books, entries, 'lexical', 'journey', 'active', 'name-asc')).toEqual([]);
			expect(filterEntries([...entries[1], ...entries[2]], 'passages', '').map((entry) => entry.id)).toEqual([2]);
		});
		it('counts distinct involved books without counting unavailable sources', () => {
			expect(involvedBookCount([
				entry(1, 'a', ''), entry(2, 'b', ''),
				{ ...entry(3, 'c', ''), source: { ...source, book_id: null } },
				{ ...entry(4, 'd', ''), source: { ...source, book_id: 22 } }
			])).toBe(2);
		});
	});
	it('sorts alphabetically ignoring case, with chronological ties', () => {
		expect(sortEntries(entries, 'alphabetical').map((item) => item.id)).toEqual([2, 3, 1]);
	});
	it('supports oldest-first and reverse alphabetical sorting', () => {
		expect(sortEntries(entries, 'chronological-asc').map((item) => item.id)).toEqual([1, 3, 2]);
		expect(sortEntries(entries, 'alphabetical-desc').map((item) => item.id)).toEqual([1, 2, 3]);
		expect(sortEntries([entry(1, 'a', 'invalid'), entry(2, 'a', 'invalid')], 'chronological-asc').map((item) => item.id)).toEqual([1, 2]);
	});
	it('breaks identical/invalid creation timestamps consistently', () => {
		expect(sortEntries([entry(1, 'a', 'invalid'), entry(2, 'a', 'invalid')], 'chronological').map((item) => item.id)).toEqual([2, 1]);
	});
});

describe('wordbook overview sorting', () => {
	const book = (id: number, name: string, created_at: string, updated_at: string): Wordbook => ({
		id, name, created_at, updated_at, description: '', archived: false,
		entry_count: 0, book_count: 0, is_default: id === 1
	});
	const books = [
		book(1, 'Zebra', '2026-11-02', '2026-11-02'),
		book(2, 'apple', '2026-11-01', '2026-11-04'),
		book(3, 'Middle', '2026-11-03', '2026-11-03')
	];
	it.each<[WordbookSort, number[]]>([
		['recent', [2, 3, 1]],
		['created-asc', [2, 1, 3]],
		['created-desc', [3, 1, 2]],
		['name-asc', [2, 3, 1]],
		['name-desc', [1, 3, 2]]
	])('sorts all notebooks by %s without pinning the default notebook', (sort, ids) => {
		expect(filterWordbooks(books, {}, 'wordbooks', '', 'active', sort).map((book) => book.id)).toEqual(ids);
		expect(books.map((book) => book.id)).toEqual([1, 2, 3]);
	});
	it('uses deterministic timestamp and name ties', () => {
		const tied = books.map((book) => ({ ...book, name: 'Same', created_at: 'invalid', updated_at: 'invalid' }));
		expect(filterWordbooks(tied, {}, 'wordbooks', '', 'all', 'recent').map((book) => book.id)).toEqual([3, 2, 1]);
		expect(filterWordbooks(tied, {}, 'wordbooks', '', 'all', 'created-asc').map((book) => book.id)).toEqual([1, 2, 3]);
		expect(filterWordbooks(tied, {}, 'wordbooks', '', 'all', 'name-desc').map((book) => book.id)).toEqual([3, 2, 1]);
	});
});

describe('overview preferences', () => {
	it('defaults to most recently modified active notebooks when storage is unavailable or malformed', () => {
		vi.stubGlobal('localStorage', undefined);
		expect(readWordbookPreferences()).toEqual({ view: 'cards', sort: 'recent', status: 'active' });
		vi.stubGlobal('localStorage', {
			getItem: () => '{broken',
			setItem: () => { throw new Error('QuotaExceededError'); }
		});
		expect(readWordbookPreferences()).toEqual({ view: 'cards', sort: 'recent', status: 'active' });
		expect(() => writeWordbookPreferences({ view: 'list', sort: 'name-desc', status: 'archived' })).not.toThrow();
	});
	it('migrates existing overview sorting, validates values, and isolates entry preferences', () => {
		const values = new Map<string, string>([['pandalibrary.wordbooks.0.view', '{"view":"list","sort":"alphabetical"}']]);
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value)
		});
		expect(readWordbookPreferences()).toEqual({ view: 'list', sort: 'name-asc', status: 'active' });
		writePreferences(1, { view: 'cards', sort: 'alphabetical' });
		writeWordbookPreferences({ view: 'list', sort: 'created-asc', status: 'archived' });
		expect(readWordbookPreferences()).toEqual({ view: 'list', sort: 'created-asc', status: 'archived' });
		expect(readPreferences(1)).toEqual({ view: 'cards', sort: 'alphabetical' });
		values.set('pandalibrary.wordbooks.0.view', '{"view":"obsolete","sort":"obsolete","status":"obsolete"}');
		expect(readWordbookPreferences()).toEqual({ view: 'cards', sort: 'recent', status: 'active' });
	});
});

describe('per-wordbook view preferences', () => {
	it('defaults safely during SSR and when storage access is denied', () => {
		vi.stubGlobal('localStorage', undefined);
		expect(readPreferences(1)).toEqual({ view: 'list', sort: 'chronological' });
		vi.stubGlobal('localStorage', { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } });
		expect(readPreferences(1)).toEqual({ view: 'list', sort: 'chronological' });
		expect(() => writePreferences(1, { view: 'cards', sort: 'alphabetical' })).not.toThrow();
	});
	it('isolates preferences and rejects malformed or obsolete values', () => {
		const values = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value)
		});
		writePreferences(1, { view: 'cards', sort: 'alphabetical' });
		expect(readPreferences(1)).toEqual({ view: 'cards', sort: 'alphabetical' });
		expect(readPreferences(2)).toEqual({ view: 'list', sort: 'chronological' });
		values.set('pandalibrary.wordbooks.1.view', '{broken');
		expect(readPreferences(1)).toEqual({ view: 'list', sort: 'chronological' });
		values.set('pandalibrary.wordbooks.1.view', '{"view":"obsolete","sort":"obsolete"}');
		expect(readPreferences(1)).toEqual({ view: 'list', sort: 'chronological' });
	});
	it.each(['chronological-asc', 'alphabetical-desc'] as const)('persists %s per wordbook', (sort) => {
		const values = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value)
		});
		writePreferences(1, { view: 'cards', sort });
		expect(readPreferences(1)).toEqual({ view: 'cards', sort });
		expect(readPreferences(2)).toEqual({ view: 'list', sort: 'chronological' });
	});
});

describe('reader source links', () => {
	it('preserves exact CFI and PDF rectangle locators, title/chapter snapshots untouched', () => {
		for (const locator of [source.locator, { type: 'pdf', page: 3, rects: [{ x: .2, y: .3, width: .1, height: .1 }] }]) {
			const url = new URL(sourceHref({ ...source, locator })!, 'https://reader.invalid');
			expect(url.pathname).toBe('/read/21/31');
			expect(JSON.parse(url.searchParams.get('locator')!)).toEqual(locator);
			expect(url.searchParams.get('fraction')).toBe('0.4');
		}
		expect(source.book_title).toBe('Stored title');
		expect(source.chapter).toBe('Chapter 2');
	});
	it('returns unavailable for deleted or invalid IDs rather than linking to an unrelated book', () => {
		for (const id of [null, 0, -1, 1.5]) {
			expect(sourceHref({ ...source, book_id: id })).toBeNull();
			expect(sourceHref({ ...source, book_file_id: id })).toBeNull();
		}
	});
	it('allows fraction-only navigation and guards non-finite/out-of-range fractions', () => {
		expect(sourceHref({ ...source, locator: null, fraction: .5 })).toBe('/read/21/31?fraction=0.5');
		expect(sourceHref({ ...source, locator: null, fraction: NaN })).toBe('/read/21/31');
		expect(sourceHref({ ...source, locator: null, fraction: 2 })).toBe('/read/21/31?fraction=1');
	});
});
