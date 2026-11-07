import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BROWSE_CONTEXT_KEY,
	MAX_BROWSE_IDS,
	browseNeighbors,
	readBrowseContext,
	rememberBrowseContext
} from './browse-context.js';

class MemoryStorage implements Storage {
	values = new Map<string, string>();
	failWrites = false;
	get length() {
		return this.values.size;
	}
	clear() {
		this.values.clear();
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
	setItem(key: string, value: string) {
		if (this.failWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
		this.values.set(key, value);
	}
}

let storage: MemoryStorage;

beforeEach(() => {
	storage = new MemoryStorage();
	vi.stubGlobal('sessionStorage', storage);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('browse context', () => {
	it('returns neighbors with 1-based positions and null ends', () => {
		rememberBrowseContext({ ids: [5, 7, 9], label: 'All books', href: '/books?sort=title' });

		expect(browseNeighbors(5)).toEqual({ index: 1, total: 3, previousId: null, nextId: 7, label: 'All books', href: '/books?sort=title' });
		expect(browseNeighbors(7)).toMatchObject({ index: 2, previousId: 5, nextId: 9 });
		expect(browseNeighbors(9)).toMatchObject({ index: 3, previousId: 7, nextId: null });
	});

	it('handles a single-book list', () => {
		rememberBrowseContext({ ids: [3], label: 'Shelf', href: '/shelves/1' });
		expect(browseNeighbors(3)).toMatchObject({ index: 1, total: 1, previousId: null, nextId: null });
	});

	it('removes duplicates and invalid IDs, keeping the first occurrence', () => {
		rememberBrowseContext({ ids: [4, 2, 4, 0, -1, 1.5, Number.NaN, 2, 8], label: 'x', href: '/books' });
		expect(readBrowseContext()?.ids).toEqual([4, 2, 8]);
		expect(browseNeighbors(2)).toMatchObject({ index: 2, total: 3, previousId: 4, nextId: 8 });
	});

	it('returns null for a book outside the list, an invalid ID, or no stored list', () => {
		expect(browseNeighbors(1)).toBeNull();
		rememberBrowseContext({ ids: [1, 2], label: 'x', href: '/books' });
		expect(browseNeighbors(3)).toBeNull();
		expect(browseNeighbors(0)).toBeNull();
		expect(browseNeighbors(Number.NaN)).toBeNull();
	});

	it('ignores corrupt storage', () => {
		for (const raw of ['{not json', 'null', '42', '{"ids":"1,2","href":"/books"}', '{"ids":[1,2],"href":"https://evil.example"}', '{"ids":[1,2],"href":"//evil.example"}']) {
			storage.values.set(BROWSE_CONTEXT_KEY, raw);
			expect(readBrowseContext()).toBeNull();
			expect(browseNeighbors(1)).toBeNull();
		}
		storage.values.set(BROWSE_CONTEXT_KEY, JSON.stringify({ ids: [1, 'x', 2, 2], label: 7, href: '/books' }));
		expect(readBrowseContext()).toEqual({ ids: [1, 2], label: '', href: '/books' });
	});

	it('caps the list at the maximum size', () => {
		const ids = Array.from({ length: MAX_BROWSE_IDS + 50 }, (_, index) => index + 1);
		rememberBrowseContext({ ids, label: 'Many', href: '/books' });
		expect(readBrowseContext()?.ids).toHaveLength(MAX_BROWSE_IDS);
		expect(browseNeighbors(MAX_BROWSE_IDS)).toMatchObject({ index: MAX_BROWSE_IDS, total: MAX_BROWSE_IDS, nextId: null });
		expect(browseNeighbors(MAX_BROWSE_IDS + 1)).toBeNull();
	});

	it('rejects external origins and ignores write failures', () => {
		rememberBrowseContext({ ids: [1], label: 'x', href: 'https://evil.example/books' });
		expect(storage.values.has(BROWSE_CONTEXT_KEY)).toBe(false);

		storage.failWrites = true;
		expect(() => rememberBrowseContext({ ids: [1], label: 'x', href: '/books' })).not.toThrow();
		expect(browseNeighbors(1)).toBeNull();
	});

	it('works without session storage', () => {
		vi.stubGlobal('sessionStorage', undefined);
		expect(() => rememberBrowseContext({ ids: [1], label: 'x', href: '/books' })).not.toThrow();
		expect(browseNeighbors(1)).toBeNull();
	});
});
