import { api, type JsonValue } from '#lib/api/client.js';
import type { DictionaryEntry } from '#lib/dictionary/types.js';

export type EntryKind = 'word' | 'phrase' | 'sentence' | 'passage';

export interface Wordbook {
	id: number;
	name: string;
	description: string;
	language?: string;
	meaning_language?: string;
	meaning_languages?: string[];
	cover_color?: string;
	cover_image?: string;
	entry_count: number;
	book_count: number;
	is_default: boolean;
	archived: boolean;
	created_at: string;
	updated_at: string;
}

export interface WordbookOptions { description?: string; language?: string; meaning_language?: string; meaning_languages?: string[]; cover_color?: string; cover_image?: string }

export interface EntrySource {
	book_id: number | null;
	book_file_id: number | null;
	book_title: string;
	locator: JsonValue;
	fraction: number;
	chapter?: string;
}

export interface WordbookEntry {
	id: number;
	wordbook_id: number;
	kind: EntryKind;
	text: string;
	definition: string;
	note: string;
	dictionary_entries: DictionaryEntry[];
	source: EntrySource;
	created_at: string;
	updated_at: string;
	dictionary_warning?: string;
}

export interface NewEntry {
	wordbook_id?: number;
	kind: EntryKind;
	text: string;
	definition?: string;
	note?: string;
	source: EntrySource;
	dictionary_entries?: DictionaryEntry[];
}

export interface WordbookExport {
	version: 1;
	wordbook: { name: string };
	entries: WordbookEntry[];
}

/** Window event (no payload) dispatched after wordbooks are created, archived, restored, or deleted. */
export const WORDBOOKS_CHANGED_EVENT = 'pandalibrary-wordbooks-changed';

export function notifyWordbooksChanged(target: EventTarget | undefined = globalThis.window): void {
	target?.dispatchEvent(new Event(WORDBOOKS_CHANGED_EVENT));
}

export function activeWordbookCount(books: readonly Pick<Wordbook, 'archived'>[]): number {
	return books.filter((book) => !book.archived).length;
}

export const wordbooks = {
	async list(): Promise<Wordbook[]> {
		const result = await api.request<{ wordbooks: Wordbook[] }>('/wordbooks');
		return result.wordbooks;
	},
	create(name: string, options: WordbookOptions = {}): Promise<Wordbook> {
		return api.request('/wordbooks', { method: 'POST', body: { name, ...options } });
	},
	update(id: number, changes: WordbookOptions & { name?: string; archived?: boolean }): Promise<Wordbook> {
		return api.request(`/wordbooks/${id}`, { method: 'PATCH', body: { ...changes } });
	},
	deleteBook(id: number, mergeIntoId?: number): Promise<void> {
		return api.request(`/wordbooks/${id}`, {
			method: 'DELETE',
			...(mergeIntoId === undefined ? {} : { body: { merge_into_id: mergeIntoId } })
		});
	},
	async bookEntries(bookId: number): Promise<WordbookEntry[]> {
		const result = await api.request<{ entries: WordbookEntry[] }>(`/books/${bookId}/words`);
		return result.entries;
	},
	async entries(id: number): Promise<WordbookEntry[]> {
		const result = await api.request<{ entries: WordbookEntry[] }>(`/wordbooks/${id}/entries`);
		return result.entries;
	},
	add(input: NewEntry): Promise<WordbookEntry> {
		return api.request('/wordbooks/entries', {
			method: 'POST',
			body: {
				...(input.wordbook_id === undefined ? {} : { wordbook_id: input.wordbook_id }),
				kind: input.kind,
				text: input.text,
				...(input.definition === undefined ? {} : { definition: input.definition }),
				...(input.note === undefined ? {} : { note: input.note }),
				...(input.dictionary_entries === undefined ? {} : {
					dictionary_entries: input.dictionary_entries.map((entry) => ({ ...entry }))
				}),
				source: { ...input.source }
			}
		});
	},
	edit(
		wordbookId: number,
		entryId: number,
		changes: { text?: string; definition?: string; note?: string; dictionary_entries?: DictionaryEntry[] }
	): Promise<WordbookEntry> {
		const { dictionary_entries, ...fields } = changes;
		return api.request(`/wordbooks/${wordbookId}/entries/${entryId}`, {
			method: 'PATCH',
			body: {
				...fields,
				...(dictionary_entries === undefined ? {} : {
					dictionary_entries: dictionary_entries.map((entry) => ({
						...entry,
						definitions: [...entry.definitions],
						...(entry.hiddenDefinitions === undefined ? {} : { hiddenDefinitions: [...entry.hiddenDefinitions] })
					}))
				})
			}
		});
	},
	remove(wordbookId: number, entryId: number): Promise<void> {
		return api.request(`/wordbooks/${wordbookId}/entries/${entryId}`, { method: 'DELETE' });
	},
	export(id: number): Promise<WordbookExport> {
		return api.request(`/wordbooks/${id}/export`);
	},
	import(id: number, file: Blob): Promise<{ imported: number }> {
		return api.request(`/wordbooks/${id}/import`, {
			method: 'POST',
			body: file,
			headers: { 'content-type': 'application/json' }
		});
	}
};
