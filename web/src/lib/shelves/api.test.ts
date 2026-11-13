import en from '../../../messages/en.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import {
	addBookToShelf,
	buildShelfBooksPath,
	buildSystemShelfBooksPath,
	buildShelvesPath,
	collectionLibraryID,
	createShelf,
	deleteShelf,
	getShelf,
	getSystemShelf,
	listAllShelves,
	listShelfBooks,
	listSystemShelfBooks,
	removeBookFromShelf,
	updateShelf
} from './api.js';
import { fieldErrorKey, isAdministrator, offersShelfManagement, shelfErrorKey, validateShelfDraft } from './form.js';
import type { Shelf } from './types.js';
import { selectedLibrary } from '#lib/libraries/context.js';

afterEach(() => vi.restoreAllMocks());

const shelf = (overrides: Partial<Shelf> = {}): Shelf => ({
	id: 7,
	kind: 'private',
	owner_id: 1,
	name: 'Favorites',
	description: null,
	created_by: 1,
	visible_book_count: 2,
	created_at: '2026-11-03T00:00:00Z',
	updated_at: '2026-11-03T00:00:00Z',
	...overrides
});
const reader = { id: 1, username: 'reader', display_name: 'Reader', role: 'user' };
const admin = { id: 9, username: 'admin', display_name: 'Admin', role: 'admin' };
const problem = (status: number) => new ApiError(status, '', '{}', { status });

describe('shelf API helpers', () => {
	it('defaults to global collections regardless of the previous library selection, preserving only explicit legacy filters', () => {
		selectedLibrary.set({ id: 2 });
		try {
			expect(collectionLibraryID(new URL('http://localhost/shelves/7'))).toBeUndefined();
			expect(collectionLibraryID(new URL('http://localhost/shelves/system/unshelved'))).toBeUndefined();
			expect(collectionLibraryID(new URL('http://localhost/shelves/7?library_id=3'))).toBe(3);
			expect(collectionLibraryID(new URL('http://localhost/shelves/7?library_id=bad'))).toBeNull();
			expect(collectionLibraryID(new URL('http://localhost/shelves/system/favorites?library_id=3'))).toBeUndefined();
			expect(collectionLibraryID(new URL('http://localhost/zh/shelves/system/favorites?library_id=3'))).toBeUndefined();
		} finally { selectedLibrary.set(null); }
	});

	it('serializes independent groups and explicit retain/remove decisions without dropping false', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ shelf: shelf() });
		const groups = [{ id: 'fiction', name: 'Fiction', rules: { match: 'any' as const, conditions: [{ field: 'title', op: 'contains', value: 'Novel' }] } }];
		await createShelf({ kind: 'private', name: 'Across libraries', description: null, rule_groups: groups });
		await updateShelf(7, { rule_groups: [], remove_rule_books: false });
		await updateShelf(7, { rule_groups: [], remove_rule_books: true });
		expect(request.mock.calls[0][1]?.body).toMatchObject({ rule_groups: groups });
		expect(request.mock.calls[1][1]?.body).toEqual({ rule_groups: [], remove_rule_books: false });
		expect(request.mock.calls[2][1]?.body).toEqual({ rule_groups: [], remove_rule_books: true });
	});

	it('uses the SH1 page envelope paths with verbatim cursors', () => {
		const cursor = 'b3BhcXVl/+==';
		expect(buildShelvesPath()).toBe('/shelves?limit=50');
		const params = new URLSearchParams(buildShelfBooksPath(4, { cursor, limit: 999 }).split('?')[1]);
		expect(buildShelfBooksPath(4).startsWith('/shelves/4/books?')).toBe(true);
		expect(params.get('cursor')).toBe(cursor);
		expect(params.get('limit')).toBe('100');
	});

	it('sends catalog filters and sort to collection and system book endpoints', () => {
		const options = { library_id: 2, author_id: 3, series_id: 4, tag_id: 5, sort: 'series' as const, cursor: 'next/+page' };
		for (const path of [buildShelfBooksPath(7, options), buildSystemShelfBooksPath('favorites', options)]) {
			const params = new URLSearchParams(path.split('?')[1]);
			expect(Object.fromEntries(params)).toEqual({
				limit: '50', cursor: 'next/+page', sort: 'series',
				library_id: '2', author_id: '3', series_id: '4', tag_id: '5'
			});
		}
		expect(new URLSearchParams(buildShelfBooksPath(7, { author_id: 3 }).split('?')[1]).get('sort')).toBe('title');
		expect(new URLSearchParams(buildShelfBooksPath(7, { library_id: 2 }).split('?')[1]).has('sort')).toBe(false);
	});

	it('sends the exact create, update, delete, and membership request shapes', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ shelf: shelf() });

		await createShelf({ kind: 'shared', name: 'Staff picks', description: null });
		await updateShelf(7, { description: null });
		await updateShelf(7, { name: 'Renamed' });
		await deleteShelf(7);
		await addBookToShelf(7, 21);
		await addBookToShelf(7, 21, 0);
		await removeBookFromShelf(7, 21);

		expect(request.mock.calls).toEqual([
			['/shelves', { method: 'POST', body: { kind: 'shared', name: 'Staff picks', description: null } }],
			['/shelves/7', { method: 'PATCH', body: { description: null } }],
			['/shelves/7', { method: 'PATCH', body: { name: 'Renamed' } }],
			['/shelves/7', { method: 'DELETE' }],
			['/shelves/7/books/21', { method: 'PUT', body: {} }],
			['/shelves/7/books/21', { method: 'PUT', body: { position: 0 } }],
			['/shelves/7/books/21', { method: 'DELETE' }]
		]);
	});

	it('follows every shelf-list cursor and stops on a repeated cursor', async () => {
		const request = vi
			.spyOn(api, 'request')
			.mockResolvedValueOnce({ items: [shelf({ id: 1 })], next_cursor: 'a' })
			.mockResolvedValueOnce({ items: [shelf({ id: 2 })], next_cursor: null });
		expect((await listAllShelves()).map((item) => item.id)).toEqual([1, 2]);
		expect(request.mock.calls[1][0]).toBe('/shelves?limit=100&cursor=a');

		request.mockReset();
		request.mockResolvedValue({ items: [], next_cursor: 'loop' });
		await expect(listAllShelves()).rejects.toThrow('repeated pagination cursor');
	});

	it('keeps library scope and cancellation on shelf metadata and book queries', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ shelf: shelf(), items: [], next_cursor: null });
		const signal = new AbortController().signal;
		await getShelf(7, { library_id: 2, signal });
		await getSystemShelf('unshelved', { library_id: 2, signal });
		await listShelfBooks(7, { library_id: 2, cursor: 'next/+page', signal });
		await listSystemShelfBooks('unshelved', { library_id: 2, signal });
		for (const [path, options] of request.mock.calls) {
			expect(new URLSearchParams(path.split('?')[1]).get('library_id')).toBe('2');
			expect(options?.signal).toBe(signal);
		}
		expect(new URLSearchParams(request.mock.calls[2][0].split('?')[1]).get('cursor')).toBe('next/+page');
	});

	it('retains the selected library on every shelf-list page', async () => {
		const request = vi.spyOn(api, 'request')
			.mockResolvedValueOnce({ items: [shelf({ id: 1 })], next_cursor: 'second' })
			.mockResolvedValueOnce({ items: [shelf({ id: 2 })], next_cursor: null });
		expect((await listAllShelves(undefined, { library_id: 2 })).map((item) => item.id)).toEqual([1, 2]);
		for (const [path] of request.mock.calls) {
			expect(new URLSearchParams(path.split('?')[1]).get('library_id')).toBe('2');
		}
	});
});

