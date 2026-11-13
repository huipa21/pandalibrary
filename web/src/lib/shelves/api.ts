import { api, type JsonValue } from '#lib/api/client.js';
import { buildPagePath, MAX_PAGE_SIZE, type PageOptions } from '#lib/catalog/api.js';
import type { Book, Page } from '#lib/catalog/types.js';
import type { SessionViewer, Shelf, ShelfInput, ShelfPatch, SystemShelf } from './types.js';
import { parseLibraryID } from '#lib/libraries/context.js';

/** Collections are global unless an old link explicitly requests a valid library filter. */
export function collectionLibraryID(url: { readonly pathname: string; readonly searchParams: Pick<URLSearchParams, 'get' | 'has'> }): number | undefined | null {
	if (url.pathname.replace(/\/+$/, '') === '/shelves/system/favorites') return undefined;
	return url.searchParams.has('library_id') ? parseLibraryID(url.searchParams.get('library_id')) ?? null : undefined;
}

export type ShelfOptions = PageOptions & { library_id?: number };
type RequestOptions = ShelfOptions & { signal?: AbortSignal };

export const MAX_SHELF_NAME_BYTES = 1024;
export const MAX_SHELF_DESCRIPTION_BYTES = 1 << 20;

function scopedPath(path: string, options: ShelfOptions): string {
	if (options.library_id === undefined) return path;
	return `${path}${path.includes('?') ? '&' : '?'}library_id=${encodeURIComponent(options.library_id)}`;
}

export function buildShelvesPath(options: ShelfOptions = {}): string {
	return scopedPath(buildPagePath('/shelves', options), options);
}

export function buildShelfBooksPath(shelfID: number, options: ShelfOptions = {}): string {
	return scopedPath(buildPagePath(`/shelves/${shelfID}/books`, options), options);
}

export function buildSystemShelfPath(key: string, options: ShelfOptions = {}): string {
	return scopedPath(buildPagePath(`/shelves/system/${key}`, options), options);
}

export function buildSystemShelfBooksPath(key: string, options: ShelfOptions = {}): string {
	return scopedPath(buildPagePath(`/shelves/system/${key}/books`, options), options);
}

export async function listShelves(options: RequestOptions = {}): Promise<Page<Shelf>> {
	return api.request(buildShelvesPath(options), { signal: options.signal });
}

/** Collects every visible shelf, guarding against a repeated cursor. */
export async function listAllShelves(signal?: AbortSignal, options: ShelfOptions = {}): Promise<Shelf[]> {
	const shelves: Shelf[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	do {
		const page: Page<Shelf> = await listShelves({ ...options, cursor, limit: MAX_PAGE_SIZE, signal });
		shelves.push(...page.items);
		cursor = page.next_cursor;
		if (cursor !== null) {
			if (seen.has(cursor)) throw new Error('The shelves API returned a repeated pagination cursor.');
			seen.add(cursor);
		}
	} while (cursor !== null);
	return shelves;
}

export async function getShelf(id: number, options: RequestOptions = {}): Promise<Shelf> {
	return (await api.request<{ shelf: Shelf }>(scopedPath(`/shelves/${id}`, options), { signal: options.signal })).shelf;
}

export async function getSystemShelf(key: string, options: RequestOptions = {}): Promise<SystemShelf> {
	return (await api.request<{ shelf: SystemShelf }>(scopedPath(`/shelves/system/${key}`, options), { signal: options.signal })).shelf;
}

export async function createShelf(input: ShelfInput): Promise<Shelf> {
	const body: Record<string, any> = {
		kind: input.kind,
		name: input.name,
		description: input.description
	};
	if (input.mode !== undefined) body.mode = input.mode;
	if (input.rules !== undefined) body.rules = input.rules;
	if (input.rule_groups !== undefined) body.rule_groups = input.rule_groups;
	return (await api.request<{ shelf: Shelf }>('/shelves', { method: 'POST', body })).shelf;
}

export async function updateShelf(id: number, patch: ShelfPatch): Promise<Shelf> {
	const body: Record<string, any> = {};
	if (patch.name !== undefined) body.name = patch.name;
	if (patch.description !== undefined) body.description = patch.description;
	if (patch.rules !== undefined) body.rules = patch.rules;
	if (patch.rule_groups !== undefined) body.rule_groups = patch.rule_groups;
	if (patch.remove_rule_books !== undefined) body.remove_rule_books = patch.remove_rule_books;
	return (await api.request<{ shelf: Shelf }>(`/shelves/${id}`, { method: 'PATCH', body })).shelf;
}

export async function deleteShelf(id: number): Promise<void> {
	await api.request<{ deleted: boolean }>(`/shelves/${id}`, { method: 'DELETE' });
}

export async function listShelfBooks(shelfID: number, options: RequestOptions = {}): Promise<Page<Book>> {
	return api.request(buildShelfBooksPath(shelfID, options), { signal: options.signal });
}

export async function listSystemShelfBooks(key: string, options: RequestOptions = {}): Promise<Page<Book>> {
	return api.request(buildSystemShelfBooksPath(key, options), { signal: options.signal });
}

/** Appends a visible book (or leaves an existing member in place) unless a position is given. */
export async function addBookToShelf(shelfID: number, bookID: number, position?: number): Promise<void> {
	const body: { [key: string]: JsonValue } = position === undefined ? {} : { position };
	await api.request<{ saved: boolean }>(`/shelves/${shelfID}/books/${bookID}`, { method: 'PUT', body });
}

export async function removeBookFromShelf(shelfID: number, bookID: number): Promise<void> {
	await api.request<{ removed: boolean }>(`/shelves/${shelfID}/books/${bookID}`, { method: 'DELETE' });
}

export async function getSessionViewer(): Promise<SessionViewer> {
	return (await api.request<{ user: SessionViewer }>('/auth/me')).user;
}
