import { expect, test, type Page } from '@playwright/test';

async function authenticate(page: Page, locale = 'en') {
	await page.route('**/api/v1/me/book-states?*', (route) => route.fulfill({ json: { items: [] } }));
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({
			json: {
				user: {
					id: 1,
					username: 'reader',
					display_name: 'Reader',
					role: 'user',
					locale
				}
			}
		})
	);
}

test('renders localized loading, API error, and empty library states', async ({ page }) => {
	await authenticate(page, 'zh');
	let attempts = 0;
	let releaseFirstResponse: () => void = () => {};
	const firstResponse = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
	await page.route('**/api/v1/libraries?*', async (route) => {
		attempts += 1;
		if (attempts === 1) {
			await firstResponse;
			await route.fulfill({
				status: 503,
				contentType: 'application/problem+json',
				body: JSON.stringify({ title: 'Unavailable', status: 503 })
			});
			return;
		}
		await route.fulfill({ json: { items: [], next_cursor: null } });
	});

	await page.goto('/libraries');
	try {
		await expect(page.getByRole('main').getByRole('status')).toHaveText('正在加载目录…');
	} finally {
		releaseFirstResponse();
	}
	await expect(page.getByRole('alert')).toContainText('目录请求失败');
	await page.getByRole('main').getByRole('button', { name: '重试' }).click();
	await expect(page.getByText('你的账户目前无法访问任何书库。')).toBeVisible();
});

