import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoliateBook, FoliateRenderer } from 'foliate-js/view.js';
import { FoliateDisplay, forwardContinuousScrolling, pagePosition } from './foliate-display.js';
import { DEFAULT_SETTINGS } from './settings.js';

class Element extends EventTarget {
	style = { setProperty: vi.fn() } as Record<string, unknown> & { zoom?: string; setProperty: ReturnType<typeof vi.fn> };
	dataset = {};
	parentNode: Element | null = null;
	parentElement: Element | null = null;
	isConnected = true;
	append(...children: Element[]) {
		for (const child of children) { child.parentNode = this; child.parentElement = this; }
	}
	appendChild(child: Element) { this.append(child); return child; }
	addEventListener = super.addEventListener;
	remove = vi.fn();
	setAttribute = vi.fn();
	removeAttribute = vi.fn();
	getBoundingClientRect(): DOMRect { return new DOMRect(10, 20, 720, 600); }
}

function setup() {
	vi.stubGlobal('document', { createElement: () => new Element() });
	vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
	vi.stubGlobal('cancelAnimationFrame', vi.fn());
	vi.stubGlobal('DOMRect', class {
		constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
		get left() { return this.x; }
		get top() { return this.y; }
		get right() { return this.x + this.width; }
		get bottom() { return this.y + this.height; }
	});
	const host = { clientWidth: 1000, clientHeight: 900 };
	const contents: { doc: Document; index: number }[] = [];
	const renderer = Object.assign(new Element(), {
		getRootNode: () => ({ host }),
		getContents: () => contents,
		goTo: vi.fn(async () => {}), next: vi.fn(async () => {}), prev: vi.fn(async () => {}),
		setStyles: vi.fn(), destroy: vi.fn()
	});
	new Element().append(renderer);
	const display = new FoliateDisplay(renderer as unknown as FoliateRenderer,
		{ sections: [] } as unknown as FoliateBook, false, vi.fn(), vi.fn());
	const top = new Element();
	const container = new Element();
	const page = new Element();
	top.append(container);
	container.append(page);
	const visual = (width: number, height: number) => () => {
		const scale = Number(renderer.style.zoom) || 1;
		return new DOMRect(10, 20, width * scale, height * scale);
	};
	container.getBoundingClientRect = visual(670.5, 504.25);
	page.getBoundingClientRect = visual(2011.5, 504.25);
	const containerMeasurement = container.getBoundingClientRect;
	const pageMeasurement = page.getBoundingClientRect;
	const root = { host: renderer, querySelector: () => container };
	const frame = Object.assign(new Element(), { getRootNode: () => root });
	page.append(frame);
	const doc = { defaultView: { frameElement: frame } } as unknown as Document;
	const load = () => {
		contents.push({ doc, index: 0 });
		renderer.dispatchEvent(new CustomEvent('load', { detail: { doc, index: 0 } }));
	};
	return { display, renderer, host, load, container, page, frame, top, containerMeasurement, pageMeasurement };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Foliate pagination measurements', () => {
	it('keeps sizing and page strides logical through zoom and resize without altering iframe geometry', async () => {
		const { display, renderer, host, load, container, page, frame, top } = setup();
		await display.apply({ ...DEFAULT_SETTINGS, reflowZoom: 1.5 }, '');
		const frameMeasurement = frame.getBoundingClientRect;
		load();
		expect(renderer.style.height).toBe('600px');
		expect(container.getBoundingClientRect()).toMatchObject({ width: 670.5, height: 504.25 });
		expect(page.getBoundingClientRect()).toMatchObject({ width: 2011.5, height: 504.25 });
		expect(frame.getBoundingClientRect).toBe(frameMeasurement);
		expect(top.style.setProperty).toHaveBeenLastCalledWith('--_max-column-count-portrait', '1');
		host.clientHeight = 601;
		await display.apply({ ...DEFAULT_SETTINGS, reflowZoom: 0.75, reflowLayout: 'split' }, '');
		expect(renderer.style.height).toBe(`${601 / 0.75}px`);
		expect(container.getBoundingClientRect()).toMatchObject({ width: 670.5, height: 504.25 });
		const rect = page.getBoundingClientRect();
		expect(rect.right - rect.left).toBe(rect.width);
		expect(rect.bottom - rect.top).toBe(rect.height);
		expect(top.style.setProperty).toHaveBeenLastCalledWith('--_max-column-count-portrait', '2');
		renderer.destroy();
	});

	it('reflows the paginated page into a narrow zoomed viewport instead of overflowing sideways', async () => {
		const { display, renderer, host } = setup();
		host.clientWidth = 360;
		host.clientHeight = 640;
		await display.apply({ ...DEFAULT_SETTINGS, reflowZoom: 1.5 }, '');
		expect(renderer.style.width).toBe('240px');
		expect(Number.parseFloat(String(renderer.style.height))).toBeCloseTo(640 / 1.5);
		expect(Number.parseFloat(String(renderer.style.width)) * 1.5).toBeLessThanOrEqual(host.clientWidth);
		renderer.destroy();
	});

	it('restores existing measurement overrides and removes inherited overrides on teardown', async () => {
		const { display, renderer, load, container, page, top, containerMeasurement, pageMeasurement } = setup();
		await display.apply({ ...DEFAULT_SETTINGS, reflowZoom: 2 }, '');
		load();
		expect(container.getBoundingClientRect).not.toBe(containerMeasurement);
		expect(page.getBoundingClientRect).not.toBe(pageMeasurement);
		expect(Object.hasOwn(top, 'getBoundingClientRect')).toBe(true);
		// Rotation cleanup can restore an ancestor before the display is destroyed.
		const restoredRotationMeasurement = () => new DOMRect(1, 2, 3, 4);
		page.getBoundingClientRect = restoredRotationMeasurement;
		renderer.destroy();
		expect(container.getBoundingClientRect).toBe(containerMeasurement);
		expect(page.getBoundingClientRect).toBe(restoredRotationMeasurement);
		expect(Object.hasOwn(top, 'getBoundingClientRect')).toBe(false);
	});
});

