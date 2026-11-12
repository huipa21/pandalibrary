import { afterEach, describe, expect, it, vi } from 'vitest';
import * as CFI from 'foliate-js/epubcfi.js';
import { BACKGROUNDS, withBackground } from './appearance.js';
import { FoliateReader, foliateStyles } from './foliate.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { ReaderAnnotation, ReaderEvents } from './types.js';

const engine = vi.hoisted(() => ({
	view: null as MockView | null,
	highlight: vi.fn(),
	underline: vi.fn(),
	strikethrough: vi.fn()
}));

class MockView extends EventTarget {
	style = {};
	shadowRoot = new EventTarget();
	renderer = { shadowRoot: new EventTarget() };
	isFixedLayout = false;
	open = vi.fn(async () => {});
	close = vi.fn();
	remove = vi.fn();
	clearSearch = vi.fn();
	getCFI = vi.fn((_index: number, _range?: Range) => 'epubcfi(/6/2!/4/2)');
	resolveNavigation = vi.fn(() => ({ index: 0 }));
	addAnnotation = vi.fn(async (annotation: unknown) => {
		this.dispatchEvent(new CustomEvent('draw-annotation', { detail: { annotation, draw: this.draw } }));
	});
	deleteAnnotation = vi.fn(async () => {});
	draw = vi.fn((shape, options) => shape([], options));
}

vi.mock('foliate-js/view.js', () => ({
	makeBook: async () => ({ sections: [{}] }),
	View: class extends MockView {
		constructor() {
			super();
			engine.view = this;
		}
	}
}));
vi.mock('foliate-js/overlayer.js', () => ({
	Overlayer: { highlight: engine.highlight, underline: engine.underline, strikethrough: engine.strikethrough }
}));
vi.mock('./safe-content.js', () => ({
	captureBookBlobs: async (load: () => unknown) => ({ value: await load(), blobs: new Map() }),
	isolateBookSections: vi.fn()
}));

function rectangle(left: number, top: number, width: number, height: number) {
	return { left, top, right: left + width, bottom: top + height, width, height };
}

class BookDocument extends EventTarget {
	documentElement = { style: { outline: '', outlineOffset: '' } };
	defaultView = Object.assign(new EventTarget(), { frameElement: null as unknown });
	rect = rectangle(10, 20, 50, 12);
	selection = {
		isCollapsed: false,
		rangeCount: 1,
		toString: () => 'Selected text',
		getRangeAt: vi.fn(() => ({
			startContainer: { nodeType: 3 }, endContainer: { nodeType: 3 },
			getBoundingClientRect: () => this.rect
		})),
		removeAllRanges: vi.fn(() => { this.selection.isCollapsed = true; })
	};
	getSelection = () => this.selection;
}

function frame(ownerDocument: BookDocument, rect = rectangle(100, 200, 400, 200)) {
	const root = Object.assign(new EventTarget(), {
		host: { getRootNode: () => ownerDocument }
	});
	return {
		ownerDocument, isConnected: true, offsetWidth: 200, offsetHeight: 100,
		clientLeft: 2, clientTop: 3, getBoundingClientRect: () => rect,
		root, getRootNode: () => root
	};
}

const readers: FoliateReader[] = [];

async function openEngine(format: 'epub' | 'cbz' = 'epub') {
	const outer = new BookDocument();
	const doc = new BookDocument();
	const iframe = frame(outer);
	doc.defaultView.frameElement = iframe;
	const events: ReaderEvents = {
		relocate: vi.fn(), selection: vi.fn(), activity: vi.fn(), keyboard: vi.fn(), error: vi.fn()
	};
	const reader = new FoliateReader({
		ownerDocument: outer, replaceChildren: vi.fn()
	} as unknown as HTMLElement, format, events);
	readers.push(reader);
	await reader.open(new Blob(['book']));
	const view = engine.view!;
	view.isFixedLayout = format === 'cbz';
	view.dispatchEvent(new CustomEvent('load', { detail: { doc, index: 0 } }));
	return { reader, view, doc, outer, iframe, events };
}

afterEach(async () => {
	await Promise.all(readers.splice(0).map((reader) => reader.destroy()));
	vi.clearAllMocks();
});

