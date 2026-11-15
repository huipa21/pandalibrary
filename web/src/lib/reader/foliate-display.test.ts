import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoliateBook, FoliateRenderer } from 'foliate-js/view.js';
import { FoliateDisplay } from './foliate-display.js';
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
