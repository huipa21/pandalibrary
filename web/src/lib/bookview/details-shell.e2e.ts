import { expect, test, type Page } from '@playwright/test';

function makeBook(id: number) {
	return {
		id,
		library_id: 1,
		title: `Shell Book ${id}`,
		sort_title: `Shell Book ${id}`,
		subtitle: null,
		description: null,
		language: null,
		publisher: null,
		published_date: null,
		page_count: null,
		cover_url: null,
		cover_source: null,
		authors: [],
		series: null,
		tags: [],
		identifiers: [],
		files: [{ id: id * 10, format: 'epub', size_bytes: 2048, download_url: `/api/v1/books/${id}/files/${id * 10}?v=abc` }],
		field_sources: [],
		created_at: '2026-11-07T00:00:00Z',
		updated_at: '2026-11-07T00:00:00Z'
	};
}

const books = [1, 2, 3].map(makeBook);

async function mockApi(page: Page, role = 'user') {
	const detailRequests = new Map<number, number>();
	await page.route('**/api/v1/**', (route) =>
		route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not Found', status: 404 }) })
	);
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: role, display_name: role, role, locale: 'en' } } })
	);
	await page.route('**/api/v1/shelves**', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route('**/api/v1/books?*', (route) => route.fulfill({ json: { items: books, next_cursor: null } }));
	await page.route((url) => /^\/api\/v1\/books\/\d+$/.test(url.pathname), (route) => {
		const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
		detailRequests.set(id, (detailRequests.get(id) ?? 0) + 1);
		const book = books.find((item) => item.id === id);
		return book
			? route.fulfill({ json: { book } })
			: route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not Found', status: 404 }) });
	});
	return detailRequests;
}

const tabBar = (page: Page) => page.getByRole('navigation', { name: 'Book sections' });

test('tabs navigate, mark the current tab, and share one book request', async ({ page }) => {
	const requests = await mockApi(page);
	await page.goto('/books/2');
	await expect(page.getByRole('heading', { name: 'Shell Book 2' })).toBeVisible();
	await expect(page).toHaveTitle('Shell Book 2 · Details');
	const tabs = tabBar(page);
	await expect(tabs.getByRole('link', { name: 'Details' })).toHaveAttribute('aria-current', 'page');

	for (const [name, path] of [['Files', '/books/2/files'], ['Reading Log', '/books/2/reading-log'], ['Highlights', '/books/2/highlights']] as const) {
		await tabs.getByRole('link', { name }).click();
		await expect(page).toHaveURL(path);
		await expect(tabs.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
		await expect(tabs.getByRole('link', { name: 'Details' })).not.toHaveAttribute('aria-current', 'page');
		await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
		await expect(page.getByText('Coming soon')).toBeVisible();
		await expect(page).toHaveTitle(`Shell Book 2 · ${name}`);
	}
	await tabs.getByRole('link', { name: 'Details' }).click();
	await expect(page).toHaveURL('/books/2');
	await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/v1/books/2/files/20?v=abc');
	expect(requests.get(2)).toBe(1);

	// A direct visit has no browse context, so previous/next is hidden and Back falls back to /books.
	await expect(page.getByRole('button', { name: 'Next book' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Previous book' })).toHaveCount(0);
	await tabs.getByRole('link', { name: 'Back to books' }).click();
	await expect(page).toHaveURL('/books');
});

test('previous and next step through the list the book was opened from', async ({ page }) => {
	const requests = await mockApi(page);
	await page.goto('/books');
	await page.getByRole('link', { name: 'Shell Book 1' }).first().click();
	await expect(page).toHaveURL('/books/1');
	await expect(page.getByText('1 / 3', { exact: true })).toBeVisible();
	const previous = page.getByRole('button', { name: 'Previous book' });
	const next = page.getByRole('button', { name: 'Next book' });
	await expect(previous).toBeDisabled();
	await expect(next).toBeEnabled();

	await next.click();
	await expect(page).toHaveURL('/books/2');
	await expect(page.getByRole('heading', { name: 'Shell Book 2' })).toBeVisible();
	await expect(page.getByText('2 / 3', { exact: true })).toBeVisible();
	await expect(previous).toBeEnabled();

	await tabBar(page).getByRole('link', { name: 'Files' }).click();
	await expect(page).toHaveURL('/books/2/files');
	await page.keyboard.press(']');
	await expect(page).toHaveURL('/books/3/files');
	await expect(page.getByText('3 / 3', { exact: true })).toBeVisible();
	await expect(page).toHaveTitle('Shell Book 3 · Files');
	await expect(next).toBeDisabled();
	await page.keyboard.press('[');
	await expect(page).toHaveURL('/books/2/files');
	await expect(page.getByText('2 / 3', { exact: true })).toBeVisible();
	expect(requests.get(2)).toBe(2);

	await tabBar(page).getByRole('link', { name: 'Back to books' }).click();
	await expect(page).toHaveURL('/books');
	await expect(page.getByRole('link', { name: 'Shell Book 3' }).first()).toBeVisible();
});

test('the edit page has no tab bar', async ({ page }) => {
	await mockApi(page, 'admin');
	await page.goto('/books/2/edit');
	await expect(page.getByRole('heading', { name: 'Edit metadata: Shell Book 2' })).toBeVisible();
	await expect(tabBar(page)).toHaveCount(0);
});

test('an invalid or missing book shows the error state', async ({ page }) => {
	await mockApi(page);
	await page.goto('/books/not-a-number');
	await expect(page.getByRole('main').getByRole('alert')).toContainText('This item is unavailable or you do not have access.');
	await expect(page.getByRole('link', { name: 'Back to libraries' })).toBeVisible();
	await expect(tabBar(page)).toHaveCount(0);

	await page.goto('/books/99');
	await expect(page.getByRole('main').getByRole('alert')).toContainText('This item is unavailable or you do not have access.');
	await expect(page.getByRole('main').getByRole('button', { name: 'Try again' })).toBeVisible();
});