describe('Foliate current-page bookmarks', () => {
	it('resolves bookmark anchors against the visible range after reflow and excludes the next page boundary', async () => {
		const { reader, view, doc } = await openEngine();
		const start = { ownerDocument: doc };
		let targetOffset = 25;
		let targetIndex = 0;
		const visible = (from: number, to: number) => ({
			startContainer: start, startOffset: from,
			cloneRange: () => ({ startOffset: to, collapse: vi.fn() })
		});
		Object.assign(doc, {
			createRange: () => ({
				startOffset: 0,
				setStart(_node: unknown, offset: number) { this.startOffset = offset; },
				collapse: vi.fn(),
				compareBoundaryPoints(_how: number, other: { startOffset: number }) {
					return this.startOffset - other.startOffset;
				}
			})
		});
		view.resolveNavigation.mockImplementation((...args: unknown[]) => ({
			index: args[0] === 'epubcfi(/6/2!/4/2)' ? 0 : targetIndex,
			anchor: () => ({ startContainer: start, startOffset: targetOffset })
		}));
		const bookmark = { type: 'cfi' as const, value: 'epubcfi(/6/2!/4/4:25)' };
		const relocate = (from: number, to: number) => view.dispatchEvent(new CustomEvent('relocate', {
			detail: { cfi: 'epubcfi(/6/2!/4/2)', fraction: 0.2, range: visible(from, to) }
		}));
		relocate(20, 40);
		expect(reader.isOnCurrentPage(bookmark)).toBe(true);
		relocate(15, 30);
		expect(reader.isOnCurrentPage(bookmark)).toBe(true);
		targetOffset = 30;
		expect(reader.isOnCurrentPage(bookmark)).toBe(false);
		targetOffset = 14;
		expect(reader.isOnCurrentPage(bookmark)).toBe(false);
		targetOffset = 15;
		expect(reader.isOnCurrentPage(bookmark)).toBe(true);
		targetIndex = 1;
		expect(reader.isOnCurrentPage(bookmark)).toBe(false);
	});

	it('matches image-only fixed-layout bookmarks by resolved section and provides a page label', async () => {
		const { reader, view } = await openEngine('cbz');
		view.resolveNavigation.mockImplementation((...args: unknown[]) => ({
			index: args[0] === 'epubcfi(/6/4)' ? 1 : 0
		}));
		view.dispatchEvent(new CustomEvent('relocate', {
			detail: { cfi: 'epubcfi(/6/2)', fraction: 0.1, range: null }
		}));
		expect(reader.getBookmarkText()).toBe('Page 1');
		expect(reader.isOnCurrentPage({ type: 'cfi', value: 'epubcfi(/6/2!/4/2)' })).toBe(true);
		expect(reader.isOnCurrentPage({ type: 'cfi', value: 'epubcfi(/6/4)' })).toBe(false);
	});
});