describe('shelf form and permission helpers', () => {
	it('validates names and descriptions against the SH1 limits', () => {
		expect(validateShelfDraft({ name: '  Favorites ', description: '   ' })).toEqual({
			ok: true,
			name: 'Favorites',
			description: null
		});
		expect(validateShelfDraft({ name: '   ', description: '' })).toEqual({ ok: false, error: 'name_required' });
		expect(validateShelfDraft({ name: '界'.repeat(342), description: '' })).toEqual({ ok: false, error: 'name_too_long' });
		expect(validateShelfDraft({ name: 'bad\nname', description: '' })).toEqual({ ok: false, error: 'name_invalid' });
		expect(validateShelfDraft({ name: 'x', description: 'x'.repeat((1 << 20) + 1) })).toEqual({
			ok: false,
			error: 'description_too_long'
		});
		for (const error of ['name_required', 'name_too_long', 'name_invalid', 'description_too_long'] as const) {
			expect(en).toHaveProperty([fieldErrorKey(error)]);
		}
	});

	it('offers management only for own private shelves unless the session is an administrator', () => {
		expect(offersShelfManagement(shelf(), reader)).toBe(true);
		expect(offersShelfManagement(shelf({ kind: 'shared', owner_id: null }), reader)).toBe(false);
		expect(offersShelfManagement(shelf({ owner_id: 2 }), reader)).toBe(false);
		expect(offersShelfManagement(shelf({ kind: 'shared', owner_id: null }), admin)).toBe(true);
		expect(offersShelfManagement(shelf(), null)).toBe(false);
		expect(isAdministrator(admin)).toBe(true);
		expect(isAdministrator(reader)).toBe(false);
	});

	it('maps CRUD and membership failures to localized messages without leaking existence', () => {
		expect(shelfErrorKey(problem(403), 'save')).toBe('shelves.error.forbidden');
		expect(shelfErrorKey(problem(404), 'load')).toBe('shelves.error.not_found');
		expect(shelfErrorKey(problem(404), 'add_book')).toBe('shelves.error.book_unavailable');
		expect(shelfErrorKey(problem(404), 'remove_book')).toBe('shelves.error.book_unavailable');
		expect(shelfErrorKey(problem(409), 'save')).toBe('shelves.error.conflict');
		expect(shelfErrorKey(problem(400), 'more_books')).toBe('shelves.error.stale');
		expect(shelfErrorKey(problem(400), 'more_shelves')).toBe('shelves.error.list_stale');
		expect(shelfErrorKey(problem(400), 'save')).toBe('shelves.error.invalid');
		expect(shelfErrorKey(problem(401), 'delete')).toBe('shelves.error.session');
		expect(shelfErrorKey(problem(503), 'delete')).toBe('shelves.error.api');
		expect(shelfErrorKey(new TypeError('offline'), 'load')).toBe('shelves.error.connection');

		const keys = [400, 401, 403, 404, 409, 503].flatMap((status) =>
			(['load', 'more_shelves', 'more_books', 'save', 'add_book'] as const).map((action) => shelfErrorKey(problem(status), action))
		);
		for (const key of new Set(keys)) expect(en).toHaveProperty([key]);
	});
});
