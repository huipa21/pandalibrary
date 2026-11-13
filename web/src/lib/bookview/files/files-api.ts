import { listImports, problemFromResponse } from '#lib/admin/api.js';
import { isActiveImport } from '#lib/admin/jobs.js';
import type { ImportJob } from '#lib/admin/types.js';
import { api } from '#lib/api/client.js';
import type { Book } from '#lib/catalog/types.js';

/** Queues one file to be attached to an existing book as another format or edition. */
export async function uploadBookFile(bookId: number, file: File, { fetcher = fetch, signal }: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<ImportJob> {
	const form = new FormData();
	form.append('file', file, file.name);
	const response = await fetcher(`/api/v1/books/${bookId}/files`, { method: 'POST', body: form, signal });
	if (!response.ok) throw await problemFromResponse(response);
	return ((await response.json()) as { job: ImportJob }).job;
}

/** Polls import history until the job finishes; resolves with the finished job. */
export async function waitForImport(
	job: ImportJob,
	{ signal, interval = 1000, list = listImports }: { signal?: AbortSignal; interval?: number; list?: typeof listImports } = {}
): Promise<ImportJob> {
	let current = job;
	while (isActiveImport(current)) {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, interval);
			signal?.addEventListener('abort', () => {
				clearTimeout(timer);
				reject(signal.reason);
			}, { once: true });
		});
		signal?.throwIfAborted();
		const page = await list({ limit: 50, signal });
		current = page.items.find((item) => item.id === job.id) ?? current;
	}
	return current;
}

/** Marks a file as the book's default, or clears the default with null. */
export async function setDefaultFile(bookId: number, fileId: number | null, signal?: AbortSignal): Promise<Book> {
	const response = await api.request<{ book: Book }>(`/books/${bookId}/default-file`, {
		method: 'PUT',
		body: { file_id: fileId },
		signal
	});
	return response.book;
}