describe('Foliate element-boundary selections', () => {
	for (const boundary of ['element', 'partial-start', 'partial-end'] as const) {
		it(`round-trips ${boundary} boundaries through the upstream CFI codec without changing native geometry`, async () => {
			const { reader, doc, view, events } = await openEngine();
			const restored = { setStart: vi.fn(), setEnd: vi.fn() };
			type FixtureNode = {
				nodeType: number; nodeValue: string | null; childNodes: FixtureNode[];
				parentNode: FixtureNode | null; ownerDocument: object;
			};
			const cfiDocument = {
				documentElement: null as FixtureNode | null,
				createRange: () => restored
			};
			const node = (nodeType: number, nodeValue: string | null, parentNode: FixtureNode | null): FixtureNode => {
				const value = { nodeType, nodeValue, parentNode, childNodes: [], ownerDocument: cfiDocument };
				parentNode?.childNodes.push(value);
				return value;
			};
			const html = node(1, null, null);
			cfiDocument.documentElement = html;
			const body = node(1, null, html);
			const paragraph = node(1, null, body);
			const first = node(3, 'First ', paragraph);
			const span = node(1, null, paragraph);
			const middle = node(3, 'middle', span);
			const last = node(3, ' last', paragraph);
			const start = boundary === 'partial-start' ? first : paragraph;
			const end = boundary === 'partial-end' ? middle : paragraph;
			const startOffset = boundary === 'partial-start' ? 2 : boundary === 'partial-end' ? 1 : 0;
			const endOffset = boundary === 'partial-end' ? 3 : boundary === 'partial-start' ? 2 : 3;
			const selectedNodes = boundary === 'partial-start' ? [first, middle]
				: boundary === 'partial-end' ? [middle] : [first, middle, last];
			const normalized = {
				startContainer: start, endContainer: end, startOffset, endOffset,
				setStart(container: FixtureNode, offset: number) {
					this.startContainer = container; this.startOffset = offset;
				},
				setEnd(container: FixtureNode, offset: number) {
					this.endContainer = container; this.endOffset = offset;
				}
			};
			const nativeRange = {
				startContainer: start, endContainer: end, startOffset, endOffset,
				commonAncestorContainer: paragraph,
				intersectsNode: (candidate: FixtureNode) => selectedNodes.includes(candidate),
				cloneRange: () => normalized,
				getBoundingClientRect: () => doc.rect
			};
			let next = 0;
			Object.assign(doc, { createTreeWalker: () => ({ nextNode: () => [first, middle, last][next++] ?? null }) });
			doc.selection.getRangeAt.mockReturnValue(nativeRange as unknown as ReturnType<typeof doc.selection.getRangeAt>);
			view.getCFI.mockImplementationOnce((_index, range) => CFI.fromRange(range!));
			doc.dispatchEvent(new Event('selectionchange'));
			expect(events.error).not.toHaveBeenCalled();
			const selected = vi.mocked(events.selection).mock.calls.at(-1)![0]!;
			expect(selected.text).toBe('Selected text');
			expect(selected.locator.type).toBe('cfi');
			if (selected.locator.type !== 'cfi') throw new Error('Expected text CFI');
			CFI.toRange(cfiDocument as unknown as Document, CFI.parse(selected.locator.value));
			expect(restored.setStart).toHaveBeenCalledWith(
				boundary === 'partial-end' ? middle : first, boundary === 'partial-start' ? 2 : 0
			);
			expect(restored.setEnd).toHaveBeenCalledWith(
				boundary === 'element' ? last : middle, boundary === 'partial-end' ? 3 : boundary === 'element' ? 5 : 6
			);
			expect(nativeRange.startContainer).toBe(start);
			expect(nativeRange.endContainer).toBe(end);
			expect(nativeRange.startOffset).toBe(startOffset);
			expect(nativeRange.endOffset).toBe(endOffset);
			expect(reader.getSelectionBounds()).toEqual(rectangle(124, 246, 100, 24));
		});
	}
});

