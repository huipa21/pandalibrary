import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '#lib/api/client.js';
import type { BookFile } from '#lib/catalog/types.js';
import { downloadBookFile, pushMutation, SyncError, type Mutation } from './api.js';

const hash = 'a'.repeat(64);
const file: BookFile = {
	id: 3,
	format: 'epub',
	size_bytes: 10,
	download_url: `/api/v1/books/2/files/3?v=${hash}`
};
const mutation: Mutation = {
	entity: 'notes',
	id: 'id',
	op: 'upsert',
	data: { book_id: 2, body_md: 'note' },
	updated_at: 100
};

afterEach(() => vi.restoreAllMocks());

describe('reader API', () => {
	it('downloads only the catalog-provided same-origin hash-versioned URL', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('book'));
		const blob = await downloadBookFile(2, file, 'https://library.test', fetcher);
		expect(await blob.text()).toBe('book');
		expect(fetcher).toHaveBeenCalledWith(
			`https://library.test${file.download_url}`,
			{ credentials: 'same-origin', redirect: 'error', cache: 'no-store' }
		);
		for (const download_url of [
			'https://evil.test/book',
			'/api/v1/books/2/files/3',
			`/api/v1/books/2/files/4?v=${hash}`,
			`//evil.test/api/v1/books/2/files/3?v=${hash}`
		]) {
			await expect(downloadBookFile(2, { ...file, download_url }, 'https://library.test', fetcher))
				.rejects.toMatchObject({ name: 'InvalidFileUrlError' });
		}
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('surfaces file HTTP failures', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('missing', { status: 404 }));
		await expect(downloadBookFile(2, file, 'https://library.test', fetcher))
			.rejects.toMatchObject({ name: 'ApiError', status: 404 });
	});

	it('does not report rejected, stale, or malformed mutation responses as success', async () => {
		const request = vi.spyOn(api, 'request');
		request.mockResolvedValueOnce({ results: [{ index: 0, status: 'applied' }] });
		await expect(pushMutation(mutation)).resolves.toBeUndefined();
		expect(request).toHaveBeenCalledWith('/sync/push', expect.objectContaining({
			method: 'POST', body: { mutations: [mutation] }
		}));
		request.mockResolvedValueOnce({ results: [{ index: 0, status: 'rejected', reason: 'book is unavailable' }] });
		await expect(pushMutation(mutation)).rejects.toMatchObject({ status: 'rejected', reason: 'book is unavailable' });
		request.mockResolvedValueOnce({ results: [{ index: 0, status: 'stale' }] });
		await expect(pushMutation(mutation)).rejects.toBeInstanceOf(SyncError);
		request.mockResolvedValueOnce({ results: [] });
		await expect(pushMutation(mutation)).rejects.toMatchObject({ status: 'invalid' });
	});

	it('treats a stale retry of the same append-only session as idempotent', async () => {
		vi.spyOn(api, 'request').mockResolvedValue({ results: [{ index: 0, status: 'stale' }] });
		await expect(pushMutation({ ...mutation, entity: 'reading_sessions' })).resolves.toBeUndefined();
	});
});
