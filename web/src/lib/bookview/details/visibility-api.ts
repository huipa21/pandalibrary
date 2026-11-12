import { api } from '#lib/api/client.js';
import type { Book } from '#lib/catalog/types.js';

export async function setBookVisibility(
	bookId: number,
	visibility: 'public' | 'private',
	signal?: AbortSignal
): Promise<Book> {
	const response = await api.request<{ book: Book }>(`/books/${bookId}/visibility`, {
		method: 'PUT',
		body: { visibility },
		signal
	});
	return response.book;
}
