import { expect, test, type Page } from '@playwright/test';

async function authenticate(page: Page, role = 'user', locale = 'en') {
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role, locale } } })
	);
	await page.route('**/api/v1/shelves?*', (route) => route.fulfill({ json: {
		items: [{
			id: 7, kind: 'private', owner_id: 1, name: 'Weekend reads', description: null, created_by: 1,
			visible_book_count: 3, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
		}],
		next_cursor: null
	} }));
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: {
		items: [{ id: 1, name: 'Fiction', slug: 'fiction', created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z' }],
		next_cursor: null
	} }));
}

const book = {
	id: 21, library_id: 1, title: 'A Book', sort_title: 'A Book', subtitle: null, description: null,
	language: null, publisher: null, published_date: null, page_count: null, cover_url: null, cover_source: null,
	authors: [{ id: 4, name: 'A Writer', role: 'author', position: 0 }], series: null, tags: [],
	identifiers: [], files: [], field_sources: [],
	created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
};

async function mockCatalog(page: Page) {
	const bookQueries: URLSearchParams[] = [];
	await page.route('**/api/v1/books?*', (route) => {
		bookQueries.push(new URL(route.request().url()).searchParams);
		return route.fulfill({ json: { items: [book], next_cursor: null } });
	});
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book } }));
	for (const kind of ['authors', 'series', 'tags']) {
		await page.route(`**/api/v1/${kind}?*`, (route) => route.fulfill({ json: {
			items: kind === 'authors' ? [{ id: 4, name: 'A Writer', visible_book_count: 1 }] : [], next_cursor: null
		} }));
	}
	return bookQueries;
}

async function expectNoHorizontalOverflow(page: Page) {
	const widths = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		content: document.documentElement.scrollWidth
	}));
	expect(widths.content).toBeLessThanOrEqual(widths.viewport);
}

test('desktop sidebar lists HOME links, shelves, and All Books across every library', async ({ page }) => {
	await authenticate(page);
	const bookQueries = await mockCatalog(page);
	await page.setViewportSize({ width: 1280, height: 800 });

	await page.goto('/books?author_id=4&sort=added');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await expect(sidebar).toBeVisible();
	await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeHidden();
	const home = sidebar.getByRole('region', { name: 'Home' }).getByRole('link');
	await expect(home).toHaveText(['Dashboard', 'All Books', 'Bookmarks', 'Notes']);
	await expect(sidebar.getByRole('link', { name: 'All Books' })).toHaveAttribute('aria-current', 'page');
	await expect(sidebar.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current', 'page');
	await expect(sidebar.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
	for (const name of ['Libraries', 'Authors', 'Series', 'Tags', 'Read', 'Search', 'Stats']) {
		await expect(sidebar.getByRole('link', { name, exact: true })).toBeVisible();
	}

	const shelves = sidebar.getByRole('region', { name: 'Shelves' });
	await expect(shelves.getByRole('link', { name: /Weekend reads/ })).toHaveAttribute('href', '/shelves/7');
	await expect(shelves.getByRole('link', { name: 'New shelf' })).toHaveAttribute('href', '/shelves');
	await expect(page.locator('[data-slot="sidebar-footer"]')).toBeVisible();

	await expect(page.getByRole('heading', { name: 'All Books', level: 1 })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'A Book' })).toBeVisible();
	await expect(page.getByLabel('Author')).toHaveValue('4');
	expect(bookQueries[0].has('library_id')).toBe(false);
	expect(bookQueries[0].get('author_id')).toBe('4');
	expect(bookQueries[0].get('sort')).toBe('added');
	await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	await expectNoHorizontalOverflow(page);

	const box = await page.locator('#app-sidebar').boundingBox();
	expect(box?.width).toBeGreaterThanOrEqual(240);
	expect(box?.width).toBeLessThanOrEqual(260);
	const main = await page.locator('#main-content').boundingBox();
	expect(main?.width).toBeGreaterThan(900);

	await page.getByRole('link', { name: 'A Book' }).first().click();
	await expect(page).toHaveURL('/books/21');
	await expect(sidebar.getByRole('link', { name: 'All Books' })).not.toHaveAttribute('aria-current', 'page');

	await sidebar.getByRole('link', { name: 'Libraries', exact: true }).click();
	await expect(page).toHaveURL('/libraries');
	await expect(page.getByRole('link', { name: 'Fiction' })).toHaveAttribute('href', '/library/1');
	await expect(sidebar.getByRole('link', { name: 'Libraries', exact: true })).toHaveAttribute('aria-current', 'page');

	await sidebar.getByRole('link', { name: 'Dashboard' }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
});

test('administrators see the Admin entry with localized Chinese navigation', async ({ page }) => {
	await authenticate(page, 'admin', 'zh');
	await page.goto('/');
	const sidebar = page.getByRole('navigation', { name: '主导航' });
	await expect(sidebar.getByRole('region', { name: '主页' }).getByRole('link')).toHaveText(['仪表盘', '全部图书', '书签', '笔记']);
	await expect(sidebar.getByRole('link', { name: '管理', exact: true })).toHaveAttribute('href', '/admin');
	await expect(sidebar.getByRole('link', { name: '新建书架' })).toBeVisible();
	await expect(sidebar.getByRole('link', { name: '仪表盘' })).toHaveAttribute('aria-current', 'page');
});

test('mobile drawer toggles by keyboard, traps focus, closes on Escape and navigation', async ({ page }) => {
	await authenticate(page);
	await mockCatalog(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

	const toggle = page.getByRole('button', { name: 'Open navigation menu' });
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
	await expectNoHorizontalOverflow(page);

	await toggle.focus();
	await page.keyboard.press('Enter');
	const close = page.getByRole('button', { name: 'Close navigation menu' });
	await expect(close).toHaveAttribute('aria-expanded', 'true');
	const drawer = page.getByRole('dialog', { name: 'Sidebar' });
	await expect(drawer).toBeVisible();
	await expect(drawer.getByRole('link', { name: 'Dashboard' })).toBeFocused();
	await expect(drawer.getByRole('button', { name: 'Sign out' })).toBeVisible();

	await page.keyboard.press('Shift+Tab');
	await expect(close).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(drawer.locator(':focus')).toHaveCount(1);
	await expectNoHorizontalOverflow(page);

	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden();
	await expect(toggle).toBeFocused();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');

	await toggle.click();
	await page.getByRole('dialog', { name: 'Sidebar' }).getByRole('link', { name: 'All Books' }).click();
	await expect(page).toHaveURL('/books');
	await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeHidden();
	await expect(page.getByRole('heading', { name: 'A Book' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('public pages keep the language switch without the sidebar', async ({ page }) => {
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) => route.fulfill({
		status: 401, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Unauthorized', status: 401 })
	}));
	await page.goto('/books');
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Language' })).toBeVisible();
	await expect(page.locator('#app-sidebar')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Open navigation menu' })).toHaveCount(0);
});