describe('foliate appearance styles', () => {
	for (const preset of BACKGROUNDS) {
		it(`applies ${preset.id} colours and tone without overriding links`, () => {
			const styles = foliateStyles(withBackground({
				...DEFAULT_SETTINGS, font: 'system', size: 130, spacing: 1.8
			}, preset.id));
			expect(styles).toContain(`background: ${preset.page} !important`);
			expect(styles).toContain(`color: ${preset.text} !important`);
			expect(styles).toContain(`color-scheme: ${preset.tone}`);
			expect(styles).toContain('font-family: system-ui');
			expect(styles).toContain('font-size: 130%');
			expect(styles).toContain('line-height: 1.8');
			expect(styles).not.toMatch(/\ba\s*[{,]/);
		});
	}
});

describe('Foliate native selection geometry', () => {
	it('makes scaled, bordered iframe geometry available during selection events and updates it live', async () => {
		const { reader, doc, events, iframe } = await openEngine();
		vi.mocked(events.selection).mockImplementation((selection) => {
			if (selection) expect(reader.getSelectionBounds()).toEqual(rectangle(124, 246, 100, 24));
		});
		const updated = vi.fn();
		reader.subscribeSelection(updated);
		doc.dispatchEvent(new Event('selectionchange'));
		expect(events.selection).toHaveBeenCalledWith(expect.objectContaining({ text: 'Selected text' }));
		expect(updated).toHaveBeenCalledOnce();
		iframe.getBoundingClientRect = () => rectangle(50, 80, 200, 100);
		doc.rect = rectangle(5, 6, 40, 10);
		expect(reader.getSelectionBounds()).toEqual(rectangle(57, 89, 40, 10));
	});

	it('walks nested iframe windows even when the embedding frames live inside shadow roots', async () => {
		const { reader, doc, outer, iframe } = await openEngine();
		const middle = new BookDocument();
		iframe.ownerDocument = middle;
		middle.defaultView.frameElement = frame(outer, rectangle(20, 30, 100, 50));
		doc.dispatchEvent(new Event('mouseup'));
		expect(reader.getSelectionBounds()).toEqual(rectangle(83, 154.5, 50, 12));
	});

	it('returns null for collapsed, whitespace, zero-area and detached selections and clears book ranges', async () => {
		const { reader, doc, events, iframe } = await openEngine();
		doc.dispatchEvent(new Event('selectionchange'));
		doc.selection.toString = () => '  ';
		expect(reader.getSelectionBounds()).toBeNull();
		doc.selection.toString = () => 'Selected text';
		doc.rect = rectangle(0, 0, 0, 10);
		expect(reader.getSelectionBounds()).toBeNull();
		doc.rect = rectangle(10, 20, 50, 12);
		iframe.isConnected = false;
		expect(reader.getSelectionBounds()).toBeNull();
		iframe.isConnected = true;
		doc.selection.isCollapsed = true;
		doc.dispatchEvent(new Event('selectionchange'));
		expect(events.selection).toHaveBeenLastCalledWith(null);
		expect(reader.getSelectionBounds()).toBeNull();
		doc.selection.isCollapsed = false;
		doc.dispatchEvent(new Event('selectionchange'));
		const updated = vi.fn();
		reader.subscribeSelection(updated);
		reader.clearSelection();
		expect(doc.selection.removeAllRanges).toHaveBeenCalledOnce();
		expect(events.selection).toHaveBeenLastCalledWith(null);
		expect(updated).toHaveBeenCalledOnce();
		expect(reader.getSelectionBounds()).toBeNull();
	});

	it('notifies subscribers after events, on inner and shadow-root scrolling/resizing, with cleanup', async () => {
		const { reader, doc, view, outer, iframe, events } = await openEngine();
		const calls: string[] = [];
		const reasons = vi.fn();
		reader.subscribeSelection(reasons);
		vi.mocked(events.selection).mockImplementation(() => { calls.push('selection'); });
		const unsubscribe = reader.subscribeSelection(() => { calls.push('bounds'); });
		doc.dispatchEvent(new Event('selectionchange'));
		expect(calls).toEqual(['selection', 'bounds']);
		expect(reasons).toHaveBeenLastCalledWith(undefined);
		calls.length = 0;
		for (const target of [doc, view.shadowRoot, view.renderer.shadowRoot, outer, iframe.root]) {
			target.dispatchEvent(new Event('scroll'));
		}
		doc.defaultView.dispatchEvent(new Event('resize'));
		outer.defaultView.dispatchEvent(new Event('resize'));
		expect(calls).toEqual(Array(7).fill('bounds'));
		expect(reasons).toHaveBeenLastCalledWith('geometry');
		view.dispatchEvent(new CustomEvent('load', { detail: { doc: new BookDocument(), index: 1 } }));
		expect(calls).toHaveLength(8);
		expect(reasons).toHaveBeenLastCalledWith('geometry');
		unsubscribe();
		doc.dispatchEvent(new Event('scroll'));
		expect(calls).toHaveLength(8);
		const keyboard = vi.fn();
		const unsubscribeKeyboard = reader.subscribeSelectionKeyboard(keyboard);
		doc.dispatchEvent(new Event('keydown'));
		expect(keyboard).toHaveBeenCalledOnce();
		unsubscribeKeyboard();
		doc.dispatchEvent(new Event('keydown'));
		expect(keyboard).toHaveBeenCalledOnce();
		await reader.destroy();
		expect(reader.getSelectionBounds()).toBeNull();
		readers.splice(readers.indexOf(reader), 1);
	});
});

describe('Foliate annotation shapes', () => {
	it('adds a small note icon on the last text rect and removes it when the note is cleared', async () => {
		const { reader, view } = await openEngine();
		class Svg {
			style: Record<string, string> = {};
			listeners = new Map<string, (event: Event) => void>();
			attributes: Record<string, string> = {};
			children: Svg[] = [];
			ownerDocument = svgDocument;
			constructor(readonly tag: string) {}
			setAttribute(key: string, value: string) { this.attributes[key] = value; }
			append(...elements: Svg[]) { this.children.push(...elements); }
			addEventListener(name: string, listener: (event: Event) => void) { this.listeners.set(name, listener); }
		}
		const svgDocument = { createElementNS: (_namespace: string, tag: string): Svg => new Svg(tag) };
		const mark = new Svg('g');
		engine.highlight.mockReturnValue(mark);
		let painted: Svg | null = null;
		view.draw.mockImplementation((shape, options) => {
			painted = shape([rectangle(10, 20, 50, 12), rectangle(8, 40, 30, 12)], options);
		});
		const annotation: ReaderAnnotation = {
			id: 'commented', color: 'yellow', hasNote: true,
			locator: { type: 'cfi', value: 'epubcfi(/6/2!/4/2)' }
		};
		const openComment = vi.fn();
		reader.subscribeAnnotation(openComment);
		await reader.addAnnotation(annotation);
		expect(view.addAnnotation).toHaveBeenLastCalledWith(expect.objectContaining({ hasNote: true }));
		expect(painted!.children[0]).toBe(mark);
		expect(painted!.children[1]).toMatchObject({
			tag: 'svg', attributes: {
				x: '34', y: '32', width: '18', height: '18', 'data-annotation-note': 'true', role: 'button', tabindex: '0'
			}
		});
		painted!.children[1].listeners.get('click')!(new Event('click'));
		expect(openComment).toHaveBeenLastCalledWith('commented');
		const space = Object.assign(new Event('keydown'), { key: ' ' });
		painted!.children[1].listeners.get('keydown')!(space);
		expect(openComment).toHaveBeenCalledTimes(2);
		await reader.addAnnotation({ ...annotation, hasNote: false });
		expect(painted).toBe(mark);
	});

	for (const [style, shape] of [
		[undefined, engine.highlight], ['highlight', engine.highlight],
		['underline', engine.underline], ['strikeout', engine.strikethrough]
	] as const) {
		it(`uses the upstream ${style ?? 'default'} shape`, async () => {
			const { reader, view } = await openEngine();
			const element = { setAttribute: vi.fn() };
			shape.mockReturnValue(element);
			const annotation: ReaderAnnotation = {
				id: 'saved', color: 'yellow', style,
				locator: { type: 'cfi', value: 'epubcfi(/6/2!/4/2)' }
			};
			await reader.addAnnotation(annotation);
			expect(view.addAnnotation).toHaveBeenCalledWith({
				id: 'saved', value: 'epubcfi(/6/2!/4/2)', color: 'yellow', style
			});
			expect(shape).toHaveBeenCalledOnce();
			expect(shape).toHaveBeenCalledWith([], expect.objectContaining({ color: expect.any(String) }));
			expect(element.setAttribute).toHaveBeenCalledWith('data-annotation-style', style ?? 'highlight');
		});
	}

	it('keeps fixed comic-page outlines regardless of text annotation style', async () => {
		const { reader, view, doc } = await openEngine('cbz');
		const annotation: ReaderAnnotation = {
			id: 'page', color: 'yellow', style: 'strikeout',
			locator: { type: 'cfi', value: 'epubcfi(/6/2!/4/2)' }
		};
		await reader.addAnnotation(annotation);
		expect(doc.documentElement.style.outline).toMatch(/^4px solid /);
		expect(view.addAnnotation).not.toHaveBeenCalled();
		expect(engine.strikethrough).not.toHaveBeenCalled();
		await reader.removeAnnotation(annotation);
		expect(doc.documentElement.style.outline).toBe('');
	});
});
