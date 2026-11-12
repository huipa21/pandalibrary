import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoliateBook, FoliateSearchResult } from 'foliate-js/view.js';
import { FoliateReader } from './foliate.js';
import type { ReaderEvents, ReflowableFormat } from './types.js';

const state = vi.hoisted(() => ({
	book: null as FoliateBook | null,
	views: [] as MockView[],
	isolate: (_book: FoliateBook) => {},
	search: async function* (_query: string, _view: MockView): AsyncGenerator<FoliateSearchResult> {}
}));

class MockView extends EventTarget {
	style = {};
	renderer = { parentNode: null };
	isFixedLayout = false;
	highlights = new Set<string>();
	annotations = new Set<string>();
	open = vi.fn(async () => {});
	close = vi.fn();
	remove = vi.fn();
	resolveNavigation = vi.fn(() => ({ index: 0 }));
	goTo = vi.fn(async () => ({ index: 0 }));
	clearSearch = vi.fn(() => this.highlights.clear());
	search = vi.fn(({ query }: { query: string }) => state.search(query, this));
	addAnnotation = vi.fn(async ({ value }: { value: string }) => { this.annotations.add(value); });
	deleteAnnotation = vi.fn(async ({ value }: { value: string }) => { this.annotations.delete(value); });
}

vi.mock('foliate-js/view.js', () => ({
	makeBook: vi.fn(async () => state.book),
	View: class extends MockView {
		constructor() {
			super();
			state.views.push(this);
		}
	}
}));

vi.mock('foliate-js/overlayer.js', () => ({ Overlayer: { highlight: vi.fn() } }));
vi.mock('./safe-content.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./safe-content.js')>();
	return { ...actual, isolateBookSections: (book: FoliateBook) => state.isolate(book) };
});

const cfi = 'epubcfi(/6/2!/4/2,/1:0,/1:4)';
const secondCfi = 'epubcfi(/6/4!/4/2,/1:0,/1:4)';
const match = { cfi, excerpt: { pre: 'Before ', match: 'text', post: ' after' } };
const events: ReaderEvents = {
	relocate: vi.fn(), selection: vi.fn(), activity: vi.fn(), keyboard: vi.fn(), error: vi.fn()
};
const readers: FoliateReader[] = [];

