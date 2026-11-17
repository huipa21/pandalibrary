import { describe, expect, it, vi } from 'vitest';
import type { BookFile } from '#lib/catalog/types.js';
import { cbzFixture } from './fixtures.js';
import { HttpRangeSource } from './source.js';
import { makeStreamedBook } from './streamed-book.js';

function file(format: string, size: number): BookFile {
	return {
		id: 31, format, size_bytes: size,
		download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}`,
		original_filename: `book.${format}`, created_at: ''
	};
}

describe('makeStreamedBook', () => {
	it('opens a CBZ through the range-backed ZIP loader', async () => {
		const data = new Uint8Array(cbzFixture());
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const header = new Headers(init?.headers).get('Range') ?? '';
			const match = /^bytes=(\d+)-(\d+)$/.exec(header);
			if (!match) throw new Error('The reader requested the whole file.');
			const start = Number(match[1]);
			const end = Math.min(Number(match[2]), data.length - 1);
			return new Response(data.slice(start, end + 1), {
				status: 206,
				headers: { 'Content-Range': `bytes ${start}-${end}/${data.length}` }
			});
		});
		const source = new HttpRangeSource(
			new URL(`http://books.test/api/v1/books/21/files/31?v=${'a'.repeat(64)}`),
			file('cbz', data.length),
			fetcher as typeof fetch
		);

		const book = await makeStreamedBook(source, 'cbz');
		expect(book.sections.length).toBeGreaterThan(0);
		expect(fetcher).toHaveBeenCalled();
		book.destroy?.();
		await expect(source.read(0, 1)).rejects.toThrow('closed');
	});
});
