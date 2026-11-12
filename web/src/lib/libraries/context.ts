import { get, writable } from 'svelte/store';

export interface SelectedLibrary {
	readonly id: number;
	readonly name?: string;
}

// In-memory only: a new browser session starts without a library selection.
export const selectedLibrary = writable<SelectedLibrary | null>(null);

export function parseLibraryID(value: string | null): number | undefined {
	if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
	const id = Number(value);
	return Number.isSafeInteger(id) ? id : undefined;
}

export function selectLibrary(id: number): void {
	if (get(selectedLibrary)?.id !== id) selectedLibrary.set({ id });
}

export function shelfLibraryID(url: {
	readonly pathname: string;
	readonly searchParams: Pick<URLSearchParams, 'get' | 'has'>;
}): number | undefined | null {
	if (url.pathname.replace(/\/+$/, '') === '/shelves/system/favorites') return undefined;
	return url.searchParams.has('library_id')
		? parseLibraryID(url.searchParams.get('library_id')) ?? null
		: get(selectedLibrary)?.id;
}

export function libraryHref(path: string, libraryID: number | undefined): string {
	return libraryID === undefined ? path : `${path}?library_id=${libraryID}`;
}