test('filters and sorts with server cursors, then opens a hash-versioned download', async ({ page }) => {
	await authenticate(page);
	const bookQueries: URLSearchParams[] = [];
	const book = {
		id: 21,
		library_id: 1,
		title: 'A Book',
		sort_title: 'A Book',
		subtitle: null,
		description: null,
		language: null,
		publisher: null,
		published_date: null,
		page_count: null,
		cover_url: null,
		cover_source: null,
		authors: [{ id: 4, name: 'A Writer', role: 'author', position: 0 }],
		series: { id: 8, name: 'A Series', index: 1 },
		tags: [{ id: 9, name: 'Fantasy' }],
		identifiers: [{ scheme: 'isbn13', value: '9781234567890' }],
		files: [
			{
				id: 31,
				format: 'epub',
				size_bytes: 4096,
				download_url: '/api/v1/books/21/files/31?v=abc123'
			}
		],
		field_sources: [],
		created_at: '2026-11-03T00:00:00Z',
		updated_at: '2026-11-03T00:00:00Z'
	};

	await page.route('**/api/v1/libraries/1', (route) =>
		route.fulfill({
			json: {
				library: {
					id: 1,
					name: 'Fiction',
					slug: 'fiction',
					created_at: '2026-11-03T00:00:00Z',
					updated_at: '2026-11-03T00:00:00Z'
				}
			}
		})
	);
	await page.route('**/api/v1/authors**', (route) =>
		route.fulfill({ json: { items: [{ id: 4, name: 'A Writer', visible_book_count: 1 }], next_cursor: null } })
	);
	await page.route('**/api/v1/series**', (route) =>
		route.fulfill({ json: { items: [{ id: 8, name: 'A Series', visible_book_count: 1 }], next_cursor: null } })
	);
	await page.route('**/api/v1/tags**', (route) =>
		route.fulfill({ json: { items: [{ id: 9, name: 'Fantasy', visible_book_count: 1 }], next_cursor: null } })
	);
	await page.route('**/api/v1/books?*', async (route) => {
		const params = new URL(route.request().url()).searchParams;
		bookQueries.push(params);
		if (params.has('cursor') || params.has('tag_id')) {
			await route.fulfill({ json: { items: [], next_cursor: null } });
			return;
		}
		await route.fulfill({ json: { items: [book], next_cursor: 'opaque/+cursor=' } });
	});
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book } }));

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/library/1?series_id=8&sort=series');
	await expect(page.getByTitle('A Book', { exact: true })).toBeVisible();
	const mobileWidths = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		content: document.documentElement.scrollWidth
	}));
	expect(mobileWidths.content).toBeLessThanOrEqual(mobileWidths.viewport);
	await page.getByRole('button', { name: 'Load more books' }).click();
	await expect(page.getByText('You have reached the end of the list.')).toBeVisible();
	expect(bookQueries[1].get('cursor')).toBe('opaque/+cursor=');

	await page.locator('#filter-series').selectOption('');
	await expect.poll(() => bookQueries.at(-1)?.get('sort')).toBe('title');
	expect(bookQueries.at(-1)?.has('cursor')).toBe(false);
	expect(bookQueries.at(-1)?.has('series_id')).toBe(false);

	await page.getByLabel('Tag').selectOption('9');
	await expect(page.getByText('No books match these filters.')).toBeVisible();
	expect(bookQueries.at(-1)?.get('tag_id')).toBe('9');
	expect(bookQueries.at(-1)?.has('cursor')).toBe(false);

	await page.goto('/books/21');
	await expect(page.getByRole('heading', { name: 'A Book' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute(
		'href',
		'/api/v1/books/21/files/31?v=abc123'
	);
});

test('All Books uses the standard tile grid', async ({ page }) => {
	await authenticate(page);
	const books = Array.from({ length: 6 }, (_, index) => ({
		id: 100 + index, library_id: 1, title: `Grid Book ${index + 1}`, sort_title: `Grid Book ${index + 1}`,
		subtitle: null, description: null, language: null, publisher: null, published_date: null,
		page_count: null, cover_url: null, cover_source: null,
		authors: [{ id: 4, name: 'A Writer', role: 'author', position: 0 }],
		series: null, tags: [], identifiers: [], files: [], field_sources: [],
		created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
	}));
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	for (const entity of ['authors', 'series', 'tags']) {
		await page.route(`**/api/v1/${entity}**`, (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	}
	await page.route('**/api/v1/books?*', (route) => route.fulfill({ json: { items: books, next_cursor: null } }));

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/books');
	const grid = page.locator('ul.book-grid');
	await expect(grid.getByTitle('Grid Book 1', { exact: true })).toHaveAttribute('href', '/books/100');
	const covers = grid.locator(':scope > li .book-cover');
	await expect(covers).toHaveCount(books.length);
	const geometry = await covers.evaluateAll((elements) => ({
		widths: elements.map((element) => element.getBoundingClientRect().width),
		standard: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--spacing-book')) *
			Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
	}));
	expect(geometry.standard).toBe(208);
	expect(geometry.widths).toEqual(books.map(() => geometry.standard));

	await page.setViewportSize({ width: 360, height: 800 });
	await expect(grid).toHaveCSS('grid-template-columns', /^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('All Books remembers filters, sort, and view until manually changed', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	for (const entity of ['authors', 'series', 'tags']) {
		await page.route(`**/api/v1/${entity}**`, (route) => route.fulfill({
			json: { items: [{ id: 4, name: `Saved ${entity}`, visible_book_count: 1 }], next_cursor: null }
		}));
	}
	const queries: URLSearchParams[] = [];
	await page.route('**/api/v1/books?*', (route) => {
		queries.push(new URL(route.request().url()).searchParams);
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});

	await page.goto('/books');
	await page.locator('#filter-author').selectOption('4');
	await page.locator('#filter-series').selectOption('4');
	await page.locator('#filter-tag').selectOption('4');
	await page.locator('#sort-books').selectOption('series');
	await page.locator('button[data-view="grid"]').click();
	await expect(page.locator('button[data-view="list"]')).toBeVisible();

	await page.getByRole('link', { name: 'Library', exact: true }).click();
	await expect(page).toHaveURL(/\/libraries$/);
	await page.getByRole('link', { name: /^All Books/ }).click();
	await expect(page.locator('#filter-author')).toHaveValue('4');
	await expect(page.locator('#filter-series')).toHaveValue('4');
	await expect(page.locator('#filter-tag')).toHaveValue('4');
	await expect(page.locator('#sort-books')).toHaveValue('series');
	await expect(page.locator('button[data-view="list"]')).toBeVisible();
	await expect.poll(() => queries.at(-1)?.get('tag_id')).toBe('4');

	await page.reload();
	await expect(page.locator('button[data-view="list"]')).toBeVisible();
	await page.getByRole('button', { name: 'Clear filters' }).click();
	await expect(page.locator('#filter-author')).toHaveValue('');
	await expect(page.locator('#filter-series')).toHaveValue('');
	await expect(page.locator('#filter-tag')).toHaveValue('');
	await expect(page.locator('#sort-books')).toHaveValue('title');
	await page.goto('/libraries');
	await page.getByRole('link', { name: /^All Books/ }).click();
	await expect(page.locator('#filter-tag')).toHaveValue('');
	await expect(page.locator('#sort-books')).toHaveValue('title');
	await expect(page.locator('button[data-view="list"]')).toBeVisible();

	await page.goto('/books?author_id=4&sort=added');
	await expect(page.locator('#filter-author')).toHaveValue('4');
	await expect(page.locator('#sort-books')).toHaveValue('added');
	await expect(page.locator('#filter-tag')).toHaveValue('');
	await page.locator('button[data-view="list"]').click();
	await page.goto('/books');
	await expect(page.locator('#filter-author')).toHaveValue('4');
	await expect(page.locator('#sort-books')).toHaveValue('added');
	await expect(page.locator('button[data-view="grid"]')).toBeVisible();
});

test('All Books sidebar entry shows the visible book count and refreshes on change events', async ({ page }) => {
	await authenticate(page);
	let response: { status: number; count: number } = { status: 200, count: 12 };
	let requests = 0;
	await page.route('**/api/v1/books/count', (route) => {
		requests += 1;
		if (response.status !== 200) {
			return route.fulfill({
				status: response.status,
				contentType: 'application/problem+json',
				body: JSON.stringify({ title: 'Failed', status: response.status })
			});
		}
		return route.fulfill({ json: { count: response.count } });
	});
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/libraries');
	const link = page.getByRole('link', { name: 'All Books' });
	const badge = link.getByTestId('all-books-count');
	const number = badge.locator('[aria-hidden="true"]');
	await expect(number).toHaveText('12');
	await expect(badge).toHaveAttribute('title', '12 books');
	await expect(link).toHaveAccessibleName('All Books 12 books');

	response = { status: 200, count: 0 };
	await page.evaluate(() => window.dispatchEvent(new Event('pandalibrary-books-changed')));
	await expect(number).toHaveText('0');

	response = { status: 200, count: 13 };
	await page.evaluate(() => window.dispatchEvent(new Event('pandalibrary-bookheap-changed')));
	await expect(number).toHaveText('13');
	await expect(badge).toHaveAttribute('title', '13 books');

	response = { status: 500, count: 0 };
	const before = requests;
	await page.evaluate(() => window.dispatchEvent(new Event('pandalibrary-books-changed')));
	await expect.poll(() => requests).toBeGreaterThan(before);
	await expect(badge).toHaveCount(0);
});
