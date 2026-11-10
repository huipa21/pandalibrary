import { expect, test, type Page } from '@playwright/test';
import { pdfFixture } from '../../../fixtures.js';
import axe from 'axe-core';

test.use({ serviceWorkers: 'block' });

declare global {
	interface Window {
		axe?: typeof axe;
		pagesOpenTiming?: Promise<{ mounted: number; firstFrame: number; painted: number }>;
		pagesBoundaryWasMissing?: boolean;
	}
}

const timestamp = '2026-11-01T10:00:00Z';

async function setup(page: Page, pageCount: number) {
	await page.setViewportSize({ width: 1280, height: 900 });
	const bytes = pdfFixture(pageCount);
	const file = {
		id: 31, format: 'pdf', size_bytes: bytes.length,
		download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}`
	};
	const book = {
		id: 21, library_id: 1, title: 'Pages fixture', sort_title: 'Pages fixture', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: pageCount,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: timestamp, updated_at: timestamp
	};
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') {
			return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		}
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') {
			return route.fulfill({ json: { user_book: null, progress: null, highlights: [], notes: [], bookmarks: [], page_annotations: [] } });
		}
		if (path === '/api/v1/me/settings') {
			return route.fulfill({ json: { settings: [
				{ key: 'reader.pdf', value: { pdfLayout: 'single-continuous', pdfZoom: 'page-width' }, updated_at: timestamp, rev: 1 }
			] } });
		}
		if (path === '/api/v1/sync/pull') {
			return route.fulfill({ json: {
				cursor: 1, user_books: [], reading_progress: [], highlights: [], notes: [], bookmarks: [], page_annotations: [], user_settings: []
			} });
		}
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON();
			return route.fulfill({ json: { results: mutations.map((_: unknown, index: number) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto('/read/21/31');
	await expect(page.getByRole('textbox', { name: /^Page \d+ of \d+$/ })).toBeEnabled({ timeout: 30_000 });
}

const pagesTab = (page: Page) => page.getByRole('tab', { name: 'Pages', exact: true });
const pagesPanel = (page: Page) => page.getByRole('tabpanel', { name: 'Pages', exact: true });
const pageCounter = (page: Page) => page.getByRole('textbox', { name: /^Page \d+ of \d+$/ });
const thumbnail = (page: Page, number: number) => page.getByRole('button', { name: `Page ${number}`, exact: true });

test('thumbnails lazily render, jump to a page, track the current spread, rotate, and pass axe', async ({ page }) => {
	await setup(page, 4);
	await pagesTab(page).click();
	await expect(pagesPanel(page).getByRole('list', { name: 'Pages', exact: true })).toBeVisible();
	await expect(thumbnail(page, 1).locator('canvas')).toBeVisible();

	await thumbnail(page, 3).click();
	await expect(pageCounter(page)).toHaveValue('3');
	await expect(thumbnail(page, 3)).toHaveAttribute('aria-current', 'page');

	await page.getByRole('button', { name: 'Page display' }).click();
	await page.getByRole('menuitemradio', { name: 'Split', exact: true }).click();
	await expect(thumbnail(page, 3)).toHaveAttribute('aria-current', 'page');
	await expect(thumbnail(page, 4)).toHaveAttribute('aria-current', 'page');

	const dimensions = await thumbnail(page, 3).locator('canvas').evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
	await page.getByRole('button', { name: 'Rotate' }).click();
	await page.getByRole('menuitem', { name: 'Rotate right', exact: true }).click();
	await expect.poll(() =>
		thumbnail(page, 3).locator('canvas').evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])
	).not.toEqual(dimensions);

	await page.addScriptTag({ content: axe.source });
	const violations = await page.evaluate(async () => {
		if (!window.axe) throw new Error('axe-core did not load.');
		const results = await window.axe.run('.pv-sidebar-panel');
		return results.violations.map(({ id, impact, nodes }) => ({
			id, impact, nodes: nodes.map(({ html, failureSummary }) => ({ html, failureSummary }))
		}));
	});
	expect(violations).toEqual([]);
});

test('thumbnails follow live PDF background changes', async ({ page }) => {
	await setup(page, 4);
	await pagesTab(page).click();
	const panel = pagesPanel(page);
	const list = panel.getByRole('list', { name: 'Pages', exact: true });
	const thumb = thumbnail(page, 1);
	await expect(thumb.locator('canvas')).toBeVisible();

	await page.getByRole('button', { name: 'Format', exact: true }).click();
	await page.getByRole('dialog', { name: 'Format' }).getByRole('radio', { name: 'Eye-care green' }).click();
	await expect(list).toHaveAttribute('data-background', 'green');
	await expect(thumb.locator('.pv-pages-page')).toHaveCSS('background-color', 'rgb(199, 237, 204)');
	await page.keyboard.press('Escape');

	await page.getByRole('button', { name: 'Format', exact: true }).click();
	await page.getByRole('dialog', { name: 'Format' }).getByRole('radio', { name: 'Night' }).click();
	await expect(list).toHaveAttribute('data-tone', 'dark');
	await expect(thumb.locator('canvas')).toHaveCSS('filter', 'invert(1) hue-rotate(180deg)');
	await expect(thumb.locator('canvas')).toHaveCSS('mix-blend-mode', 'screen');
});

test('opening a thousand-page list stays lazy and under 500ms', async ({ page }) => {
	await setup(page, 1000);
	await pagesTab(page).evaluate((tab) => {
		window.pagesOpenTiming = new Promise((resolve, reject) => {
			tab.addEventListener('click', () => {
				const start = performance.now();
				const panel = document.getElementById('pv-sidebar-panel');
				if (!panel) {
					reject(new Error('The sidebar panel is missing.'));
					return;
				}
				const observer = new MutationObserver(() => {
					const first = panel.querySelector<HTMLElement>('.pv-pages-scroll button');
					if (!first?.getClientRects().length) return;
					observer.disconnect();
					clearTimeout(timeout);
					const mounted = performance.now() - start;
					requestAnimationFrame(() => {
						const firstFrame = performance.now() - start;
						// The next frame begins after the first thumbnail can be painted.
						requestAnimationFrame(() => resolve({ mounted, firstFrame, painted: performance.now() - start }));
					});
				});
				const timeout = setTimeout(() => {
					observer.disconnect();
					reject(new Error('The first thumbnail did not appear.'));
				}, 10_000);
				observer.observe(panel, { childList: true, subtree: true });
			}, { capture: true, once: true });
		});
	});
	await pagesTab(page).click();
	const panel = pagesPanel(page);
	const list = panel.getByRole('list', { name: 'Pages', exact: true });
	await expect(list.locator('button').first()).toBeVisible();
	const timing = await page.evaluate(() => {
		if (!window.pagesOpenTiming) throw new Error('Thumbnail opening timing was not started.');
		return window.pagesOpenTiming;
	});
	console.log(`Opening 1,000 PDF pages: mounted ${timing.mounted.toFixed(1)} ms, first frame ${timing.firstFrame.toFixed(1)} ms, painted ${timing.painted.toFixed(1)} ms`);
	expect(timing.painted).toBeLessThan(500);
	await expect(list.getByRole('listitem')).toHaveCount(1000);
	await expect.poll(() => panel.locator('canvas.pv-pages-canvas').count()).toBeGreaterThan(0);
	expect(await panel.locator('canvas.pv-pages-canvas').count()).toBeLessThanOrEqual(20);
});

test('keyboard navigation reaches a thumbnail that has not mounted yet', async ({ page }) => {
	await setup(page, 1000);
	await pagesTab(page).evaluate((tab) => {
		tab.addEventListener('click', () => {
			const panel = document.getElementById('pv-sidebar-panel');
			if (!panel) throw new Error('The sidebar panel is missing.');
			const observer = new MutationObserver(() => {
				const last = panel.querySelector<HTMLButtonElement>('.pv-pages-scroll button[aria-label="Page 24"]');
				if (!last) return;
				observer.disconnect();
				window.pagesBoundaryWasMissing = !panel.querySelector('.pv-pages-scroll button[aria-label="Page 25"]');
				last.focus();
				last.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
			});
			observer.observe(panel, { childList: true, subtree: true });
		}, { capture: true, once: true });
	});
	await pagesTab(page).click();
	await expect(thumbnail(page, 25)).toBeFocused();
	expect(await page.evaluate(() => window.pagesBoundaryWasMissing)).toBe(true);
});

test('a long list scrolls to the current page and supports keyboard navigation', async ({ page }) => {
	await setup(page, 1000);
	const counter = pageCounter(page);
	await counter.fill('700');
	await counter.press('Enter');
	await expect(counter).toHaveValue('700');
	await pagesTab(page).click();

	const panel = pagesPanel(page);
	const current = panel.getByRole('button', { name: 'Page 700', exact: true });
	await expect(current).toHaveAttribute('aria-current', 'page');
	await expect(current).toBeInViewport();
	await expect(current.locator('..')).toHaveAttribute('aria-posinset', '700');
	await expect(current.locator('..')).toHaveAttribute('aria-setsize', '1000');
	await current.focus();
	await current.press('ArrowDown');
	await expect(panel.getByRole('button', { name: 'Page 701', exact: true })).toBeFocused();
});

test('a five-thousand-page list renders thumbnails only near the viewport', async ({ page }) => {
	test.setTimeout(120_000);
	await setup(page, 5000);
	await pagesTab(page).click();
	const panel = pagesPanel(page);
	const canvases = panel.locator('canvas.pv-pages-canvas');
	await expect(panel.getByRole('listitem')).toHaveCount(5000, { timeout: 30_000 });
	await expect.poll(() => canvases.count(), { timeout: 15_000 }).toBeGreaterThan(0);
	expect(await canvases.count()).toBeLessThanOrEqual(20);

	const middle = panel.getByRole('button', { name: 'Page 2500', exact: true });
	await middle.scrollIntoViewIfNeeded();
	await expect(middle.locator('canvas')).toBeVisible({ timeout: 15_000 });
	await expect.poll(() => canvases.count()).toBeLessThanOrEqual(20);
});
