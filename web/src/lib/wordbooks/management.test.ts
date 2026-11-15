import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntrySource, WordbookEntry } from './api.js';
import { readPreferences, sortEntries, sourceHref, writePreferences } from './management.js';

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
	it('sorts alphabetically ignoring case, with chronological ties', () => {
		expect(sortEntries(entries, 'alphabetical').map((item) => item.id)).toEqual([2, 3, 1]);
	});
	it('breaks identical/invalid creation timestamps consistently', () => {
		expect(sortEntries([entry(1, 'a', 'invalid'), entry(2, 'a', 'invalid')], 'chronological').map((item) => item.id)).toEqual([2, 1]);
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
