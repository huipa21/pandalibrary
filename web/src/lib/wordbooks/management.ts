import type { EntrySource, Wordbook, WordbookEntry } from './api.js';

export type EntryView = 'list' | 'cards';
export type EntrySort = 'chronological' | 'alphabetical';
export type Category = 'wordbooks' | 'lexical' | 'passages';
export interface Preferences { view: EntryView; sort: EntrySort }

const defaults = (view: EntryView = 'list'): Preferences => ({ view, sort: 'chronological' });
const preferenceKey = (id: number) => `pandalibrary.wordbooks.${id}.view`;

export function readPreferences(id: number, fallbackView: EntryView = 'list'): Preferences {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(preferenceKey(id)) ?? 'null');
		if (typeof stored !== 'object' || stored === null) return defaults(fallbackView);
		const value = stored as Record<string, unknown>;
		return {
			view: value.view === 'cards' || value.view === 'list' ? value.view : fallbackView,
			sort: value.sort === 'alphabetical' ? 'alphabetical' : 'chronological'
		};
	} catch {
		return defaults(fallbackView);
	}
}

export function writePreferences(id: number, preferences: Preferences): void {
	try {
		localStorage.setItem(preferenceKey(id), JSON.stringify(preferences));
	} catch {
		// Restricted storage must not prevent managing wordbooks.
	}
}

export function sortEntries(entries: readonly WordbookEntry[], sort: EntrySort): WordbookEntry[] {
	const newest = (a: WordbookEntry, b: WordbookEntry) =>
		(Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || b.id - a.id;
	return [...entries].sort(sort === 'alphabetical'
		? (a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: 'base' }) || newest(a, b)
		: newest);
}

export function lexicalEntry(entry: Pick<WordbookEntry, 'kind'>): boolean {
	return entry.kind === 'word' || entry.kind === 'phrase';
}

export function filterEntries(entries: readonly WordbookEntry[], category: Category, keyword: string): WordbookEntry[] {
	const query = keyword.trim().toLocaleLowerCase();
	return entries.filter((entry) => (category === 'wordbooks' || lexicalEntry(entry) === (category === 'lexical'))
		&& (!query || [entry.text, entry.definition, entry.note].some((text) => text.toLocaleLowerCase().includes(query))));
}

export function filterWordbooks(
	books: readonly Wordbook[], accessibleEntries: Readonly<Record<number, WordbookEntry[]>>,
	category: Category, keyword: string, showArchived: boolean, sort: EntrySort
): Wordbook[] {
	const query = keyword.trim().toLocaleLowerCase();
	const newest = (a: Wordbook, b: Wordbook) =>
		(Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) || b.id - a.id;
	return books.filter((book) => (showArchived || !book.archived) && (category === 'wordbooks'
		? !query || [book.name, book.description ?? ''].some((text) => text.toLocaleLowerCase().includes(query))
		: filterEntries(accessibleEntries[book.id] ?? [], category, query).length > 0))
		.sort(sort === 'alphabetical'
			? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || newest(a, b)
			: newest);
}

export function involvedBookCount(entries: readonly WordbookEntry[]): number {
	return new Set(entries.map((entry) => entry.source.book_id).filter((id) => id !== null)).size;
}

export function sourceHref(source: EntrySource): string | null {
	if (!Number.isSafeInteger(source.book_id) || !source.book_id || source.book_id < 1
		|| !Number.isSafeInteger(source.book_file_id) || !source.book_file_id || source.book_file_id < 1) return null;
	const params = new URLSearchParams();
	if (source.locator !== null) params.set('locator', JSON.stringify(source.locator));
	if (Number.isFinite(source.fraction)) params.set('fraction', String(Math.max(0, Math.min(1, source.fraction))));
	return `/read/${source.book_id}/${source.book_file_id}${params.size ? `?${params}` : ''}`;
}

export function downloadWordbook(name: string, data: unknown): void {
	const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'wordbook'}.json`;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
