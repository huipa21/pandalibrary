import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBookShelves } from '#lib/catalog/api.js';
import { getSessionViewer, removeBookFromShelf } from '#lib/shelves/api.js';
import type { SessionViewer, Shelf } from '#lib/shelves/types.js';
import { translate } from '#lib/paging/translate.js';
import { BookShelves } from './book-shelves.svelte.js';

vi.mock('#lib/catalog/api.js', () => ({ getBookShelves: vi.fn() }));
vi.mock('#lib/shelves/api.js', () => ({
	getSessionViewer: vi.fn(), removeBookFromShelf: vi.fn(),
	MAX_SHELF_NAME_BYTES: 1024, MAX_SHELF_DESCRIPTION_BYTES: 1 << 20
}));

const viewer: SessionViewer = { id: 1, username: 'reader', display_name: '', role: 'user' };
const shelf = (id: number, name = `Shelf ${id}`, extra: Partial<Shelf> = {}): Shelf => ({
	id, name, kind: 'private', owner_id: 1, description: null, created_by: 1,
	visible_book_count: 1, created_at: '', updated_at: '', mode: 'manual', ...extra
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let stores: BookShelves[];

function create(getId: () => number | null = () => 21) {
	const store = new BookShelves(getId);
	stores.push(store);
	store.reload();
	return store;
}

beforeEach(() => {
	stores = [];
	vi.stubGlobal('window', new EventTarget());
	vi.mocked(getSessionViewer).mockResolvedValue(viewer);
	vi.mocked(getBookShelves).mockResolvedValue([shelf(1)]);
	vi.mocked(removeBookFromShelf).mockResolvedValue();
});
afterEach(() => {
	stores.forEach((store) => store.destroy());
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});

describe('book shelf membership', () => {
	it('sorts Favorites first, then names, and loads the viewer once across reloads', async () => {
		vi.mocked(getBookShelves).mockResolvedValue([
			shelf(1, 'Zulu'), shelf(2, 'Alpha'), shelf(3, 'Favorites', { system_key: 'favorites' })
		]);
		const store = create();
		expect(store.status).toBe('loading');
		await settle();
		expect(store.memberIds).toEqual([3, 2, 1]);
		expect(store.status).toBe('ready');
		store.reload();
		await settle();
		expect(getSessionViewer).toHaveBeenCalledTimes(1);
	});

	it.each(['user', 'admin'])('enforces manual shelf permissions for %s', async (role) => {
		vi.mocked(getSessionViewer).mockResolvedValue({ ...viewer, role });
		const store = create();
		await settle();
		expect(store.canRemove(shelf(1))).toBe(true);
		expect(store.canRemove(shelf(2, 'Other private', { owner_id: 2 }))).toBe(role === 'admin');
		expect(store.canRemove(shelf(3, 'Shared', { kind: 'shared', owner_id: null }))).toBe(role === 'admin');
		expect(store.canRemove(shelf(4, 'Automatic', { mode: 'automatic' }))).toBe(false);
		expect(store.canRemove(shelf(5, 'Unshelved', { system_key: 'unshelved' }))).toBe(false);
		expect(store.canRemove(shelf(6, 'Favorites', { system_key: 'favorites' }))).toBe(true);
	});

	it('removes optimistically, broadcasts once, and ignores its own event', async () => {
		const store = create();
		const stop = store.listen();
		await settle();
		const changed = vi.fn();
		window.addEventListener('pandalibrary-shelves-changed', changed);
		const pending = deferred<void>();
		vi.mocked(removeBookFromShelf).mockReturnValue(pending.promise);
		const removal = store.remove(store.items[0]);
		expect(store.memberIds).toEqual([]);
		expect(removeBookFromShelf).toHaveBeenCalledExactlyOnceWith(1, 21);
		pending.resolve();
		await removal;
		expect(changed).toHaveBeenCalledTimes(1);
		expect(getBookShelves).toHaveBeenCalledTimes(1);
		stop();
	});

	it('restores a failed removal in sorted order and throws a translated error', async () => {
		vi.mocked(getBookShelves).mockResolvedValue([shelf(2, 'Zulu'), shelf(1, 'Alpha')]);
		const store = create();
		await settle();
		vi.mocked(removeBookFromShelf).mockRejectedValue(new TypeError('network'));
		await expect(store.remove(store.items[0])).rejects.toThrow(translate('shelves.error.connection'));
		expect(store.memberIds).toEqual([1, 2]);
	});

	it('aborts on book change and ignores late responses, even after returning to the same ID', async () => {
		let id = 21;
		const first = deferred<Shelf[]>();
		vi.mocked(getBookShelves).mockReturnValueOnce(first.promise);
		const store = create(() => id);
		const signal = vi.mocked(getBookShelves).mock.calls[0][1]!;
		id = 22;
		store.reload();
		await settle();
		expect(signal.aborted).toBe(true);
		expect(getBookShelves).toHaveBeenLastCalledWith(22, expect.any(AbortSignal));
		id = 21;
		store.reload();
		await settle();
		first.resolve([shelf(99)]);
		await settle();
		expect(store.memberIds).toEqual([1]);
		expect(getBookShelves).toHaveBeenLastCalledWith(21, expect.any(AbortSignal));
	});

	it('does not restore a failed old-book removal into the new book', async () => {
		let id = 21;
		const store = create(() => id);
		await settle();
		const pending = deferred<void>();
		vi.mocked(removeBookFromShelf).mockReturnValue(pending.promise);
		const removal = store.remove(store.items[0]);
		id = 22;
		vi.mocked(getBookShelves).mockResolvedValue([shelf(2)]);
		store.reload();
		await settle();
		pending.reject(new TypeError('network'));
		await expect(removal).rejects.toThrow();
		expect(store.memberIds).toEqual([2]);
	});

	it('reloads on external events and removes the event listener on cleanup', async () => {
		const store = create();
		const stop = store.listen();
		await settle();
		vi.mocked(getBookShelves).mockResolvedValue([shelf(2)]);
		window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
		await settle();
		expect(store.memberIds).toEqual([2]);
		stop();
		window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
		expect(getBookShelves).toHaveBeenCalledTimes(2);
	});

	it('does not let a reload resurrect an optimistically removed membership', async () => {
		const store = create();
		await settle();
		const pending = deferred<void>();
		vi.mocked(removeBookFromShelf).mockReturnValue(pending.promise);
		const removal = store.remove(store.items[0]);
		store.reload();
		await settle();
		expect(store.memberIds).toEqual([]);
		pending.resolve();
		await removal;
		expect(store.memberIds).toEqual([]);
	});

	it('refetches if a pre-removal response arrives after the DELETE succeeds', async () => {
		const store = create();
		await settle();
		const response = deferred<Shelf[]>();
		vi.mocked(getBookShelves).mockReturnValueOnce(response.promise).mockResolvedValue([]);
		store.reload();
		await store.remove(store.items[0]);
		response.resolve([shelf(1)]);
		await settle();
		expect(store.memberIds).toEqual([]);
		expect(store.status).toBe('ready');
		expect(getBookShelves).toHaveBeenCalledTimes(3);
	});

	it('retries a failed viewer request without granting removal rights before it succeeds', async () => {
		vi.mocked(getSessionViewer).mockRejectedValueOnce(new TypeError('network'));
		const store = create();
		await settle();
		expect(store.status).toBe('error');
		expect(store.canRemove(shelf(1))).toBe(false);
		store.reload();
		await settle();
		expect(store.status).toBe('ready');
		expect(store.canRemove(shelf(1))).toBe(true);
	});

	it('shows load errors, supports retry, and does not request a null book', async () => {
		vi.mocked(getBookShelves).mockRejectedValueOnce(new TypeError('network'));
		const store = create();
		await settle();
		expect(store.status).toBe('error');
		expect(store.error).toBe(translate('shelves.error.connection'));
		store.reload();
		await settle();
		expect(store.status).toBe('ready');
		const empty = create(() => null);
		expect(empty.status).toBe('ready');
		expect(empty.memberIds).toEqual([]);
		expect(getBookShelves).toHaveBeenCalledTimes(2);
	});

	it('rejects unauthorized removal without a DELETE', async () => {
		const store = create();
		await settle();
		await expect(store.remove(shelf(2, 'Shared', { kind: 'shared' }))).rejects.toThrow(translate('shelves.error.forbidden'));
		expect(removeBookFromShelf).not.toHaveBeenCalled();
	});
});
