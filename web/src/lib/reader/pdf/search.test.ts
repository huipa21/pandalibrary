import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { PdfSearch } from './search.js';

let viewer: typeof import('pdfjs-dist/web/pdf_viewer.mjs');

beforeAll(async () => {
	// Only the find controller and event bus are instantiated. Supply the
	// browser globals read at module evaluation, without mocking its matcher.
	vi.stubGlobal('DOMMatrix', class {});
	vi.stubGlobal('pdfjsLib', await import('pdfjs-dist/legacy/build/pdf.mjs'));
	vi.stubGlobal('window', { requestAnimationFrame: (callback: () => void) => callback() });
	vi.stubGlobal('document', { documentElement: { style: {} }, createElement: () => ({ style: {} }) });
	vi.stubGlobal('navigator', { userAgent: '', platform: '', language: 'en-US' });
	viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
});

afterAll(() => vi.unstubAllGlobals());

function fixture(pages: { str: string; hasEOL?: boolean }[][], gate?: Promise<void>, failure?: Error) {
	const eventBus = new viewer.EventBus();
	const linkService = { page: 1, pagesCount: pages.length } as PDFLinkService;
	const search = new PdfSearch(viewer.PDFFindController, eventBus, linkService);
	const started = Promise.withResolvers<void>();
	const getTextContent = vi.fn(async (page: number) => {
		started.resolve();
		await gate;
		if (failure) throw failure;
		return { items: pages[page - 1] };
	});
	const document = {
		numPages: pages.length,
		getPage: async (page: number) => ({
			getTextContent: (options: unknown) => {
				expect(options).toEqual({ disableNormalization: true });
				return getTextContent(page);
			}
		} as unknown as PDFPageProxy)
	} as unknown as PDFDocumentProxy;
	search.controller.setDocument(document);
	return { search, eventBus, linkService, getTextContent, document, started: started.promise };
}

describe('PDF full-text search with the installed pdf.js controller', () => {
	it('returns exact original-text excerpts for normalized and multi-item matches', async () => {
		const { search, getTextContent } = fixture([
			[{ str: 'A café and a ﬁsh. ' }, { str: 'inter-', hasEOL: true }, { str: 'national fish.' }],
			[{ str: 'CAFÉ ﬁsh cafe\u0301' }]
		]);
		try {
			const cafes = await search.search('cafe');
			expect(cafes.map((result) => [result.page, result.excerpt.match])).toEqual([[1, 'café'], [2, 'CAFÉ'], [2, 'cafe\u0301']]);
			const fish = await search.search('fish');
			expect(fish.map((result) => result.excerpt.match)).toEqual(['ﬁsh', 'fish', 'ﬁsh']);
			const joined = await search.search('international');
			expect(joined).toHaveLength(1);
			expect(joined[0].excerpt).toEqual({ before: 'A café and a ﬁsh. ', match: 'inter-national', after: ' fish.' });
			expect(getTextContent).toHaveBeenCalledTimes(2);
			expect(await search.search('absent')).toEqual([]);
			expect(await search.search('  ')).toEqual([]);
		} finally { search.destroy(); }
	});

	it('navigates to the exact match, keeps highlight events scoped to pdf.js and invalidates old results', async () => {
		const { search, eventBus, linkService } = fixture([[{ str: 'one one' }], [{ str: 'one' }]]);
		const updates: unknown[] = [];
		eventBus.on('updatetextlayermatches', (event: unknown) => updates.push(event));
		try {
			const results = await search.search('one');
			await search.goToSearchResult(results[1]);
			expect(search.controller.selected).toEqual({ pageIdx: 0, matchIdx: 1 });
			await search.goToSearchResult(results[2]);
			expect(search.controller.selected).toEqual({ pageIdx: 1, matchIdx: 0 });
			expect(linkService.page).toBe(2);
			await search.goToSearchResult(results[2]);
			expect(search.controller.selected).toEqual({ pageIdx: 1, matchIdx: 0 });
			expect(updates).toContainEqual({ source: search.controller, pageIndex: 1 });
			search.clearSearch();
			await Promise.resolve();
			expect(search.controller.highlightMatches).toBe(false);
			await expect(search.goToSearchResult(results[0])).rejects.toThrow('no longer available');
		} finally { search.destroy(); }
	});

	it('rejects stale/aborted queries promptly and runs the latest query after extraction settles', async () => {
		const gate = Promise.withResolvers<void>();
		const { search } = fixture([[{ str: 'old new' }]], gate.promise);
		try {
			const old = search.search('old');
			const oldRejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
			const controller = new AbortController();
			const cancelled = search.search('old', controller.signal);
			const cancelledRejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
			controller.abort();
			await oldRejected;
			await cancelledRejected;
			const latest = search.search('new');
			gate.resolve();
			expect((await latest).map((result) => result.excerpt.match)).toEqual(['new']);
			const alreadyAborted = new AbortController();
			alreadyAborted.abort();
			await expect(search.search('new', alreadyAborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
		} finally { gate.resolve(); search.destroy(); }
	});

	it('reports extraction failures instead of returning misleading empty results', async () => {
		const error = new Error('broken page');
		const { search } = fixture([[{ str: 'text' }]], undefined, error);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await expect(search.search('text')).rejects.toThrow('Could not search PDF page 1');
			expect(logged).toHaveBeenCalled();
		} finally { search.destroy(); logged.mockRestore(); }
	});

	it('keeps the same document attached when PDFViewer repeats initialization and clears an active aborted search', async () => {
		const gate = Promise.withResolvers<void>();
		const { search, document, started } = fixture([[{ str: 'text' }]], gate.promise);
		const abort = new AbortController();
		const pending = search.search('text', abort.signal);
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await started;
		search.controller.setDocument(document);
		abort.abort();
		await rejected;
		gate.resolve();
		await Promise.resolve();
		expect(search.controller.highlightMatches).toBe(false);
		const results = await search.search('text');
		expect(results).toHaveLength(1);
		search.controller.setDocument(document);
		await search.goToSearchResult(results[0]);
		expect(search.controller.selected).toEqual({ pageIdx: 0, matchIdx: 0 });
		search.destroy();
	});

	it('settles pending searches on disposal and rejects subsequent use', async () => {
		const gate = Promise.withResolvers<void>();
		const { search } = fixture([[{ str: 'text' }]], gate.promise);
		const pending = search.search('text');
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		search.destroy();
		gate.resolve();
		await rejected;
		await expect(search.search('text')).rejects.toThrow('not open');
	});
});