describe('Foliate page metadata', () => {
	it('maps paginator fractions and sizes to per-section page numbers', () => {
		expect(pagePosition({ fraction: 0, size: 1 / 4 })).toEqual({ page: 1, pageCount: 4 });
		expect(pagePosition({ fraction: 1 / 4, size: 1 / 4 })).toEqual({ page: 2, pageCount: 4 });
		expect(pagePosition({ fraction: 1, size: 1 / 4 })).toEqual({ page: 4, pageCount: 4 });
		expect(pagePosition({ fraction: 1 / 2, size: 1 / 2 })).toEqual({ page: 2, pageCount: 2 });
		expect(pagePosition({ fraction: 0, size: 1 })).toEqual({ page: 1, pageCount: 1 });
	});

	it('rejects details that are not pagination metadata', () => {
		expect(pagePosition(null)).toBeNull();
		expect(pagePosition(undefined)).toBeNull();
		expect(pagePosition({ fraction: 0.4 })).toBeNull();
		expect(pagePosition({ size: 0.5 })).toBeNull();
		expect(pagePosition({ fraction: 0.4, size: 0 })).toBeNull();
		expect(pagePosition({ fraction: 0.4, size: 1.5 })).toBeNull();
		expect(pagePosition({ fraction: 0.4, size: Number.NaN })).toBeNull();
		// Continuous scrolling reports the viewport's share of a section instead.
		expect(pagePosition({ fraction: 0.4, size: 0.63 })).toBeNull();
	});

	it('keeps the paginator detail only while paginated', async () => {
		const { display, renderer } = setup();
		await display.apply(DEFAULT_SETTINGS, '');
		renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'page', index: 0, fraction: 1 / 4, size: 1 / 4 } }));
		expect(pagePosition(display.pagination)).toEqual({ page: 2, pageCount: 4 });
		await display.apply({ ...DEFAULT_SETTINGS, flow: 'scrolled' }, '');
		expect(display.pagination).toBeNull();
		renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'scroll', index: 0, fraction: 0.4, size: 0.63 } }));
		expect(pagePosition(display.pagination)).toBeNull();
	});
});

