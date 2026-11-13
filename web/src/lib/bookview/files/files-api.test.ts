import { describe, expect, it, vi } from 'vitest';
import type { ImportJob } from '#lib/admin/types.js';
import { uploadBookFile, waitForImport } from './files-api.js';

function job(status: string): ImportJob {
	return {
		id: 7, source: 'upload', library_id: 1, user_id: 1, original_name: 'b.pdf', sha256: null, status,
		error: null, book_id: status === 'imported' ? 21 : null, duplicate_of_book_id: null,
		created_at: '2026-11-14T00:00:00Z', finished_at: null
	};
}

describe('book file uploads', () => {
	it('posts only the file to the book attachment endpoint', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ job: job('pending') }), { status: 202 }));
		await expect(uploadBookFile(21, new File(['x'], 'b.pdf'), { fetcher })).resolves.toMatchObject({ id: 7 });
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe('/api/v1/books/21/files');
		expect([...(init?.body as FormData).keys()]).toEqual(['file']);
	});

	it('polls history until the job leaves the active states', async () => {
		const list = vi.fn()
			.mockResolvedValueOnce({ items: [job('processing')], next_cursor: null })
			.mockResolvedValueOnce({ items: [job('imported')], next_cursor: null });
		await expect(waitForImport(job('pending'), { interval: 0, list })).resolves.toMatchObject({ status: 'imported', book_id: 21 });
		expect(list).toHaveBeenCalledTimes(2);
	});
});