async function open(format: ReflowableFormat = 'epub') {
	const reader = new FoliateReader({ replaceChildren: vi.fn() } as unknown as HTMLElement, format, events);
	readers.push(reader);
	await reader.open(new Blob(['book']));
	return { reader, view: state.views.at(-1)! };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

beforeEach(() => {
	state.views = [];
	state.book = { sections: [{ load: () => 'unused' }, { load: () => 'unused' }], destroy: vi.fn() };
	state.isolate = () => {};
	state.search = async function* (_query, view) {
		yield { progress: 0.5 };
		view.highlights.add(cfi);
		yield { label: 'Chapter one', subitems: [match] };
		view.highlights.add(secondCfi);
		yield { label: 'Chapter two', subitems: [{ ...match, cfi: secondCfi }] };
		yield 'done';
	};
});

afterEach(async () => {
	await Promise.all(readers.splice(0).map((reader) => reader.destroy()));
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Foliate full-book search', () => {
	for (const format of ['epub', 'mobi', 'azw3', 'fb2', 'fbz'] as const) {
		it(`flattens native generator results and preserves excerpts and chapter labels for ${format}`, async () => {
			const { reader, view } = await open(format);
			const results = await reader.search(' text ');
			expect(view.search).toHaveBeenCalledWith({ query: 'text' });
			expect(results).toEqual([
				{ id: expect.any(String), excerpt: { before: 'Before ', match: 'text', after: ' after' }, label: 'Chapter one' },
				{ id: expect.any(String), excerpt: { before: 'Before ', match: 'text', after: ' after' }, label: 'Chapter two' }
			]);
			expect(new Set(results.map((result) => result.id)).size).toBe(2);
			expect(view.highlights).toEqual(new Set([cfi, secondCfi]));
			await reader.goToSearchResult(results[1]);
			expect(view.goTo).toHaveBeenCalledWith(secondCfi);
		});
	}

	it('clears only search outlines, leaves annotations intact, and rejects stale destinations', async () => {
		const { reader, view } = await open();
		await reader.addAnnotation({ id: 'saved', color: 'yellow', locator: { type: 'cfi', value: cfi } });
		const [result] = await reader.search('text');
		reader.clearSearch();
		expect(view.highlights.size).toBe(0);
		expect(view.annotations).toEqual(new Set([cfi]));
		expect(view.deleteAnnotation).not.toHaveBeenCalled();
		await expect(reader.goToSearchResult(result)).rejects.toThrow('no longer available');
		const [replacement] = await reader.search('text');
		expect(replacement.id).not.toBe(result.id);
		await expect(reader.goToSearchResult(result)).rejects.toThrow('no longer available');
		expect(await reader.search(' \n ')).toEqual([]);
		expect(view.highlights.size).toBe(0);
	});

	it('validates search destinations and reports failed navigation', async () => {
		const { reader, view } = await open();
		const [result] = await reader.search('text');
		view.resolveNavigation.mockReturnValueOnce({ index: 50 });
		await expect(reader.goToSearchResult(result)).rejects.toThrow('unavailable');
		expect(view.goTo).not.toHaveBeenCalled();
		view.goTo.mockResolvedValueOnce(undefined as never);
		await expect(reader.goToSearchResult(result)).rejects.toThrow('could not be opened');
	});

	it('serializes overlapping generators so late stale highlights cannot erase the new search', async () => {
		const { reader, view } = await open();
		const started = deferred();
		const gate = deferred();
		const finished = vi.fn();
		state.search = async function* (query, current) {
			try {
				if (query === 'old') {
					started.resolve();
					await gate.promise;
				}
				current.highlights.add(query);
				yield { label: query, subitems: [match] };
			} finally {
				finished(query);
			}
		};
		const old = reader.search('old');
		const oldRejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
		await started.promise;
		const latest = reader.search('new');
		expect(view.search).toHaveBeenCalledTimes(1);
		gate.resolve();
		await oldRejected;
		const results = await latest;
		expect(results[0].label).toBe('new');
		expect(view.highlights).toEqual(new Set(['new']));
		expect(finished.mock.calls).toEqual([['old'], ['new']]);
	});

	it('honors already-aborted and mid-flight signals and removes late outlines', async () => {
		const { reader, view } = await open();
		const controller = new AbortController();
		controller.abort();
		await expect(reader.search('text', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
		expect(view.search).not.toHaveBeenCalled();
		const started = deferred();
		const gate = deferred();
		state.search = async function* (_query, current) {
			started.resolve();
			await gate.promise;
			current.highlights.add(cfi);
			yield { label: '', subitems: [match] };
		};
		const active = new AbortController();
		const rejected = expect(reader.search('text', active.signal)).rejects.toMatchObject({ name: 'AbortError' });
		await started.promise;
		active.abort();
		gate.resolve();
		await rejected;
		expect(view.highlights.size).toBe(0);
	});

	it('cleans up partial results on generator failure and can search again', async () => {
		const { reader, view } = await open();
		state.search = async function* (_query, current) {
			current.highlights.add(cfi);
			yield { label: '', subitems: [match] };
			throw new Error('Bad chapter');
		};
		await expect(reader.search('text')).rejects.toThrow('Bad chapter');
		expect(view.highlights.size).toBe(0);
		state.search = async function* () { yield 'done'; };
		expect(await reader.search('nothing')).toEqual([]);
	});

	it('waits for cancelled native work before closing the view and destroying the book', async () => {
		const { reader, view } = await open();
		const started = deferred();
		const gate = deferred();
		state.search = async function* (_query, current) {
			started.resolve();
			await gate.promise;
			current.highlights.add(cfi);
			yield { label: '', subitems: [match] };
		};
		const rejected = expect(reader.search('text')).rejects.toMatchObject({ name: 'AbortError' });
		await started.promise;
		const destroyed = reader.destroy();
		expect(view.close).not.toHaveBeenCalled();
		expect(state.book!.destroy).not.toHaveBeenCalled();
		gate.resolve();
		await Promise.all([rejected, destroyed]);
		expect(view.highlights.size).toBe(0);
		expect(view.close).toHaveBeenCalledOnce();
		expect(state.book!.destroy).toHaveBeenCalledOnce();
		readers.splice(readers.indexOf(reader), 1);
	});

	it('searches captured isolated section markup, including cached pages, without fetching or using raw documents', async () => {
		const rawDocument = vi.fn();
		const markup = '<!doctype html><html><head></head><body><p>Safe text</p></body></html>';
		const urls: string[] = [];
		const unload = vi.fn();
		state.book!.sections[0].createDocument = rawDocument;
		state.isolate = (book) => {
			let cached: string | null = null;
			book.sections[0].load = () => {
				cached ??= URL.createObjectURL(new Blob([markup], { type: 'text/html' }));
				if (!urls.includes(cached)) urls.push(cached);
				return cached;
			};
			book.sections[0].unload = () => { cached = null; unload(); };
		};
		const parse = vi.fn((source: string) => ({ source }) as unknown as Document);
		vi.stubGlobal('DOMParser', class { parseFromString = parse; });
		const fetch = vi.fn(() => { throw new Error('Fetching book blobs is forbidden'); });
		vi.stubGlobal('fetch', fetch);
		try {
			await open();
			const section = state.book!.sections[0];
			await section.load!();
			await section.createDocument!();
			await section.createDocument!();
			section.unload!();
			await section.createDocument!();
			expect(parse).toHaveBeenCalledTimes(3);
			expect(parse).toHaveBeenCalledWith(markup, 'text/html');
			expect(rawDocument).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
			expect(unload).toHaveBeenCalledOnce();
			expect(urls).toHaveLength(2);
		} finally {
			for (const url of urls) URL.revokeObjectURL(url);
		}
	});
});
