import type { EntrySource, WordbookEntry } from './api.js';

export type EntryView = 'list' | 'cards';
export type EntrySort = 'chronological' | 'alphabetical';
export interface Preferences { view: EntryView; sort: EntrySort }

const defaults = (): Preferences => ({ view: 'list', sort: 'chronological' });
const preferenceKey = (id: number) => `pandalibrary.wordbooks.${id}.view`;

export function readPreferences(id: number): Preferences {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(preferenceKey(id)) ?? 'null');
		if (typeof stored !== 'object' || stored === null) return defaults();
		const value = stored as Record<string, unknown>;
		return {
			view: value.view === 'cards' ? 'cards' : 'list',
			sort: value.sort === 'alphabetical' ? 'alphabetical' : 'chronological'
		};
	} catch {
		return defaults();
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
