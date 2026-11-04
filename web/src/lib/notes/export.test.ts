import { describe, expect, it, vi } from 'vitest';
import {
	buildExportPath,
	ExportError,
	exportFormat,
	MAX_EXPORT_BOOKS,
	parseContentDispositionFilename,
	requestNotesExport,
	safeDownloadName,
	saveBlob,
	selectBooks,
	toggleBook
} from './export.js';

const range = (count: number, start = 1) => Array.from({ length: count }, (_, index) => start + index);

function response(body: BodyInit, status: number, headers: Record<string, string>): Response {
	return new Response(body, { status, headers });
}

describe('export selection', () => {
	it('toggles books and refuses to exceed the 100-book limit', () => {
		expect(toggleBook([], 5)).toEqual({ selection: [5], limited: false });
		expect(toggleBook([5, 6], 5)).toEqual({ selection: [6], limited: false });
		const full = range(MAX_EXPORT_BOOKS);
		expect(toggleBook(full, 101)).toEqual({ selection: full, limited: true });
		expect(toggleBook(full, 1).selection).toHaveLength(99);
	});

	it('selects distinct visible books in order, capped at the limit', () => {
		expect(selectBooks([3, 1, 3, 2])).toEqual({ selection: [3, 1, 2], limited: false });
		const many = selectBooks(range(150));
		expect(many.selection).toEqual(range(100));
		expect(many.limited).toBe(true);
	});

	it('uses Markdown for one book and ZIP for several', () => {
		expect(exportFormat(1)).toBe('markdown');
		expect(exportFormat(2)).toBe('zip');
	});

	it('builds the exact E1 route with exactly one book_ids parameter', () => {
		expect(buildExportPath([101])).toBe('/api/v1/me/notes/export?book_ids=101');
		const params = new URLSearchParams(buildExportPath([101, 104]).split('?')[1]);
		expect(params.getAll('book_ids')).toEqual(['101,104']);
		expect([...params.keys()]).toEqual(['book_ids']);
		expect(buildExportPath(range(100))).toContain('book_ids=1%2C2%2C');
		for (const invalid of [[], range(101), [1, 1], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
			expect(() => buildExportPath(invalid), JSON.stringify(invalid)).toThrow(RangeError);
		}
	});
});

describe('attachment filenames', () => {
	it('prefers RFC 5987 filename* for Unicode titles', () => {
		expect(parseContentDispositionFilename("attachment; filename*=utf-8''%E6%B2%99%E4%B8%98%20-%20%E5%BC%97%E5%85%B0%E5%85%8B.md")).toBe(
			'沙丘 - 弗兰克.md'
		);
		expect(parseContentDispositionFilename(`attachment; filename="fallback.md"; filename*=UTF-8''r%C3%A9sum%C3%A9.md`)).toBe('résumé.md');
		expect(parseContentDispositionFilename("attachment; filename*=iso-8859-1'en'caf%E9.md")).toBe('café.md');
	});

	it('reads quoted and token filenames, including escaped quotes and semicolons', () => {
		expect(parseContentDispositionFilename('attachment; filename="PandaLibrary notes 2026-11-03.zip"')).toBe('PandaLibrary notes 2026-11-03.zip');
		expect(parseContentDispositionFilename('attachment; filename="A \\"quoted\\"; title.md"')).toBe('A "quoted"; title.md');
		expect(parseContentDispositionFilename('attachment; filename=plain.md')).toBe('plain.md');
	});

	it('falls back when the header is missing or malformed', () => {
		expect(parseContentDispositionFilename(null)).toBeNull();
		expect(parseContentDispositionFilename('attachment')).toBeNull();
		expect(parseContentDispositionFilename("attachment; filename*=utf-8''%E0%A4%A")).toBeNull();
		expect(parseContentDispositionFilename("attachment; filename*=utf-8''%E0%A4%A; filename=ok.md")).toBe('ok.md');
	});

	it('preserves server names while removing path separators and control characters', () => {
		expect(safeDownloadName('Dune - Frank Herbert.md', 'x.md')).toBe('Dune - Frank Herbert.md');
		expect(safeDownloadName('../etc\\passwd\u0000.md', 'x.md')).toBe('.._etc_passwd.md');
		expect(safeDownloadName('..', 'x.md')).toBe('x.md');
		expect(safeDownloadName(null, 'x.md')).toBe('x.md');
	});
});

describe('requestNotesExport', () => {
	it('fetches with same-origin credentials, no caching, and redirect rejection', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response('# Dune', 200, {
				'content-type': 'text/markdown; charset=utf-8',
				'content-disposition': 'attachment; filename="Dune - Frank Herbert.md"'
			})
		);
		const result = await requestNotesExport([101], fetcher);

		expect(fetcher).toHaveBeenCalledWith('/api/v1/me/notes/export?book_ids=101', {
			credentials: 'same-origin',
			cache: 'no-store',
			redirect: 'error'
		});
		expect(result.filename).toBe('Dune - Frank Herbert.md');
		expect(result.format).toBe('markdown');
		expect(await result.blob.text()).toBe('# Dune');
	});

	it('downloads a ZIP for several books and falls back to a safe name', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(new Uint8Array([80, 75, 3, 4]), 200, { 'content-type': 'application/zip' }));
		const result = await requestNotesExport([101, 104], fetcher);

		expect(result.format).toBe('zip');
		expect(result.filename).toBe('PandaLibrary notes.zip');
		expect(result.blob.size).toBe(4);
	});

	it('turns problem responses into typed errors instead of downloads', async () => {
		const cases: [number, string][] = [
			[400, 'invalid'],
			[401, 'unauthorized'],
			[404, 'not_found'],
			[413, 'too_large'],
			[500, 'api']
		];
		for (const [status, kind] of cases) {
			const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
				response(JSON.stringify({ title: 'Problem', status, detail: 'Select between 1 and 100 distinct book IDs.' }), status, {
					'content-type': 'application/problem+json'
				})
			);
			const error = await requestNotesExport([1, 2], fetcher).catch((cause: unknown) => cause);
			expect(error, String(status)).toBeInstanceOf(ExportError);
			expect((error as ExportError).kind).toBe(kind);
		}
	});

	it('rejects successful responses that are not the expected export type', async () => {
		for (const contentType of ['application/problem+json', 'text/html', 'application/zip']) {
			const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('{"title":"x"}', 200, { 'content-type': contentType }));
			await expect(requestNotesExport([1], fetcher)).rejects.toMatchObject({ kind: 'unexpected' });
		}
	});

	it('reports network failures, including rejected redirects, as connection errors', async () => {
		const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
		await expect(requestNotesExport([1], fetcher)).rejects.toMatchObject({ kind: 'connection' });
	});

	it('validates the selection before sending a request', async () => {
		const fetcher = vi.fn<typeof fetch>();
		await expect(requestNotesExport(range(101), fetcher)).rejects.toThrow(RangeError);
		expect(fetcher).not.toHaveBeenCalled();
	});
});

