import { api } from '#lib/api/client.js';
import type { Book } from '#lib/catalog/types.js';
import { InvalidMetadataResponseError } from './api.js';

export class InvalidTagsError extends Error {
	constructor(readonly reason: 'name' | 'duplicate' | 'limit') {
		super(reason);
	}
}

/** Use Go strings.TrimSpace's whitespace set, preserving BOM characters. */
export function trimSpace(value: string): string {
	return value.replace(/^[\u0009-\u000d \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
}

/** Match Go strings.TrimSpace and SQLite NOCASE, rather than Unicode case folding. */
export function normalizeTags(tags: readonly string[]): string[] {
	if (tags.length > 1000) throw new InvalidTagsError('limit');
	const seen = new Set<string>();
	return tags.map((tag) => {
		const name = trimSpace(tag);
		if (!name || new TextEncoder().encode(name).length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
			throw new InvalidTagsError('name');
		}
		const key = name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
		if (seen.has(key)) throw new InvalidTagsError('duplicate');
		seen.add(key);
		return name;
	});
}

export async function saveBookTags(bookId: number, tags: readonly string[]): Promise<Book> {
	const response = await api.request<{ book: Book }>(`/books/${bookId}`, {
		method: 'PATCH',
		body: { tags: normalizeTags(tags) }
	});
	if (!response?.book || response.book.id !== bookId) throw new InvalidMetadataResponseError();
	return response.book;
}