describe('Foliate page turn animation', () => {
	it('slides paginated turns only while motion is allowed', async () => {
		const { display, renderer } = setup();
		vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
		await display.apply(DEFAULT_SETTINGS, '');
		expect(renderer.setAttribute).toHaveBeenCalledWith('animated', '');
		await display.apply({ ...DEFAULT_SETTINGS, flow: 'scrolled' }, '');
		expect(renderer.removeAttribute).toHaveBeenCalledWith('animated');
		renderer.setAttribute.mockClear();
		vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
		await display.apply(DEFAULT_SETTINGS, '');
		expect(renderer.removeAttribute).toHaveBeenCalledWith('animated');
		expect(renderer.setAttribute.mock.calls.filter(([name]) => name === 'animated')).toEqual([]);
	});
});

describe('Continuous scroll forwarding', () => {
	class ScrollDocument extends EventTarget {
		selection = { rangeCount: 0, isCollapsed: true };
		getSelection = () => this.selection;
	}

	const gesture = (type: string, x: number, y: number, count = 1) => Object.assign(
		new Event(type, { cancelable: true }),
		{ touches: { length: count }, changedTouches: [{ screenX: x, screenY: y }] }
	);

	const attach = () => {
		const doc = new ScrollDocument();
		const pane = { scrollTop: 0, scrollLeft: 0, clientHeight: 900 };
		forwardContinuousScrolling(doc as unknown as Document, pane as unknown as HTMLElement);
		return { doc, pane };
	};

	it('scrolls the pane with single-touch drags and wheels', () => {
		const { doc, pane } = attach();
		doc.dispatchEvent(gesture('touchstart', 0, 100));
		const drag = gesture('touchmove', 0, 60);
		doc.dispatchEvent(drag);
		expect(drag.defaultPrevented).toBe(true);
		expect(pane.scrollTop).toBe(40);
		doc.dispatchEvent(gesture('touchend', 0, 60));
		doc.dispatchEvent(gesture('touchstart', 100, 0));
		doc.dispatchEvent(gesture('touchmove', 40, 0));
		expect(pane.scrollLeft).toBe(60);
		const wheel = Object.assign(new Event('wheel', { cancelable: true }),
			{ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false });
		doc.dispatchEvent(wheel);
		expect(wheel.defaultPrevented).toBe(true);
		expect(pane.scrollTop).toBe(160);
	});

	it('leaves selections, multi-touch and ctrl+wheel to the document', () => {
		const { doc, pane } = attach();
		doc.selection = { rangeCount: 1, isCollapsed: false };
		doc.dispatchEvent(gesture('touchstart', 0, 100));
		const dragging = gesture('touchmove', 0, 60);
		doc.dispatchEvent(dragging);
		expect(dragging.defaultPrevented).toBe(false);
		expect(pane.scrollTop).toBe(0);
		doc.selection = { rangeCount: 0, isCollapsed: true };
		doc.dispatchEvent(gesture('touchstart', 0, 100));
		doc.dispatchEvent(gesture('touchmove', 0, 40, 2));
		expect(pane.scrollTop).toBe(0);
		const pinch = Object.assign(new Event('wheel', { cancelable: true }),
			{ deltaX: 0, deltaY: 8, deltaMode: 0, ctrlKey: true });
		doc.dispatchEvent(pinch);
		expect(pinch.defaultPrevented).toBe(false);
	});
});
