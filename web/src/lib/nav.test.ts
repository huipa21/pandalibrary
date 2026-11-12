import en from '../../messages/en.json';
import zh from '../../messages/zh.json';
import { describe, expect, it } from 'vitest';
import { homeNavigation, homeNavigationFor, isActive, isImmersiveRoute, navigation, navigationFor } from './nav.js';

const item = (id: string) => [...homeNavigation, ...navigation].find((entry) => entry.id === id)!;

describe('navigationFor', () => {
	it('shows the admin entry only to administrators', () => {
		expect(navigationFor('admin').some((item) => item.id === 'admin')).toBe(true);
		expect(navigationFor('user').some((item) => item.id === 'admin')).toBe(false);
		expect(navigationFor(null).some((item) => item.id === 'admin')).toBe(false);
		expect(navigationFor('user').some((item) => item.id === 'libraries')).toBe(false);
	});

	it('keeps browse destinations without duplicating the Library group', () => {
		const hrefs = [...homeNavigation, ...navigationFor('admin')].map((entry) => entry.href);
		expect(hrefs).not.toContain('/libraries');
		for (const href of ['/authors', '/series', '/tags', '/read', '/notes', '/stats', '/admin']) {
			expect(hrefs).toContain(href);
		}
	});

	it('leaves search to the header search box', () => {
		const entries = [...homeNavigation, ...navigationFor('admin')];
		expect(entries.some((entry) => entry.id === 'search' || entry.href === '/search')).toBe(false);
	});

	it('does not expose a library-wide bookmarks destination', () => {
		for (const role of ['admin', 'user', null]) {
			const entries = [...homeNavigationFor(role), ...navigationFor(role)];
			expect(entries.some((entry) => entry.id === 'bookmarks' || entry.href === '/bookmarks')).toBe(false);
		}
	});
});

describe('homeNavigation', () => {
	it('lists Favorites under Home after All Books', () => {
		expect(homeNavigation.map((entry) => [entry.id, entry.href])).toEqual([
			['dashboard', '/'],
			['books', '/books'],
			['favorites', '/shelves/system/favorites'],
			['bookheap', '/bookheap'],
			['notes', '/notes']
		]);
	});

	it('shows Bookheap only to administrators', () => {
		expect(homeNavigationFor('admin').map((entry) => entry.id)).toEqual(['dashboard', 'books', 'favorites', 'bookheap', 'notes']);
		expect(homeNavigationFor('user').map((entry) => entry.id)).toEqual(['dashboard', 'books', 'favorites', 'notes']);
		expect(homeNavigationFor(null).some((entry) => entry.id === 'bookheap')).toBe(false);
	});
});

describe('isActive', () => {
	it('marks Dashboard only on the root path', () => {
		expect(isActive(item('dashboard'), '/')).toBe(true);
		expect(isActive(item('dashboard'), '/books')).toBe(false);
	});

	it('marks All Books on the list but not on individual book pages', () => {
		expect(isActive(item('books'), '/books')).toBe(true);
		expect(isActive(item('books'), '/books/')).toBe(true);
		expect(isActive(item('books'), '/books/21')).toBe(false);
		expect(isActive(item('books'), '/books/21/edit')).toBe(false);
	});

	it('marks section entries on their descendants without prefix collisions', () => {
		expect(isActive(item('authors'), '/authors/4')).toBe(true);
		expect(isActive(item('notes'), '/notes')).toBe(true);
		expect(isActive(item('notes'), '/notesxyz')).toBe(false);
		expect(isActive(item('admin'), '/admin/users')).toBe(true);
		expect(isActive(item('bookheap'), '/bookheap')).toBe(true);
		expect(isActive(item('bookheap'), '/books')).toBe(false);
	});
});

describe('isImmersiveRoute', () => {
	it('treats only an open reader as immersive', () => {
		expect(isImmersiveRoute('/read/21/31')).toBe(true);
		expect(isImmersiveRoute('/read')).toBe(false);
		expect(isImmersiveRoute('/books/21')).toBe(false);
	});
});

describe('bh4 translations', () => {
	it('defines the same non-empty Bookheap page keys in English and Chinese', () => {
		const keys = (messages: Record<string, string>) => Object.keys(messages).filter((key) => key.startsWith('bh4.'));
		expect(keys(en).length).toBeGreaterThan(0);
		expect(keys(zh).sort()).toEqual(keys(en).sort());
		for (const key of keys(zh)) expect((zh as Record<string, string>)[key].trim()).not.toBe('');
	});
});

describe('ux1 translations', () => {
	it('defines the same non-empty shell keys in English and Chinese', () => {
		const keys = (messages: Record<string, string>) => Object.keys(messages).filter((key) => key.startsWith('ux1.'));
		expect(keys(en).length).toBeGreaterThan(0);
		expect(keys(zh).sort()).toEqual(keys(en).sort());
		for (const key of keys(zh)) expect((zh as Record<string, string>)[key].trim()).not.toBe('');
	});
});
