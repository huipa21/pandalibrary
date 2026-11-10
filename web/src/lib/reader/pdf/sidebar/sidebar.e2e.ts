import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { pdfFixture } from '../../fixtures';

test.use({ serviceWorkers: 'block' });

const id = (n: number) => `0190f5c2-7a00-7000-8000-${String(n).padStart(12, '0')}`;
const base = {
	book_id: 21, book_file_id: 31, position: 0,
	created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z', deleted_at: null, rev: 1
};
const highlights = [
	{ ...base, id: id(1), locator: { type: 'pdf', page: 1, rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.05 }] }, text: 'Commented mark', color: 'yellow', chapter: null }
];
const notes = [{ ...base, id: id(11), highlight_id: id(1), body_md: 'A comment' }];

async function setup(page: Page, width: number) {
	await page.setViewportSize({ width, height: 800 });
	const bytes = pdfFixture();
	const file = { id: 31, format: 'pdf', size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}` };
	const book = {
		id: 21, library_id: 1, title: 'Sidebar fixture', sort_title: 'Sidebar fixture', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: base.created_at, updated_at: base.updated_at
	};
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: { user_book: null, progress: null, highlights, notes, bookmarks: [], page_annotations: [] } });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings: [
			{ key: 'reader.pdf', value: { pdfLayout: 'single-continuous', pdfZoom: 'page-width' }, updated_at: base.updated_at, rev: 1 }
		] } });
		if (path === '/api/v1/sync/pull') return route.fulfill({ json: {
			cursor: 1, user_books: [], reading_progress: [], highlights: [], notes: [], bookmarks: [], page_annotations: [], user_settings: []
		} });
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON();
			return route.fulfill({ json: { results: mutations.map((_: unknown, index: number) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const tabpanel = (page: Page, name: string) => page.getByRole('tabpanel', { name, exact: true });
const pageBox = (page: Page) => page.getByRole('textbox', { name: /^Page \d+ of \d+$/ });
const surfaceX = async (page: Page) => (await page.locator('#reader-surface').boundingBox())?.x;

for (const width of [375, 800, 1280]) {
	test(`the rail replaces the Annotations toolbar icon at ${width}px`, async ({ page }) => {
		await setup(page, width);
		await expect(page.getByRole('button', { name: 'Annotations', exact: true })).toHaveCount(0);
		const rail = page.getByRole('tablist', { name: 'Reader sidebar', exact: true });
		await expect(rail).toBeVisible();
		for (const name of ['Contents', 'Pages', 'Annotations', 'Bookmarks']) await expect(rail.getByRole('tab', { name, exact: true })).toBeInViewport({ ratio: 1 });
		await expect(rail.getByRole('tab', { selected: true })).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
	});
}

test('docked mode pushes the page, keeps the current page, and survives a reload', async ({ page }) => {
	await setup(page, 1280);
	await pageBox(page).fill('2');
	await pageBox(page).press('Enter');
	await expect(pageBox(page)).toHaveValue('2');
	const before = await surfaceX(page);
	expect(before).toBe(44);
	await tab(page, 'Pages').click();
	await expect(tabpanel(page, 'Pages')).toBeVisible();
	await expect(tabpanel(page, 'Pages').getByRole('list', { name: 'Pages', exact: true })).toBeVisible();
	await expect(tabpanel(page, 'Pages').getByRole('button', { name: 'Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(tab(page, 'Pages')).toHaveAttribute('aria-selected', 'true');
	await expect.poll(() => surfaceX(page)).toBe(before! + 300);
	await page.waitForTimeout(600);
	await expect(pageBox(page)).toHaveValue('2');
	// Docked: a page click does not collapse.
	await page.locator('#reader-surface').click({ position: { x: 20, y: 200 } });
	await expect(tabpanel(page, 'Pages')).toBeVisible();
	expect(await page.evaluate(() => localStorage.getItem('pandalibrary.reader-sidebar'))).toBe('{"open":true,"tab":"pages"}');

	await page.reload();
	await expect(tabpanel(page, 'Pages')).toBeVisible();
	await expect.poll(() => surfaceX(page)).toBe(before! + 300);
	await tab(page, 'Pages').click();
	await expect(tabpanel(page, 'Pages')).toHaveCount(0);
	await expect.poll(() => surfaceX(page)).toBe(before);
	await page.reload();
	await expect(pageBox(page)).toBeEnabled();
	await expect(page.getByRole('tabpanel')).toHaveCount(0);
});

test('overlay mode floats over the page and collapses on Escape and on a page click', async ({ page }) => {
	await setup(page, 800);
	const before = await surfaceX(page);
	await tab(page, 'Contents').click();
	const panel = tabpanel(page, 'Contents');
	await expect(panel).toBeVisible();
	await expect(panel).toBeFocused();
	expect(await surfaceX(page)).toBe(before);
	await page.keyboard.press('Escape');
	await expect(panel).toHaveCount(0);
	await expect(tab(page, 'Contents')).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(tab(page, 'Pages')).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(tabpanel(page, 'Pages')).toBeVisible();
	await page.mouse.click(780, 400);
	await expect(tabpanel(page, 'Pages')).toHaveCount(0);
});

test('clicking a comment marker reveals the entry in the Annotations tab', async ({ page }) => {
	await setup(page, 1280);
	const marker = page.locator(`.pv-mark-comment[data-annotation-id="${id(1)}"]`);
	await expect(marker).toBeVisible();
	await marker.click();
	const panel = tabpanel(page, 'Annotations');
	await expect(panel).toBeVisible();
	await expect(panel.locator(`[data-panel-entry="${id(1)}"]`)).toBeInViewport();
	await expect(tab(page, 'Annotations')).toHaveAttribute('aria-selected', 'true');
});

for (const theme of ['light', 'dark']) {
	test(`the sidebar is axe clean (${theme})`, async ({ page }) => {
		await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
		await setup(page, 1280);
		const scan = async () => (await new AxeBuilder({ page }).include('.pv-sidebar').analyze()).violations;
		expect(await scan()).toEqual([]);
		await tab(page, 'Annotations').click();
		await expect(tabpanel(page, 'Annotations').locator(`[data-panel-entry="${id(1)}"]`)).toBeVisible();
		expect(await scan()).toEqual([]);
		await tab(page, 'Contents').click();
		await expect(tabpanel(page, 'Contents')).toContainText('This PDF has no table of contents.');
		expect(await scan()).toEqual([]);
	});
}
