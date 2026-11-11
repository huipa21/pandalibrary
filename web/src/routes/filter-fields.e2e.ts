import { expect, test, type Locator, type Page } from '@playwright/test';

const timestamp = '2026-11-03T00:00:00Z';
const book = {
	id: 21, library_id: 1, title: 'A Book', sort_title: 'A Book', subtitle: null,
	description: null, language: 'en', publisher: null, published_date: null,
	page_count: null, cover_url: null, cover_source: null, authors: [], series: null,
	tags: [], identifiers: [], field_sources: [],
	files: [{
		id: 31, format: 'pdf', original_filename: 'A Book.pdf', size_bytes: 4096,
		created_at: timestamp, download_url: '/api/v1/books/21/files/31?v=abc'
	}],
	created_at: timestamp, updated_at: timestamp
};
const shelf = {
	id: 7, name: 'My shelf', kind: 'private', owner_id: 1, description: null,
	created_by: 1, visible_book_count: 0, mode: 'manual', system_key: null,
	created_at: timestamp, updated_at: timestamp
};
const highlight = {
	id: 'highlight-1', book_id: 21, book_file_id: 31, locator: { type: 'pdf', page: 1 },
	position: 0.1, text: 'Example highlight', color: 'yellow', chapter: null,
	created_at: timestamp, updated_at: timestamp, deleted_at: null, rev: 1
};

async function mockApi(page: Page) {
	await page.route('**/api/v1/**', (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: {
			id: 1, username: 'admin', display_name: 'Admin', role: 'admin', locale: 'en'
		} } });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [],
			bookmarks: [], page_annotations: [], user_settings: []
		} });
		if (path === '/admin/bookheap/scan') return route.fulfill({ json: { scan: null } });
		if (path === '/shelves/7') return route.fulfill({ json: { shelf } });
		if (path.startsWith('/shelves/system/')) return route.fulfill({ json: {
			shelf: { ...shelf, id: 8, mode: 'system', system_key: path.split('/').at(-1) }
		} });
		if (path === '/books/21') return route.fulfill({ json: { book } });
		if (path === '/libraries/1') return route.fulfill({ json: {
			library: { id: 1, name: 'Library', slug: 'library', created_at: timestamp, updated_at: timestamp }
		} });
		if (path === '/me/books/21') return route.fulfill({ json: {
			user_book: null, progress: null, bookmarks: [], highlights: [highlight], notes: [], page_annotations: []
		} });
		if (path === '/stats') return route.fulfill({ json: {
			from: url.searchParams.get('from'), to: url.searchParams.get('to'),
			timezone: url.searchParams.get('timezone'), daily: [], finished_per_month: [],
			streaks: { current_days: 0, longest_days: 0 }, time_per_book: []
		} });
		if (path === '/books') return route.fulfill({ json: { items: [book], next_cursor: null } });
		if ([
			'/authors', '/series', '/tags', '/libraries', '/shelves', '/shelves/7/books',
			'/admin/bookheap/items', '/me/book-states', '/me/activities', '/me/notes', '/search'
		].includes(path)) return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		return route.fulfill({ status: 404, json: { title: 'Unknown fixture endpoint', status: 404 } });
	});
}

async function fieldStyle(field: Locator) {
	await expect(field).toBeVisible();
	return field.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			height: element.getBoundingClientRect().height,
			fontSize: style.fontSize,
			fontWeight: style.fontWeight,
			lineHeight: style.lineHeight,
			paddingTop: style.paddingTop,
			paddingRight: style.paddingRight,
			paddingBottom: style.paddingBottom,
			paddingLeft: style.paddingLeft,
			borderWidth: style.borderTopWidth,
			borderRadius: style.borderTopLeftRadius,
			borderColor: style.borderTopColor,
			backgroundColor: style.backgroundColor,
			color: style.color
		};
	});
}

async function labelStyle(field: Locator) {
	return field.locator('xpath=..').evaluate((label) => {
		const style = getComputedStyle(label);
		return { display: style.display, gap: style.rowGap, fontSize: style.fontSize, fontWeight: style.fontWeight };
	});
}

