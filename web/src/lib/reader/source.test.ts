import { describe, expect, it, vi } from 'vitest';
import { BlobReader, TextWriter, ZipReader } from 'foliate-js/vendor/zip.js';
import type { BookFile } from '#lib/catalog/types.js';
import { epubFixture } from './fixtures.js';
import {
	HttpRangeSource,
	MAX_RANGE_FALLBACK_BYTES,
	RANGE_CHUNK_SIZE,
	ReaderSourceError
} from './source.js';

function file(size: number): BookFile {
	return {
		id: 31, format: 'pdf', size_bytes: size,
		download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}`,
		original_filename: 'book.pdf', created_at: ''
	};
}

function url() {
	return new URL(`http://books.test/api/v1/books/21/files/31?v=${'a'.repeat(64)}`);
}

function rangeFetch(data: Uint8Array) {
	return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const header = new Headers(init?.headers).get('Range') ?? '';
		const match = /^bytes=(\d+)-(\d+)$/.exec(header);
		if (!match) throw new Error(`missing range: ${header}`);
		const start = Number(match[1]);
		const end = Math.min(Number(match[2]), data.length - 1);
		return new Response(data.slice(start, end + 1), {
			status: 206,
			headers: { 'Content-Range': `bytes ${start}-${end}/${data.length}` }
		});
	});
}

describe('HttpRangeSource', () => {
	it('fetches aligned chunks, deduplicates in-flight reads and assembles arbitrary slices', async () => {
		const data = Uint8Array.from({ length: RANGE_CHUNK_SIZE * 2 + 17 }, (_, index) => index % 251);
		const fetcher = rangeFetch(data);
		const source = new HttpRangeSource(url(), file(data.length), fetcher as typeof fetch);

		const [first, second] = await Promise.all([
			source.read(10, 20),
			source.read(10, 20)
		]);
		expect([...first]).toEqual([...data.slice(10, 30)]);
		expect([...second]).toEqual([...first]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const init = fetcher.mock.calls[0][1]!;
		expect(new Headers(init.headers).get('If-Range')).toBe(`"${'a'.repeat(64)}"`);
		expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' });

		const crossing = await source.read(RANGE_CHUNK_SIZE - 3, 10);
		expect([...crossing]).toEqual([...data.slice(RANGE_CHUNK_SIZE - 3, RANGE_CHUNK_SIZE + 7)]);
		expect(fetcher).toHaveBeenCalledTimes(2);

		expect(await source.slice(5, 9).text()).toBe(new TextDecoder().decode(data.slice(5, 9)));
		expect(source.slice(5, 9).size).toBe(4);
		source.close();
	});

	it('uses a bounded full response when the server ignores Range', async () => {
		const data = new TextEncoder().encode('small pdf');
		const fetcher = vi.fn(async () => new Response(data, { status: 200 }));
		const source = new HttpRangeSource(url(), file(data.length), fetcher as typeof fetch);

		expect(new TextDecoder().decode(await source.read(2, 4))).toBe('all ');
		expect(fetcher).toHaveBeenCalledTimes(1);
		source.close();
	});

	it('refuses an ignored Range request for a large book', async () => {
		const fetcher = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
		const source = new HttpRangeSource(url(), file(MAX_RANGE_FALLBACK_BYTES + 1), fetcher as typeof fetch);

		await expect(source.read(0, 1)).rejects.toBeInstanceOf(ReaderSourceError);
		expect(fetcher).toHaveBeenCalledTimes(1);
		source.close();
	});

	it('rejects invalid content ranges and unavailable files', async () => {
		const invalid = vi.fn(async () => new Response(new Uint8Array([1]), {
			status: 206,
			headers: { 'Content-Range': 'bytes 4-4/10' }
		}));
		const invalidSource = new HttpRangeSource(url(), file(10), invalid as typeof fetch);
		await expect(invalidSource.read(0, 1)).rejects.toThrow('invalid range');
		invalidSource.close();

		const denied = vi.fn(async () => new Response(null, { status: 403 }));
		const deniedSource = new HttpRangeSource(url(), file(10), denied as typeof fetch);
		await expect(deniedSource.read(0, 1)).rejects.toMatchObject({ status: 403 });
		deniedSource.close();
	});

	it('acts as a BlobReader for the foliate ZIP reader without a full download', async () => {
		const data = new Uint8Array(epubFixture('Range Book'));
		const fetcher = rangeFetch(data);
		const source = new HttpRangeSource(url(), file(data.length), fetcher as typeof fetch);
		const reader = new ZipReader(new BlobReader(source));
		const entries = await reader.getEntries();
		expect(entries.map((entry) => entry.filename)).toContain('META-INF/container.xml');
		const container = entries.find((entry) => entry.filename === 'META-INF/container.xml');
		expect(container).toBeDefined();
		expect(await container!.getData<string>(new TextWriter())).toContain('rootfile');
		expect(fetcher.mock.calls.length).toBeLessThan(4);
		await reader.close();
		source.close();
	});
});
