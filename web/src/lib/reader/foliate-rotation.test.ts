import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoliateReader } from './foliate.js';
import type { ReaderEvents } from './types.js';

const engine = vi.hoisted(() => ({ view: null as MockView | null }));

class MockView extends EventTarget {
	style: Record<string, string> = {};
	renderer = {
		isConnected: true,
		getBoundingClientRect: vi.fn(() => rectangle(0, 0, 800, 600))
	};
	open = vi.fn(async () => {});
	close = vi.fn();
	remove = vi.fn();
	clearSearch = vi.fn();
	getCFI = vi.fn(() => 'epubcfi(/6/2!/4/2)');
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
vi.mock('foliate-js/overlayer.js', () => ({ Overlayer: {} }));
vi.mock('./safe-content.js', () => ({
	captureBookBlobs: async (load: () => unknown) => ({ value: await load(), blobs: new Map() }),
	isolateBookSections: vi.fn()
}));

function rectangle(left: number, top: number, width: number, height: number) {
	return { left, top, right: left + width, bottom: top + height, width, height };
}

class BookDocument extends EventTarget {
	defaultView = Object.assign(new EventTarget(), { frameElement: null as unknown });
	selection = {
		isCollapsed: false,
		rangeCount: 1,
		toString: () => 'Selected text',
		getRangeAt: () => ({
			startContainer: { nodeType: 3 }, endContainer: { nodeType: 3 },
			getBoundingClientRect: () => rectangle(10, 20, 50, 12)
		})
	};
	getSelection = () => this.selection;
}

const readers: FoliateReader[] = [];

async function open() {
	vi.stubGlobal('DOMRect', class {
		constructor(left: number, top: number, width: number, height: number) {
			return { x: left, y: top, ...rectangle(left, top, width, height) };
		}
	});
	let resized!: ResizeObserverCallback;
	const observer = { observe: vi.fn(), disconnect: vi.fn() };
	vi.stubGlobal('ResizeObserver', class {
		constructor(callback: ResizeObserverCallback) { resized = callback; }
		observe = observer.observe;
		disconnect = observer.disconnect;
	});
	const outer = new BookDocument();
	const container = {
		ownerDocument: outer, clientWidth: 800, clientHeight: 600,
		style: { backgroundColor: 'white' }, replaceChildren: vi.fn()
	};
	const events: ReaderEvents = {
		relocate: vi.fn(), selection: vi.fn(), activity: vi.fn(), keyboard: vi.fn(), error: vi.fn()
	};
	const reader = new FoliateReader(container as unknown as HTMLElement, 'epub', events);
	readers.push(reader);
	await reader.open(new Blob(['book']));
	const resize = () => resized([], observer as unknown as ResizeObserver);
	return { reader, view: engine.view!, container, outer, observer, resize };
}

afterEach(async () => {
	await Promise.all(readers.splice(0).map((reader) => reader.destroy()));
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('Foliate session-local rotation', () => {
	it('swaps the viewport on quarter turns and centers it without changing its container', async () => {
		const { reader, view, container } = await open();
		const originalContainer = { ...container };
		reader.rotate(90);
		expect(view.style).toMatchObject({
			width: '600px', height: '800px', position: 'relative',
			left: '100px', top: '-100px', transformOrigin: 'center center', transform: 'rotate(90deg)'
		});
		reader.rotate(90);
		expect(view.style).toMatchObject({
			width: '100%', height: '100%', left: '0px', top: '0px', transform: 'rotate(180deg)'
		});
		reader.rotate(90);
		expect(view.style).toMatchObject({ width: '600px', height: '800px', transform: 'rotate(270deg)' });
		reader.rotate(90);
		expect(view.style).toMatchObject({
			width: '100%', height: '100%', left: '0px', top: '0px', transform: 'rotate(0deg)'
		});
		reader.rotate(-90);
		expect(view.style.transform).toBe('rotate(270deg)');
		reader.rotate(90);
		expect(view.style.transform).toBe('rotate(0deg)');
		expect(container).toEqual(originalContainer);
		expect(container.replaceChildren).toHaveBeenCalledExactlyOnceWith(view);
	});

	it('recalculates dimensions and selection toolbar geometry when the container resizes', async () => {
		const { reader, view, container, observer, resize } = await open();
		const changed = vi.fn();
		reader.subscribeSelection(changed);
		expect(observer.observe).toHaveBeenCalledExactlyOnceWith(container);
		reader.rotate(-90);
		expect(changed).toHaveBeenLastCalledWith('geometry');
		container.clientWidth = 401;
		container.clientHeight = 703;
		resize();
		expect(view.style).toMatchObject({
			width: '703px', height: '401px', left: '-151px', top: '151px', transform: 'rotate(270deg)'
		});
		expect(changed).toHaveBeenCalledTimes(2);
		expect(changed).toHaveBeenLastCalledWith('geometry');
		container.clientWidth = 0;
		container.clientHeight = 0;
		resize();
		expect(view.style).toMatchObject({ width: '0px', height: '0px', left: '0px', top: '0px' });
		container.clientWidth = 800;
		container.clientHeight = 600;
		resize();
		expect(view.style).toMatchObject({ width: '600px', height: '800px', left: '100px', top: '-100px' });
	});

	it('disconnects on destroy, ignores queued resize callbacks, and does not carry orientation into a new session', async () => {
		const { reader, view, container, observer, resize } = await open();
		reader.rotate(90);
		const style = { ...view.style };
		const changed = vi.fn();
		reader.subscribeSelection(changed);
		await reader.destroy();
		container.clientWidth = 100;
		resize();
		expect(observer.disconnect).toHaveBeenCalledOnce();
		expect(view.style).toEqual(style);
		expect(changed).not.toHaveBeenCalled();
		expect(view.remove).toHaveBeenCalledOnce();
		expect(() => reader.rotate(90)).toThrow('The reader is not open.');
		const next = await open();
		next.reader.rotate(-90);
		expect(next.view.style.transform).toBe('rotate(270deg)');
	});

	it('uses the standard not-open error before initialization', () => {
		const reader = new FoliateReader({} as HTMLElement, 'epub', {} as ReaderEvents);
		expect(() => reader.rotate(90)).toThrow('The reader is not open.');
	});

	it('keeps Foliate fitting and pagination probes in logical coordinates and restores them on cleanup', async () => {
		const { reader, view, outer } = await open();
		const containerRect = vi.fn(() => rectangle(0, 0, 800, 600));
		const nativePageRect = rectangle(0, 0, 1600, 600);
		const pageRect = vi.fn(() => nativePageRect);
		const container = { isConnected: true, getBoundingClientRect: containerRect, parentElement: null };
		const page = { isConnected: true, getBoundingClientRect: pageRect, parentElement: container };
		const root = Object.assign(new EventTarget(), {
			host: view.renderer,
			getRootNode: () => outer
		});
		Object.assign(view.renderer, { getRootNode: () => outer });
		const frame = {
			ownerDocument: outer, isConnected: true, offsetWidth: 200, offsetHeight: 100,
			clientLeft: 2, clientTop: 3, getBoundingClientRect: () => rectangle(100, 200, 200, 400),
			getRootNode: () => root, parentElement: page
		};
		const nativeFrameRect = frame.getBoundingClientRect;
		const doc = new BookDocument();
		doc.defaultView.frameElement = frame;
		view.dispatchEvent(new CustomEvent('load', { detail: { doc, index: 0 } }));
		reader.rotate(90);
		expect(view.renderer.getBoundingClientRect()).toMatchObject({ width: 600, height: 800 });
		expect(container.getBoundingClientRect()).toMatchObject({ width: 600, height: 800 });
		expect(page.getBoundingClientRect()).toMatchObject({ width: 600, height: 1600 });
		const logical = page.getBoundingClientRect();
		expect(logical.right - logical.left).toBe(logical.width);
		expect(logical.bottom - logical.top).toBe(logical.height);
		expect((logical.left + logical.right) / 2).toBe(800);
		expect((logical.top + logical.bottom) / 2).toBe(300);
		expect(nativePageRect).toEqual(rectangle(0, 0, 1600, 600));
		expect(frame.getBoundingClientRect).toBe(nativeFrameRect);
		reader.rotate(90);
		expect(container.getBoundingClientRect()).toMatchObject({ width: 800, height: 600 });
		await reader.destroy();
		expect(container.getBoundingClientRect).toBe(containerRect);
		expect(page.getBoundingClientRect).toBe(pageRect);
		expect(view.renderer.getBoundingClientRect).toHaveBeenCalled();
		view.dispatchEvent(new CustomEvent('load', { detail: { doc, index: 0 } }));
		expect(container.getBoundingClientRect).toBe(containerRect);
		expect(page.getBoundingClientRect).toBe(pageRect);
	});
});

describe('Foliate rotated selection geometry', () => {
	for (const { angle, frameRect, expected } of [
		{ angle: 0, frameRect: rectangle(100, 200, 400, 200), expected: rectangle(124, 246, 100, 24) },
		{ angle: 90, frameRect: rectangle(100, 200, 200, 400), expected: rectangle(230, 224, 24, 100) },
		{ angle: 180, frameRect: rectangle(100, 200, 400, 200), expected: rectangle(376, 330, 100, 24) },
		{ angle: 270, frameRect: rectangle(100, 200, 200, 400), expected: rectangle(146, 476, 24, 100) }
	]) {
		it(`maps scaled, bordered frame selection corners through ${angle} degrees exactly once`, async () => {
			const { reader, view, outer } = await open();
			const doc = new BookDocument();
			doc.defaultView.frameElement = {
				ownerDocument: outer, isConnected: true, offsetWidth: 200, offsetHeight: 100,
				clientLeft: 2, clientTop: 3, getBoundingClientRect: () => frameRect,
				getRootNode: () => outer
			};
			view.dispatchEvent(new CustomEvent('load', { detail: { doc, index: 0 } }));
			doc.dispatchEvent(new Event('selectionchange'));
			for (let i = 0; i < angle / 90; i++) reader.rotate(90);
			expect(reader.getSelectionBounds()).toEqual(expected);
		});
	}

	it('composes nested frame scaling before applying the outer rotation', async () => {
		const { reader, view, outer } = await open();
		const middle = new BookDocument();
		const doc = new BookDocument();
		doc.defaultView.frameElement = {
			ownerDocument: middle, isConnected: true, offsetWidth: 200, offsetHeight: 100,
			clientLeft: 2, clientTop: 3, getBoundingClientRect: () => rectangle(100, 200, 400, 200),
			getRootNode: () => middle
		};
		middle.defaultView.frameElement = {
			ownerDocument: outer, isConnected: true, offsetWidth: 600, offsetHeight: 400,
			clientLeft: 4, clientTop: 5, getBoundingClientRect: () => rectangle(30, 40, 200, 300),
			getRootNode: () => outer
		};
		view.dispatchEvent(new CustomEvent('load', { detail: { doc, index: 0 } }));
		doc.dispatchEvent(new Event('selectionchange'));
		reader.rotate(90);
		expect(reader.getSelectionBounds()).toEqual(rectangle(92.5, 104, 12, 50));
		doc.selection.isCollapsed = true;
		expect(reader.getSelectionBounds()).toBeNull();
	});
});