describe('saveBlob', () => {
	it('clicks a temporary download link and revokes its object URL afterwards', () => {
		const anchor = { href: '', download: '', rel: '', hidden: false, click: vi.fn(), remove: vi.fn() };
		const document = { createElement: vi.fn(() => anchor), body: { append: vi.fn() } } as unknown as Document;
		const deferred: (() => void)[] = [];
		const revokeObjectURL = vi.fn();

		saveBlob(new Blob(['x']), 'Dune.md', {
			document,
			createObjectURL: () => 'blob:test',
			revokeObjectURL,
			defer: (callback) => deferred.push(callback)
		});

		expect(anchor).toMatchObject({ href: 'blob:test', download: 'Dune.md', hidden: true });
		expect(anchor.click).toHaveBeenCalledOnce();
		expect(anchor.remove).toHaveBeenCalledOnce();
		expect(revokeObjectURL).not.toHaveBeenCalled();
		deferred.forEach((callback) => callback());
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
	});

	it('still revokes the object URL when the click fails', () => {
		const document = {
			createElement: () => ({ click: () => { throw new Error('blocked'); }, remove: vi.fn() }),
			body: { append: vi.fn() }
		} as unknown as Document;
		const revokeObjectURL = vi.fn();

		expect(() => saveBlob(new Blob(['x']), 'a.md', { document, createObjectURL: () => 'blob:x', revokeObjectURL, defer: (callback) => callback() })).toThrow('blocked');
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
	});
});
