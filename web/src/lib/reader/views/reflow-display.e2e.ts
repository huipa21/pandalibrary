import { expect, test, type Frame, type Page } from '@playwright/test';
import { cbzFixture, epubFixture, pngFixture } from '../fixtures.js';

test.use({ serviceWorkers: 'block' });

async function setup(page: Page, format: 'epub' | 'cbz', longContent = false) {
	const bytes = format === 'epub' ? epubFixture('Fixture Book', { longContent }) : cbzFixture(pngFixture(720, 960, [180, 90, 50]));
	const file = { id: 31, format, size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}` };
	const timestamp = '2026-11-03T00:00:00Z';
	const book = {
		id: 21, library_id: 1, title: 'Display modes fixture', sort_title: 'Display modes fixture',
		subtitle: null, description: null, language: 'en', publisher: null, published_date: null,
		page_count: null, cover_url: null, cover_source: null, authors: [], series: null, tags: [],
		identifiers: [], files: [file], field_sources: [], created_at: timestamp, updated_at: timestamp
	};
	const saved: Record<string, unknown>[] = [];
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: {
			user_book: null, progress: null, highlights: [], notes: [], bookmarks: [], page_annotations: []
		} });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings: [
			{ key: `reader.${format}`, value: { font: 'serif' }, updated_at: timestamp, rev: 1 }
		] } });
		if (path === '/api/v1/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], user_settings: [], highlights: [], notes: [], bookmarks: [], page_annotations: []
		} });
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON();
			saved.push(...mutations.filter((item: { entity: string }) => item.entity === 'user_settings').map((item: { data: Record<string, unknown> }) => item.data));
			return route.fulfill({ json: { results: mutations.map((_: unknown, index: number) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.goto('/read/21/31');
	await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
	return saved;
}

async function choose(page: Page, menu: string, value: string) {
	if (menu === 'Zoom' && /^\d+%$/.test(value)) {
		await choose(page, menu, 'Actual size');
		const steps = (Number.parseInt(value) - 100) / 10;
		await page.getByRole('button', { name: /^Zoom(?:\s|$)/ }).click();
		for (let step = 0; step < Math.abs(steps); step++) {
			await page.getByRole('menuitem', { name: steps > 0 ? 'Zoom in' : 'Zoom out', exact: true }).click();
			await expect(page.getByRole('button', { name: /^Zoom(?:\s|$)/ }))
				.toContainText(`${100 + (step + 1) * Math.sign(steps) * 10}%`);
		}
		await page.keyboard.press('Escape');
		return;
	}
	await page.getByRole('button', {
		name: menu === 'Zoom' ? /^Zoom(?:\s|$)/ : menu === 'Display' ? 'Page display' : menu, exact: true
	}).click();
	await page.getByRole('menuitemradio', { name: value, exact: true }).click();
}

async function visibleFrame(page: Page): Promise<Frame> {
	let frame: Frame | undefined;
	await expect(async () => {
		frame = undefined;
		for (const candidate of page.frames().filter((item) => item.url().startsWith('blob:'))) {
			if (await candidate.locator('body').evaluate((body) => {
				const frame = body.ownerDocument.defaultView?.frameElement as HTMLElement | null;
				return !!frame && frame.getBoundingClientRect().width > 0;
			}).catch(() => false)) { frame = candidate; break; }
		}
		expect(frame).toBeDefined();
	}).toPass();
	return frame!;
}

test('EPUB zoom magnifies the viewport separately from typography and all display modes render', async ({ page }) => {
	await setup(page, 'epub');
	let frame = await visibleFrame(page);
	const font = await frame.locator('body').evaluate((body) => getComputedStyle(body).fontSize);
	await choose(page, 'Zoom', 'Actual size');
	await expect(page.getByRole('button', { name: /^Zoom(?:\s|$)/ })).toContainText('100%');
	await expect.poll(() => frame.locator('body').evaluate((body) => {
		const iframe = body.ownerDocument.defaultView!.frameElement as HTMLElement;
		return iframe.getBoundingClientRect().width / iframe.offsetWidth;
	})).toBeCloseTo(1, 2);
	await choose(page, 'Zoom', '150%');
	await expect(page.getByRole('button', { name: /^Zoom(?:\s|$)/ })).toContainText('150%');
	await expect.poll(() => frame.locator('body').evaluate((body) => {
		const iframe = body.ownerDocument.defaultView!.frameElement as HTMLElement;
		return iframe.getBoundingClientRect().width / iframe.offsetWidth;
	})).toBeCloseTo(1.5, 2);
	expect(await frame.locator('body').evaluate((body) => getComputedStyle(body).fontSize)).toBe(font);
	await choose(page, 'Display', 'Split');
	await expect.poll(() => frame.locator('body').evaluate((body) => {
		const renderer = body.ownerDocument.defaultView!.frameElement!.getRootNode() as ShadowRoot;
		return (renderer.host as HTMLElement).getAttribute('max-column-count');
	})).toBe('2');
	await choose(page, 'Display', 'Single page continuous');
	frame = await visibleFrame(page);
	await expect.poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).columnCount)).toBe('1');
	await choose(page, 'Display', 'Split continuous');
	frame = await visibleFrame(page);
	await expect.poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).columnCount)).toBe('2');
	await choose(page, 'Display', 'Single page');
	frame = await visibleFrame(page);
	await expect.poll(() => frame.locator('body').evaluate((body) => {
		const root = body.ownerDocument.defaultView!.frameElement!.getRootNode() as ShadowRoot;
		return root.host.getAttribute('max-column-count');
	})).toBe('1');
});

test('EPUB zoom reflows a narrow screen instead of overflowing sideways', async ({ page }) => {
	await setup(page, 'epub', true);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: 'More view options', exact: true }).press('ArrowDown');
	await page.getByRole('menuitem', { name: /^Zoom(?: |$)/, exact: true }).click();
	await page.getByRole('menuitemradio', { name: 'Actual size', exact: true }).click();
	const metrics = await (await visibleFrame(page)).locator('body').evaluate((body) => {
		const iframe = body.ownerDocument.defaultView!.frameElement as HTMLIFrameElement;
		const viewport = (iframe.getRootNode() as ShadowRoot).host.parentElement!;
		return {
			columnWidth: Number.parseFloat(body.ownerDocument.defaultView!.getComputedStyle(body.ownerDocument.documentElement).columnWidth),
			clientWidth: viewport.clientWidth,
			scrollWidth: viewport.scrollWidth
		};
	});
	expect(metrics.columnWidth).toBeLessThan(500);
	expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth + 1);
});

test('EPUB font-size changes keep the reading anchor instead of walking backwards', async ({ page }) => {
	await setup(page, 'epub', true);
	await page.setViewportSize({ width: 390, height: 844 });
	const label = page.locator('.pv4-progress');
	const next = page.getByRole('button', { name: 'Next page', exact: true });
	for (let step = 0; step < 3; step++) {
		const previous = await label.textContent();
		await next.click();
		await expect.poll(() => label.textContent()).not.toBe(previous);
	}
	const position = page.locator('#reader-position');
	await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThanOrEqual(299);
	const before = Number(await position.inputValue());
	await page.getByRole('button', { name: 'More view options', exact: true }).press('ArrowDown');
	await page.getByRole('menuitem', { name: /^Format$/i, exact: true }).click();
	const format = page.getByRole('dialog', { name: 'Format', exact: true });
	const increase = format.getByRole('button', { name: 'Increase font size', exact: true });
	await increase.click();
	await expect(format.getByRole('status', { name: 'Size', exact: true })).toHaveText('110%');
	await expect.poll(() => label.textContent()).toMatch(/\/ 13$/);
	const afterFirst = Number(await position.inputValue());
	expect(afterFirst).not.toBe(before);
	for (let step = 0; step < 4; step++) await increase.click();
	await expect(format.getByRole('status', { name: 'Size', exact: true })).toHaveText('150%');
	await expect.poll(() => label.textContent()).toMatch(/\/ 25$/);
	// Repeated reflows must continue from the same anchor. Without it, every
	// step restores the previous page start and the saved position walks back.
	expect(Number(await position.inputValue())).toBeGreaterThanOrEqual(afterFirst - 30);
});

test('EPUB zoom and resize keep complete lines and consecutive page text visible', async ({ page }) => {
	test.setTimeout(90_000);
	await setup(page, 'epub', true);
	await choose(page, 'Display', 'Single page');

	const geometry = async () => (await visibleFrame(page)).locator('body').evaluate((body) => {
		const iframe = body.ownerDocument.defaultView!.frameElement as HTMLIFrameElement;
		// Read visual clipping, bypassing renderer-specific logical measurement overrides.
		const visualRect = (element: Element) => Element.prototype.getBoundingClientRect.call(element);
		const frameRect = visualRect(iframe);
		const scale = frameRect.width / iframe.offsetWidth;
		const clip = { left: frameRect.left, right: frameRect.right, top: frameRect.top, bottom: frameRect.bottom };
		let ancestor: Element | null = iframe;
		while (ancestor) {
			const style = ancestor.ownerDocument.defaultView!.getComputedStyle(ancestor);
			const rect = visualRect(ancestor);
			if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
				clip.left = Math.max(clip.left, rect.left);
				clip.right = Math.min(clip.right, rect.right);
			}
			if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
				clip.top = Math.max(clip.top, rect.top);
				clip.bottom = Math.min(clip.bottom, rect.bottom);
			}
			ancestor = ancestor.parentElement ?? (ancestor.getRootNode() as ShadowRoot).host ?? null;
		}
		const text = [...body.querySelectorAll('[data-pagination]')].map((p) => p.textContent ?? '').join('');
		const visible: number[] = [];
		const clipped: { offset: number; top: number; bottom: number }[] = [];
		let offset = 0;
		for (const paragraph of body.querySelectorAll('[data-pagination]')) {
			const walker = body.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const node = walker.currentNode;
				for (let index = 0; index < node.textContent!.length; index++, offset++) {
					if (/\s/.test(node.textContent![index])) continue;
					const range = body.ownerDocument.createRange();
					range.setStart(node, index);
					range.setEnd(node, index + 1);
					const rect = range.getBoundingClientRect();
					const left = frameRect.left + rect.left * scale;
					const right = frameRect.left + rect.right * scale;
					if (left < clip.left - 1 || right > clip.right + 1 || rect.width === 0) continue;
					const top = frameRect.top + rect.top * scale;
					const bottom = frameRect.top + rect.bottom * scale;
					if (top < clip.top - 1 || bottom > clip.bottom + 1) clipped.push({ offset, top, bottom });
					else visible.push(offset);
				}
			}
		}
		return { first: visible[0], last: visible.at(-1)!, clipped: clipped.slice(0, 3), count: visible.length, text, clip };
	});

	let currentZoom = '';
	for (const { zoom, size } of [
		{ zoom: '110%' },
		{ zoom: '150%' },
		{ zoom: '80%' },
		{ zoom: '80%', size: { width: 1137, height: 713 } },
		{ zoom: '150%' },
		{ zoom: '150%', size: { width: 1463, height: 897 } }
	]) {
		await test.step(`${zoom}${size ? ` at ${size.width}x${size.height}` : ''}`, async () => {
			if (size) await page.setViewportSize(size);
			if (zoom !== currentZoom) {
				await choose(page, 'Zoom', zoom);
				currentZoom = zoom;
			}
			let before!: Awaited<ReturnType<typeof geometry>>;
			await expect(async () => {
				before = await geometry();
				expect(before.count).toBeGreaterThan(100);
				expect(before.clipped, JSON.stringify(before.clip)).toEqual([]);
			}).toPass({ timeout: 5_000 });
			await page.getByRole('button', { name: 'Next page', exact: true }).click();
			await expect(async () => {
				const after = await geometry();
				expect(after.count).toBeGreaterThan(100);
				expect(after.clipped, JSON.stringify(after.clip)).toEqual([]);
				expect(after.first).toBeGreaterThan(before.last);
				expect(after.text.slice(before.last + 1, after.first).trim()).toBe('');
			}).toPass({ timeout: 5_000 });
		});
	}
});

test('CBZ layouts show one page, a spread, a scrolling stack, and a scrolling spread', async ({ page }) => {
	await setup(page, 'cbz');
	await choose(page, 'Zoom', 'Actual size');
	let frame = await visibleFrame(page);
	const nativeFrames = () => frame.locator('body').evaluate((body) => {
		const root = body.ownerDocument.defaultView!.frameElement!.getRootNode() as ShadowRoot;
		return [...root.querySelectorAll('iframe')].filter((frame) => frame.getBoundingClientRect().width > 0).length;
	});
	await expect.poll(nativeFrames).toBe(1);
	await choose(page, 'Display', 'Split');
	frame = await visibleFrame(page);
	await page.getByRole('button', { name: 'Next page', exact: true }).click();
	frame = await visibleFrame(page);
	await expect.poll(nativeFrames).toBe(2);
	await choose(page, 'Display', 'Single page continuous');
	frame = await visibleFrame(page);
	await expect.poll(() => frame.locator('body').evaluate((body) => {
		const own = body.ownerDocument.defaultView!.frameElement as HTMLElement;
		const pane = own.closest('[data-reader-continuous]')!;
		const frames = [...pane.querySelectorAll('iframe')];
		return frames[1].getBoundingClientRect().top > frames[0].getBoundingClientRect().bottom;
	})).toBe(true);
	await choose(page, 'Display', 'Split continuous');
	await expect.poll(() => frame.locator('body').evaluate((body) => {
		const own = body.ownerDocument.defaultView!.frameElement as HTMLElement;
		const frames = [...own.closest('[data-reader-continuous]')!.querySelectorAll('iframe')];
		return Math.abs(frames[1].getBoundingClientRect().top - frames[0].getBoundingClientRect().top) < 1;
	})).toBe(true);
});

for (const zoom of ['Automatic', 'Actual size']) test(`native page turns retain section navigation at ${zoom}`, async ({ page }) => {
	await setup(page, 'epub');
	await choose(page, 'Zoom', zoom);
	await page.getByRole('button', { name: 'Next page', exact: true }).click();
	await expect.poll(async () => {
		const frame = await visibleFrame(page);
		return frame.locator('h1').textContent().catch(() => null);
	}).toBe('Second section');
	await page.getByRole('button', { name: 'Previous page', exact: true }).click();
	await expect.poll(async () => {
		const frame = await visibleFrame(page);
		return frame.locator('h1').textContent().catch(() => null);
	}).toBe('First section');
});
