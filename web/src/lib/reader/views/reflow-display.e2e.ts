import { expect, test, type Frame, type Page } from '@playwright/test';
import { cbzFixture, epubFixture, pngFixture } from '../fixtures.js';

test.use({ serviceWorkers: 'block' });

async function setup(page: Page, format: 'epub' | 'cbz') {
	const bytes = format === 'epub' ? epubFixture() : cbzFixture(pngFixture(720, 960, [180, 90, 50]));
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