async function checkNarrowLayout(page: Page, field: Locator) {
	await page.setViewportSize({ width: 320, height: 844 });
	await expect(field).toBeVisible();
	const box = await field.boundingBox();
	if (!box) throw new Error('Filter field is not visible');
	expect.soft(box.x).toBeGreaterThanOrEqual(0);
	expect.soft(box.x + box.width).toBeLessThanOrEqual(320);
	expect.soft(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
	await page.setViewportSize({ width: 1280, height: 900 });
}

for (const theme of ['light', 'dark']) {
	test(`search controls share the header style in ${theme} mode`, async ({ page }) => {
		await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
		await mockApi(page);
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/books');
		const standard = await fieldStyle(page.getByRole('banner').getByRole('searchbox'));
		for (const destination of [
			{ path: '/bookheap', label: 'Search', button: 'Search' },
			{ path: '/notes', label: 'Search annotations', button: 'Search' },
			{ path: '/shelves/7', label: 'Find a book to add', button: 'Find' },
			{ path: '/books/21/highlights', label: 'Search highlights', button: 'Search' }
		]) {
			await page.goto(destination.path);
			const main = page.getByRole('main');
			const field = main.getByRole('searchbox');
			await expect(field).toHaveAccessibleName(destination.label);
			expect(await fieldStyle(field), destination.path).toEqual(standard);
			const button = main.getByRole('button', { name: destination.button, exact: true });
			await expect(button).toHaveCSS('background-color', 'rgb(4, 120, 87)');
			await expect(button.locator('svg')).toBeVisible();
			await checkNarrowLayout(page, field);
			if (destination.path === '/bookheap') {
				await field.fill('dune');
				await button.click();
				await expect(page).toHaveURL(/q=dune/);
			}
		}
	});

	test(`page filters match All Books in ${theme} mode`, async ({ page }) => {
		await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
		await mockApi(page);
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/books');

		const author = page.locator('#filter-author');
		const standard = await fieldStyle(author);
		const standardLabel = await labelStyle(author);
		const standardSearch = await fieldStyle(page.getByRole('banner').getByRole('searchbox'));
		const standardSearchButton = page.getByRole('banner').getByRole('button', { name: 'Search', exact: true });
		await expect(standardSearchButton).toHaveCSS('background-color', 'rgb(4, 120, 87)');
		expect(standard).toMatchObject({
			height: 36, fontSize: '14px', fontWeight: '400', lineHeight: 'normal',
			paddingTop: '0px', paddingRight: '12px', paddingBottom: '0px', paddingLeft: '12px',
			borderWidth: '1px', borderRadius: '6px'
		});
		expect(standardSearch, 'filters and search boxes share one control token').toEqual(standard);
		for (const name of ['Switch to list view', 'Clear filters']) {
			expect((await page.getByRole('main').getByRole('button', { name }).boundingBox())?.height, name).toBe(36);
		}
		expect((await author.boundingBox())?.width).toBe(160);
		await checkNarrowLayout(page, author);

		await page.goto('/bookheap');
		const status = page.getByRole('main').getByRole('combobox', { name: 'Status', exact: true });
		const search = page.getByRole('main').getByRole('searchbox', { name: 'Search', exact: true });
		expect.soft(await fieldStyle(status), 'Bookheap status').toEqual(standard);
		expect.soft(await fieldStyle(search), 'Bookheap search').toEqual(standardSearch);
		await expect(page.getByRole('main').getByRole('button', { name: 'Search', exact: true })).toHaveCSS('background-color', 'rgb(4, 120, 87)');
		expect.soft((await status.boundingBox())!.width).toBeGreaterThanOrEqual(160);
		const searchBox = await search.boundingBox();
		expect.soft(searchBox!.width).toBeGreaterThanOrEqual(160);
		expect.soft(searchBox!.width).toBeLessThanOrEqual(384);
		const placeholder = await search.evaluate((element) => {
			if (!(element instanceof HTMLInputElement)) throw new Error('Search field is not an input');
			const style = getComputedStyle(element);
			const canvas = document.createElement('canvas');
			const context = canvas.getContext('2d');
			if (!context) throw new Error('Canvas text measurement is unavailable');
			context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			return {
				width: context.measureText(element.placeholder).width,
				available: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
			};
		});
		expect.soft(placeholder.width).toBeLessThanOrEqual(placeholder.available);
		const toolbar = await page.getByRole('main').getByRole('search').locator('select, input[type="search"], button')
			.evaluateAll((elements) => elements.map((element) => {
				const rect = element.getBoundingClientRect();
				return { top: Math.round(rect.top), height: rect.height };
			}));
		expect.soft(new Set(toolbar.map((control) => control.top)).size, 'Bookheap toolbar shares one row').toBe(1);
		expect.soft(toolbar.map((control) => control.height), 'Bookheap toolbar heights').toEqual(toolbar.map(() => 36));
		await checkNarrowLayout(page, search);
		await status.selectOption('ready');
		await search.fill('dune');
		await search.press('Enter');
		await expect(page).toHaveURL(/status=ready/);
		await expect(page).toHaveURL(/q=dune/);
		await page.getByRole('main').getByRole('search').getByRole('button', { name: 'Clear filters' }).click();
		await expect(search).toHaveValue('');

		await page.goto('/stats');
		for (const field of [page.locator('#stats-from'), page.locator('#stats-to')]) {
			expect.soft(await fieldStyle(field), 'Stats date').toEqual(standard);
			expect.soft(await labelStyle(field), 'Stats date label').toEqual(standardLabel);
		}
		await checkNarrowLayout(page, page.locator('#stats-from'));

		await page.goto('/notes');
		const notes = page.locator('#notes-query');
		expect.soft(await fieldStyle(notes), 'Annotation search').toEqual(standardSearch);
		await expect(page.getByRole('main').getByRole('button', { name: 'Search', exact: true })).toHaveCSS('background-color', 'rgb(4, 120, 87)');
		await checkNarrowLayout(page, notes);

		await page.goto('/shelves/7');
		const shelfSearch = page.locator('#add-book-query');
		expect.soft(await fieldStyle(shelfSearch), 'Shelf search').toEqual(standardSearch);
		await checkNarrowLayout(page, shelfSearch);

		await page.goto('/books/21/files');
		const fileSort = page.getByRole('combobox', { name: 'Sort files', exact: true });
		expect.soft(await fieldStyle(fileSort), 'File sort').toEqual(standard);
		expect.soft(await labelStyle(fileSort), 'File sort label').toEqual(standardLabel);
		await checkNarrowLayout(page, fileSort);
		await fileSort.selectOption('name');
		await expect(fileSort).toHaveValue('name');

		await page.goto('/books/21/highlights');
		const highlightsSearch = page.getByRole('searchbox', { name: 'Search highlights' });
		const highlightsSort = page.getByRole('combobox', { name: 'Sort highlights', exact: true });
		expect.soft(await fieldStyle(highlightsSearch), 'Highlights search').toEqual(standardSearch);
		expect.soft(await fieldStyle(highlightsSort), 'Highlights sort').toEqual(standard);
		await checkNarrowLayout(page, highlightsSearch);
		await highlightsSort.selectOption('newest');
		await expect(page).toHaveURL(/sort=newest/);
	});
}
