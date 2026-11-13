import { expect, test, type Locator, type Page } from '@playwright/test';
import { epubFixture } from '../reader/fixtures';

function makeBook(id: number) {
	return {
		id,
		library_id: 1,
		owner_id: null,
		visibility: 'library',
		can_manage_visibility: false,
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
		authors: [{ id: 9, name: 'Ann Author', role: 'author', position: 0 }],
		series: null,
		tags: [],
		identifiers: [],
		files: [{
			id: id * 10, format: 'epub', size_bytes: 2048, original_filename: `Shell Book ${id}.epub`,
			created_at: '2026-11-07T00:00:00Z', download_url: `/api/v1/books/${id}/files/${id * 10}?v=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
		}],
		field_sources: [],
		created_at: '2026-11-07T00:00:00Z',
		updated_at: '2026-11-07T00:00:00Z'
	};
}

const books = [1, 2, 3].map(makeBook);
const shelf = {
	id: 5, kind: 'shared', owner_id: null, name: 'Shelf Five', description: null, created_by: 1,
	visible_book_count: 3, created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:00:00Z',
	mode: 'manual', system_key: null, rules: null
};
const dashboardRows: Record<string, number[]> = {
	continue_reading: [2, 1],
	recently_added: [1, 2, 3],
	read: []
};

async function mockApi(page: Page, role = 'user') {
	const detailRequests = new Map<number, number>();
	await page.route('**/api/v1/**', (route) =>
		route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not Found', status: 404 }) })
	);
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/sync/push', (route) => {
		const body = route.request().postDataJSON() as { mutations: unknown[] };
		return route.fulfill({ json: { results: body.mutations.map((_, index) => ({ index, status: 'applied' })) } });
	});
	await page.route('**/api/v1/me/settings', (route) => route.fulfill({ json: { settings: [] } }));
	await page.route('**/api/v1/me/book-states?*', (route) => route.fulfill({ json: { items: [] } }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: role, display_name: role, role, locale: 'en' } } })
	);
	await page.route('**/api/v1/shelves**', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route('**/api/v1/shelves/5', (route) => route.fulfill({ json: { shelf } }));
	await page.route('**/api/v1/shelves/5/books?*', (route) => route.fulfill({ json: { items: books, next_cursor: null } }));
	await page.route((url) => /^\/api\/v1\/dashboard\/sections\/[^/]+\/books$/.test(url.pathname), (route) => {
		const section = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
		const ids = dashboardRows[section] ?? [];
		return route.fulfill({ json: { items: ids.map((id) => books[id - 1]), next_cursor: null } });
	});
	await page.route('**/api/v1/libraries/1', (route) =>
		route.fulfill({ json: { library: { id: 1, name: 'Library' } } })
	);
	await page.route((url) => /^\/api\/v1\/me\/books\/\d+$/.test(url.pathname), (route) =>
		route.fulfill({ json: { user_book: null, progress: null, highlights: [], bookmarks: [], notes: [] } })
	);
	await page.route('**/api/v1/books/*/reviews?*', (route) =>
		route.fulfill({ json: { mine: null, items: [], next_cursor: null, total: 0 } })
	);
	await page.route('**/api/v1/books?*', (route) => route.fulfill({ json: { items: books, next_cursor: null } }));
	await page.route((url) => /^\/api\/v1\/(?:authors|series|tags)$/.test(url.pathname),
		(route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route((url) => /^\/api\/v1\/books\/\d+\/files\/\d+$/.test(url.pathname), (route) =>
		route.fulfill({ status: 200, contentType: 'application/octet-stream', body: epubFixture() })
	);
	await page.route((url) => /^\/api\/v1\/me\/books\/\d+\/reading-summary$/.test(url.pathname), (route) =>
		route.fulfill({ json: { summary: {
			progress: 0, sessions: 0, total_seconds: 0, average_seconds: 0, active_days: 0, span_days: 0,
			first_read_at: null, last_read_at: null, pace_percent_per_hour: null, estimated_seconds_left: null,
			records: { longest_session: null, best_day: null, longest_streak_days: 0 }, attempts: [], days: []
		} } }));
	await page.route((url) => /^\/api\/v1\/me\/books\/\d+\/sessions$/.test(url.pathname), (route) =>
		route.fulfill({ json: { items: [], next_cursor: null, total: 0 } }));
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
const backIcon = (page: Page) => tabBar(page).getByRole('link', { name: /^Back/ });
const bookHeading = (page: Page, id: number) => page.getByRole('heading', { name: `Shell Book ${id}`, level: 1 });

async function openTile(scope: Page | Locator, id: number) {
	await scope.getByTitle(`Shell Book ${id}`, { exact: true }).first().click({ position: { x: 10, y: 40 } });
}

test('tabs navigate, mark the current tab, and share one book request', async ({ page }) => {
	const requests = await mockApi(page);
	await page.goto('/books/2');
	await expect(bookHeading(page, 2)).toBeVisible();
	await expect(page).toHaveTitle('Shell Book 2 · Details');
	const tabs = tabBar(page);
	await expect(tabs.getByRole('link', { name: 'Details' })).toHaveAttribute('aria-current', 'page');

	for (const [name, path] of [['Files', '/books/2/files'], ['Activities', '/books/2/activities'], ['Annotations', '/books/2/highlights']] as const) {
		await tabs.getByRole('link', { name }).click();
		await expect(page).toHaveURL(path);
		await expect(tabs.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
		await expect(tabs.getByRole('link', { name: 'Details' })).not.toHaveAttribute('aria-current', 'page');
		if (name === 'Files') {
			await expect(page.getByRole('heading', { name, level: 1 })).toHaveCount(1);
			await expect(page.getByRole('region', { name: 'This file' })).toBeVisible();
		} else if (name === 'Activities') {
			await expect(page.getByRole('heading', { name, level: 1 })).toHaveCount(1);
			await expect(page.getByRole('heading', { name: 'Reading summary' })).toBeVisible();
		} else {
			await expect(page.getByRole('heading', { name: 'Annotations in Shell Book 2', level: 1 })).toBeAttached();
			await expect(page.getByText('No annotations yet – your annotations for this book appear here')).toBeVisible();
		}
		await expect(page).toHaveTitle(`Shell Book 2 · ${name}`);
	}
	await expect(tabs.getByText('Books', { exact: true })).toHaveCount(0);
	await tabs.getByRole('link', { name: 'Details' }).click();
	await expect(page).toHaveURL('/books/2');
	await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
	expect(requests.get(2)).toBe(1);
});

test('a deep link in a fresh tab hides previous/next and goes back to the Dashboard', async ({ page }) => {
	await mockApi(page);
	await page.goto('/books/2/files');
	await expect(page).toHaveTitle('Shell Book 2 · Files');
	await expect(page.getByRole('button', { name: 'Next book', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Previous book', exact: true })).toHaveCount(0);
	await expect(backIcon(page)).toHaveAccessibleName('Back to Dashboard');
	await expect(backIcon(page)).toHaveAttribute('href', '/');
	await backIcon(page).click();
	await expect(page).toHaveURL('/');
	await expect(page.locator('[data-dashboard-section="recently_added"]')).toBeVisible();
});

test('Dashboard → book → back restores the Dashboard and its scroll position', async ({ page }) => {
	await mockApi(page);
	await page.setViewportSize({ width: 1024, height: 520 });
	await page.goto('/');
	const row = page.locator('[data-dashboard-section="recently_added"]');
	const tile = row.getByTitle('Shell Book 2', { exact: true });
	await tile.scrollIntoViewIfNeeded();
	await expect(tile).toBeVisible();
	const scrollY = await page.evaluate(() => window.scrollY);
	expect(scrollY).toBeGreaterThan(0);

	await tile.click({ position: { x: 10, y: 40 } });
	await expect(page).toHaveURL('/books/2');
	await expect(bookHeading(page, 2)).toBeVisible();
	const back = backIcon(page);
	await expect(back).toHaveAccessibleName('Back to Dashboard');
	await expect(back).toHaveAttribute('title', 'Back to Dashboard');
	await expect(back).toHaveAttribute('href', '/');
	await back.click();
	await expect(page).toHaveURL('/');
	await expect(row.getByTitle('Shell Book 2', { exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollY - 5);
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(scrollY + 5);
});

test('Dashboard rows drive previous/next and replace a stale All Books list', async ({ page }) => {
	await mockApi(page);
	await page.goto('/books');
	await expect(page.getByTitle('Shell Book 3', { exact: true })).toBeVisible();

	// A deep link after browsing All Books does not reuse that list.
	await page.goto('/books/2');
	await expect(bookHeading(page, 2)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Next book', exact: true })).toHaveCount(0);

	await page.goto('/');
	await openTile(page.locator('[data-dashboard-section="continue_reading"]'), 2);
	await expect(page).toHaveURL('/books/2');
	await expect(page.getByRole('group', { name: /Continue Reading/ })).toBeVisible();
	await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Previous book', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: 'Next book', exact: true }).click();
	await expect(page).toHaveURL('/books/1');
	await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();

	await backIcon(page).click();
	await expect(page).toHaveURL('/');
	await openTile(page.locator('[data-dashboard-section="recently_added"]'), 2);
	await expect(page).toHaveURL('/books/2');
	await expect(page.getByRole('group', { name: /Recently Added/ })).toBeVisible();
	await expect(page.getByText('2 / 3', { exact: true })).toBeVisible();
});

test('previous and next step through the list the book was opened from', async ({ page }) => {
	const requests = await mockApi(page);
	await page.goto('/books');
	await openTile(page, 1);
	await expect(page).toHaveURL('/books/1');
	await expect(page.getByText('1 / 3', { exact: true })).toBeVisible();
	const previous = page.getByRole('button', { name: 'Previous book', exact: true });
	const next = page.getByRole('button', { name: 'Next book', exact: true });
	await expect(previous).toBeDisabled();
	await expect(next).toBeEnabled();

	await next.click();
	await expect(page).toHaveURL('/books/2');
	await expect(bookHeading(page, 2)).toBeVisible();
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

	await backIcon(page).click();
	await expect(page).toHaveURL('/books');
	await expect(page.getByTitle('Shell Book 3', { exact: true })).toBeVisible();
});

test('shelf → book → reader → close → back icon returns to the shelf', async ({ page }) => {
	await mockApi(page);
	await page.goto('/shelves/5');
	await expect(page.getByRole('heading', { name: 'Shelf Five' })).toHaveClass('sr-only');
	await openTile(page, 1);
	await expect(page).toHaveURL('/books/1');
	await expect(backIcon(page)).toHaveAccessibleName('Back to Shelf Five');

	await page.getByRole('button', { name: /^(Read|Resume)$/ }).click();
	await expect(page).toHaveURL('/read/1/10');
	await expect(page.getByRole('heading', { name: 'Shell Book 1' })).toBeVisible();
	await page.getByRole('button', { name: 'Close reader' }).click();
	await expect(page).toHaveURL('/books/1');
	await expect(bookHeading(page, 1)).toBeVisible();

	await expect(backIcon(page)).toHaveAttribute('href', '/shelves/5');
	await expect(page.getByText('1 / 3', { exact: true })).toBeVisible();
	await backIcon(page).click();
	await expect(page).toHaveURL('/shelves/5');
	await expect(page.getByRole('heading', { name: 'Shelf Five' })).toHaveClass('sr-only');
});

test('All Books with a query → tabs → back returns to the same URL', async ({ page }) => {
	await mockApi(page);
	await page.goto('/books?sort=added');
	await openTile(page, 3);
	await expect(page).toHaveURL('/books/3');
	await tabBar(page).getByRole('link', { name: 'Files' }).click();
	await expect(page).toHaveURL('/books/3/files');
	await tabBar(page).getByRole('link', { name: 'Activities' }).click();
	await expect(page).toHaveURL('/books/3/activities');
	await expect(backIcon(page)).toHaveAttribute('href', '/books?sort=added');
	await backIcon(page).click();
	await expect(page).toHaveURL('/books?sort=added');
	await expect(page.getByTitle('Shell Book 3', { exact: true })).toBeVisible();
});

test('book → metadata editor → Back to book → back icon returns to the list', async ({ page }) => {
	await mockApi(page, 'admin');
	await page.goto('/books');
	await openTile(page, 2);
	await expect(page).toHaveURL('/books/2');
	await page.getByRole('link', { name: 'Edit metadata' }).first().click();
	await expect(page).toHaveURL('/books/2/edit');
	await expect(page.getByRole('heading', { name: 'Edit metadata: Shell Book 2' })).toBeVisible();
	await expect(tabBar(page)).toHaveCount(0);
	await page.getByRole('link', { name: 'Back to book' }).click();
	await expect(page).toHaveURL('/books/2');
	await expect(backIcon(page)).toHaveAttribute('href', '/books');
	await backIcon(page).click();
	await expect(page).toHaveURL('/books');
});

test('a related-book link keeps the original origin', async ({ page }) => {
	await mockApi(page);
	await page.goto('/shelves/5');
	await openTile(page, 1);
	await expect(page).toHaveURL('/books/1');
	const related = page.locator('section[aria-labelledby="related-books-heading"]');
	await openTile(related, 2);
	await expect(page).toHaveURL('/books/2');
	await expect(bookHeading(page, 2)).toBeVisible();
	await expect(backIcon(page)).toHaveAccessibleName('Back to Shelf Five');
	await backIcon(page).click();
	await expect(page).toHaveURL('/shelves/5');
});

test('the legacy reading-log URL opens the Activities tab', async ({ page }) => {
	await mockApi(page);
	await page.goto('/books/2/reading-log?range=all');
	await expect(page).toHaveURL('/books/2/activities?range=all');
	await expect(tabBar(page).getByRole('link', { name: 'Activities' })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByRole('heading', { name: 'Activities', level: 1 })).toHaveCount(1);
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
