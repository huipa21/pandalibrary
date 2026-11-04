import { expect, test, type Page } from '@playwright/test';

async function authenticate(page: Page, locale = 'en') {
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
	await page.route('**/api/v1/libraries?*', async (route) => {
		attempts += 1;
		if (attempts === 1) {
			await new Promise((resolve) => setTimeout(resolve, 300));
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
	await expect(page.getByRole('status')).toHaveText('正在加载目录…');
	await expect(page.getByRole('alert')).toContainText('目录请求失败');
	await page.getByRole('button', { name: '重试' }).click();
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
	await expect(page.getByRole('heading', { name: 'A Book' })).toBeVisible();
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
