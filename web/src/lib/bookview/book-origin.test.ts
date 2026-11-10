import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BOOK_ORIGIN_KEY,
	BOOK_ORIGIN_SCROLL_KEY,
	isBookArea,
	isBookChildFlow,
	originLabel,
	readBookOrigin,
	readOriginScroll,
	rememberBookOrigin,
	rememberOriginScroll
} from './book-origin.js';
import { rememberBrowseContext } from './browse-context.js';

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

describe('book area and child flows', () => {
	it('matches the book tabs but not the editor or other pages', () => {
		for (const path of ['/books/1', '/books/1/', '/books/1/files', '/books/1/activities', '/books/1/reading-log', '/books/abc']) {
			expect(isBookArea(path), path).toBe(true);
		}
		for (const path of ['/', '/books', '/books/', '/books/1/edit', '/books/1/edit/', '/read/1/2', '/shelves/1', '/bookshelf/1']) {
			expect(isBookArea(path), path).toBe(false);
		}
	});

	it('matches the reader and the metadata editor', () => {
		expect(isBookChildFlow('/read/1/10')).toBe(true);
		expect(isBookChildFlow('/read/1/10/extra')).toBe(true);
		expect(isBookChildFlow('/books/1/edit')).toBe(true);
		expect(isBookChildFlow('/books/1/edit/')).toBe(true);
		for (const path of ['/read', '/read/', '/read/1', '/books/1', '/books/1/files', '/books/1/editions', '/']) {
			expect(isBookChildFlow(path), path).toBe(false);
		}
	});

	it('limits child flows to one book when an ID is given', () => {
		expect(isBookChildFlow('/read/1/10', 1)).toBe(true);
		expect(isBookChildFlow('/books/1/edit', 1)).toBe(true);
		expect(isBookChildFlow('/read/2/10', 1)).toBe(false);
		expect(isBookChildFlow('/books/2/edit', 1)).toBe(false);
	});
});

describe('book origin', () => {
	it('stores and reads an origin with an optional label', () => {
		rememberBookOrigin('/books?q=dune&sort=title');
		expect(readBookOrigin()).toEqual({ href: '/books?q=dune&sort=title', label: null });
		rememberBookOrigin('/shelves/4', 'Sci-fi');
		expect(readBookOrigin()).toEqual({ href: '/shelves/4', label: 'Sci-fi' });
		rememberBookOrigin('/', '  ');
		expect(readBookOrigin()).toEqual({ href: '/', label: null });
	});

	it('ignores unsafe, book-area, child-flow and sign-in hrefs', () => {
		rememberBookOrigin('/shelves/1');
		for (const href of ['https://evil.example/', '//evil.example/', '/\\evil', 'books', '/books/2', '/books/2/files?x=1', '/books/2/edit', '/read/2/20', '/login?next=/', '/setup']) {
			rememberBookOrigin(href);
			expect(readBookOrigin(), href).toEqual({ href: '/shelves/1', label: null });
		}
	});

	it('validates the stored value', () => {
		for (const raw of ['{not json', 'null', '42', '{}', '{"href":"https://evil.example"}', '{"href":"/books/3"}', '{"href":"/read/3/4"}']) {
			storage.values.set(BOOK_ORIGIN_KEY, raw);
			expect(readBookOrigin(), raw).toBeNull();
		}
		storage.values.set(BOOK_ORIGIN_KEY, JSON.stringify({ href: '/search?q=x', label: 7 }));
		expect(readBookOrigin()).toEqual({ href: '/search?q=x', label: null });
	});

	it('swallows storage failures and works without storage', () => {
		storage.failWrites = true;
		expect(() => rememberBookOrigin('/books')).not.toThrow();
		expect(readBookOrigin()).toBeNull();

		vi.stubGlobal('sessionStorage', undefined);
		expect(() => rememberBookOrigin('/books')).not.toThrow();
		expect(readBookOrigin()).toBeNull();
	});
});

describe('origin scroll', () => {
	it('remembers the scroll position for one origin href', () => {
		rememberOriginScroll('/', 574.4);
		expect(readOriginScroll('/')).toBe(574);
		expect(readOriginScroll('/books')).toBeNull();
		rememberOriginScroll('/books?sort=added', 120);
		expect(readOriginScroll('/')).toBeNull();
		expect(readOriginScroll('/books?sort=added')).toBe(120);
	});

	it('ignores invalid positions, unsafe hrefs and bad stored values', () => {
		rememberOriginScroll('/', 300);
		for (const [href, y] of [['/', -1], ['/', Number.NaN], ['https://evil.example/', 10], ['/books/2', 10]] as const) {
			rememberOriginScroll(href, y);
			expect(readOriginScroll('/'), `${href} ${y}`).toBe(300);
		}
		for (const raw of ['{not json', 'null', '{"href":"/","y":"5"}', '{"href":"/","y":0}']) {
			storage.values.set(BOOK_ORIGIN_SCROLL_KEY, raw);
			expect(readOriginScroll('/'), raw).toBeNull();
		}
		storage.failWrites = true;
		expect(() => rememberOriginScroll('/', 10)).not.toThrow();
	});
});

describe('origin label', () => {
	it('prefers the browse-context label for the same href', () => {
		rememberBrowseContext({ ids: [1], label: 'Sci-fi', href: '/shelves/4' });
		expect(originLabel('/shelves/4')).toBe('Sci-fi');
		expect(originLabel('/shelves/5')).toBe('Shelf');
		rememberBrowseContext({ ids: [1], label: ' ', href: '/books' });
		expect(originLabel('/books')).toBe('All books');
	});

	it('always names the Dashboard, not its row', () => {
		rememberBrowseContext({ ids: [1], label: 'Recently Added', href: '/' });
		expect(originLabel('/')).toBe('Dashboard');
	});

	it('names the known routes', () => {
		expect(originLabel('/')).toBe('Dashboard');
		expect(originLabel('/books?sort=title')).toBe('All books');
		expect(originLabel('/search?q=x')).toBe('Search');
		expect(originLabel('/bookheap')).toBe('Bookheap');
		expect(originLabel('/bookmarks')).toBe('Bookmarks');
		expect(originLabel('/notes')).toBe('Annotations');
		expect(originLabel('/shelves/system/favorites')).toBe('Shelf');
		expect(originLabel('/authors/3')).toBe('Author');
		expect(originLabel('/series/3')).toBe('Series');
		expect(originLabel('/tags/3')).toBe('Tag');
		expect(originLabel('/library/1')).toBe('Library');
	});

	it('returns null for other routes', () => {
		for (const href of ['/shelves', '/authors', '/libraries', '/stats', '/read', '/settings/profile']) {
			expect(originLabel(href), href).toBeNull();
		}
	});
});
