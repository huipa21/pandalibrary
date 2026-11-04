import { api, type JsonValue } from '#lib/api/client.js';
import { buildPagePath, MAX_PAGE_SIZE, type PageOptions } from '#lib/catalog/api.js';
import type { Book, Page } from '#lib/catalog/types.js';
import type { SessionViewer, Shelf, ShelfInput, ShelfPatch, RuleSet } from './types.js';

type RequestOptions = PageOptions & { signal?: AbortSignal };

export const MAX_SHELF_NAME_BYTES = 1024;
export const MAX_SHELF_DESCRIPTION_BYTES = 1 << 20;

export function buildShelvesPath(options: PageOptions = {}): string {
	return buildPagePath('/shelves', options);
}

export function buildShelfBooksPath(shelfID: number, options: PageOptions = {}): string {
	return buildPagePath(`/shelves/${shelfID}/books`, options);
}

export function buildSystemShelfPath(key: string, options: PageOptions = {}): string {
	return buildPagePath(`/shelves/system/${key}`, options);
}

export function buildSystemShelfBooksPath(key: string, options: PageOptions = {}): string {
	return buildPagePath(`/shelves/system/${key}/books`, options);
}

export async function listShelves(options: RequestOptions = {}): Promise<Page<Shelf>> {
	return api.request(buildShelvesPath(options), { signal: options.signal });
}

/** Collects every visible shelf, guarding against a repeated cursor. */
export async function listAllShelves(signal?: AbortSignal): Promise<Shelf[]> {
	const shelves: Shelf[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	do {
		const page: Page<Shelf> = await listShelves({ cursor, limit: MAX_PAGE_SIZE, signal });
		shelves.push(...page.items);
		cursor = page.next_cursor;
		if (cursor !== null) {
			if (seen.has(cursor)) throw new Error('The shelves API returned a repeated pagination cursor.');
			seen.add(cursor);
		}
	} while (cursor !== null);
	return shelves;
}

export async function getShelf(id: number): Promise<Shelf> {
	return (await api.request<{ shelf: Shelf }>(`/shelves/${id}`)).shelf;
}

export async function getSystemShelf(key: string): Promise<Shelf> {
	return (await api.request<{ shelf: Shelf }>(`/shelves/system/${key}`)).shelf;
}

export async function createShelf(input: ShelfInput): Promise<Shelf> {
	const body: Record<string, any> = {
		kind: input.kind,
		name: input.name,
		description: input.description
	};
	if (input.mode !== undefined) body.mode = input.mode;
	if (input.rules !== undefined) body.rules = input.rules;
	return (await api.request<{ shelf: Shelf }>('/shelves', { method: 'POST', body })).shelf;
}

export async function updateShelf(id: number, patch: ShelfPatch): Promise<Shelf> {
	const body: Record<string, any> = {};
	if (patch.name !== undefined) body.name = patch.name;
	if (patch.description !== undefined) body.description = patch.description;
	if (patch.rules !== undefined) body.rules = patch.rules;
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
