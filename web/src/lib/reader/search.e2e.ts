import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { azw3Fixture, cbzFixture, epubFixture, fb2Fixture, fbzFixture, mobiFixture, pdfFixture } from './fixtures';

test.use({ serviceWorkers: 'block' });

async function setup(page: Page, format: string, bytes: Buffer, width = 1280) {
	await page.setViewportSize({ width, height: 900 });
	const file = { id: 31, format, size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}` };
	const book = {
		id: 21, library_id: 1, title: 'Search fixture', sort_title: 'Search fixture', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
	};
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: { user_book: null, progress: null, highlights: [], notes: [], bookmarks: [], page_annotations: [] } });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings: [
			{ key: 'reader.pdf', value: { pdfLayout: 'single', pdfZoom: 'page-width' }, updated_at: book.updated_at, rev: 1 }
		] } });
		if (path === '/api/v1/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], bookmarks: [], page_annotations: [], user_settings: []
		} });
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON();
			return route.fulfill({ json: { results: mutations.map((_: unknown, index: number) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto('/read/21/31');
	await expect(page.getByRole('button', { name: 'Close reader', exact: true })).toBeVisible({ timeout: 20_000 });
	if (format === 'pdf') await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	else await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
}

async function search(page: Page, query: string) {
	await page.getByRole('tab', { name: 'Search', exact: true }).click();
	const panel = page.getByRole('tabpanel', { name: 'Search', exact: true });
	await panel.getByRole('searchbox').fill(query);
	await panel.getByRole('searchbox').press('Enter');
	return panel;
}

async function reflowSearchHighlights(page: Page) {
	return page.locator('foliate-view').evaluate((element) => {
		const view = element as HTMLElement & {
			renderer: { getContents(): Array<{ overlayer?: { element: Element } }> };
		};
		return view.renderer.getContents().reduce((count, content) =>
			count + (content.overlayer?.element.querySelectorAll('g[fill="none"][stroke="red"][stroke-width="3"] > rect').length ?? 0), 0);
	});
}

for (const [format, fixture] of [
	['epub', epubFixture], ['mobi', mobiFixture], ['azw3', azw3Fixture], ['fb2', fb2Fixture], ['fbz', fbzFixture]
] as const) {
	test(`${format} searches text and jumps to a highlighted result`, async ({ page }) => {
		await setup(page, format, fixture());
		const panel = await search(page, 'highlighting');
		const result = panel.locator('[data-search-result]').first();
		await expect(result).toContainText('A passage worth highlighting.');
		expect((await new AxeBuilder({ page }).include('.pv-sidebar').analyze()).violations).toEqual([]);
		await result.click();
		await expect.poll(() => reflowSearchHighlights(page)).toBeGreaterThan(0);
		await expect(async () => {
			const frames = page.frames().filter((frame) => frame.url().startsWith('blob:'));
			expect((await Promise.all(frames.map((frame) => frame.getByText('A passage worth highlighting.', { exact: true }).isVisible()))).some(Boolean)).toBe(true);
		}).toPass();
	});
}

test('EPUB finds an unloaded section and clears search highlights', async ({ page }) => {
	await setup(page, 'epub', epubFixture());
	const panel = await search(page, 'Another page');
	await panel.locator('[data-search-result]').click();
	await expect(async () => {
		const frames = page.frames().filter((frame) => frame.url().startsWith('blob:'));
		expect((await Promise.all(frames.map((frame) => frame.getByText('Another page of the fixture.', { exact: true }).isVisible()))).some(Boolean)).toBe(true);
	}).toPass();
	await expect.poll(() => reflowSearchHighlights(page)).toBeGreaterThan(0);
	await panel.getByRole('button', { name: 'Clear search', exact: true }).click();
	await expect(panel.locator('[data-search-result]')).toHaveCount(0);
	await expect.poll(() => reflowSearchHighlights(page)).toBe(0);
});

test('PDF paginates results, navigates to exact pages, and clears highlights', async ({ page }) => {
	await setup(page, 'pdf', pdfFixture(25));
	const panel = await search(page, 'PDF page text');
	await expect(panel.locator('[data-search-result]')).toHaveCount(20);
	await panel.locator('[data-search-result]').last().click();
	await panel.getByRole('button', { name: 'Next match', exact: true }).click();
	await expect(panel.locator('[data-search-page="2"]')).toBeVisible();
	await expect(panel.locator('[data-search-result]').first()).toHaveAttribute('aria-current', 'location');
	await expect(page.getByRole('textbox', { name: /^Page \d+ of \d+$/ })).toHaveValue('21');
	await panel.getByRole('button', { name: 'Previous match', exact: true }).click();
	await expect(panel.locator('[data-search-page="1"]')).toBeVisible();
	await expect(panel.locator('[data-search-result]').last()).toHaveAttribute('aria-current', 'location');
	await panel.getByRole('button', { name: 'Next results page', exact: true }).click();
	await expect(panel.locator('[data-search-result]')).toHaveCount(5);
	await panel.locator('[data-search-result]').last().click();
	await expect(page.getByRole('textbox', { name: /^Page \d+ of \d+$/ })).toHaveValue('25');
	await expect(page.locator('.textLayer .highlight.selected')).toBeVisible();
	await panel.getByRole('button', { name: 'Clear search', exact: true }).click();
	await expect(panel.locator('[data-search-result]')).toHaveCount(0);
	await expect(page.locator('.textLayer .highlight')).toHaveCount(0);
});

test('mobile PDF search distinguishes multiple matches on the same page', async ({ page }) => {
	await setup(page, 'pdf', pdfFixture(3), 375);
	const panel = await search(page, 'page');
	await expect(panel.locator('[data-search-result]')).toHaveCount(4);
	const matches = panel.locator('[data-search-result]');
	await matches.nth(2).click();
	await expect(page.getByRole('textbox', { name: /^Page \d+ of \d+$/ })).toHaveValue('3');
	await expect(page.locator('.textLayer .highlight.selected')).toHaveText('Page');
	await panel.getByRole('button', { name: 'Next match', exact: true }).click();
	await expect(matches.nth(3)).toHaveAttribute('aria-current', 'location');
	await expect(page.locator('.textLayer .highlight.selected')).toHaveText('page');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
	expect((await new AxeBuilder({ page }).include('.pv-sidebar').analyze()).violations).toEqual([]);
	await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
	await expect(panel).not.toBeVisible();
	await expect(page.locator('.textLayer .highlight.selected')).toBeVisible();
});

test('reflow results paginate and a replacement query resets the result page', async ({ page }) => {
	const bytes = Buffer.from(fb2Fixture().toString().replace(
		'<p>A passage worth highlighting.</p>',
		Array.from({ length: 45 }, (_, index) => `<p>Needle passage number ${index + 1}.</p>`).join('')
	));
	await setup(page, 'fb2', bytes);
	const panel = await search(page, 'Needle');
	await expect(panel.locator('[data-search-result]')).toHaveCount(20);
	await panel.getByRole('button', { name: 'Next results page', exact: true }).click();
	await expect(panel.locator('[data-search-result]')).toHaveCount(20);
	await panel.getByRole('button', { name: 'Next results page', exact: true }).click();
	await expect(panel.locator('[data-search-result]')).toHaveCount(5);
	await expect(panel.getByRole('button', { name: 'Next results page', exact: true })).toBeDisabled();
	await panel.getByRole('searchbox').fill('number 45');
	await panel.getByRole('searchbox').press('Enter');
	await expect(panel.locator('[data-search-result]')).toHaveCount(1);
	await expect(panel.locator('[data-search-result]')).toContainText('number 45');
	await panel.getByRole('searchbox').fill('not-in-this-book');
	await panel.getByRole('searchbox').press('Enter');
	await expect(panel.locator('[data-search-result]')).toHaveCount(0);
	await expect(panel).toContainText('No matches');
});

test('CBZ does not offer text search', async ({ page }) => {
	await setup(page, 'cbz', cbzFixture(), 375);
	await expect(page.getByRole('tab', { name: 'Search', exact: true })).toHaveCount(0);
});
