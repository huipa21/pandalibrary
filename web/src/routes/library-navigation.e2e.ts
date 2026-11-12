import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const timestamp = '2026-11-12T00:00:00Z';
const libraries = [
	{ id: 1, name: 'Fiction', slug: 'fiction', visible_book_count: 7, created_at: timestamp, updated_at: timestamp },
	{ id: 2, name: 'History', slug: 'history', visible_book_count: 2, created_at: timestamp, updated_at: timestamp }
];

async function mockLibraries(page: Page, role = 'admin', locale = 'en') {
	const requests: URL[] = [];
	const unexpected: string[] = [];
	await page.route((url) => url.pathname.startsWith('/api/v1/'), (route) => {
		const url = new URL(route.request().url());
		requests.push(url);
		const path = url.pathname.replace('/api/v1', '');
		const scope = Number(url.searchParams.get('library_id'));
		const shelf = (id: number, name: string, system_key: string | null = null) => ({
			id, name, kind: 'private', mode: system_key ? 'system' : 'manual', system_key,
			owner_id: 1, description: null, created_by: 1, visible_book_count: scope === 2 ? 1 : 3,
			created_at: timestamp, updated_at: timestamp
		});
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: {
			user: { id: 1, username: role, display_name: role, role, locale }
		} });
		if (path === '/version') return route.fulfill({ json: {
			version: 'test', commit: 'test', commit_date: timestamp, dirty: false, release: null
		} });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: []
		} });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/libraries') return route.fulfill({ json: { items: libraries, next_cursor: null } });
		const libraryMatch = /^\/libraries\/(\d+)$/.exec(path);
		if (libraryMatch) return route.fulfill({ json: {
			library: libraries.find((library) => library.id === Number(libraryMatch[1]))
		} });
		if (path === '/shelves') return route.fulfill({ json: url.searchParams.has('cursor')
			? { items: [shelf(12, 'Second-page shelf')], next_cursor: null }
			: { items: [shelf(11, 'Weekend reads')], next_cursor: 'next-shelf-page' }
		});
		if (path.endsWith('/books') || ['/books', '/authors', '/series', '/tags', '/me/book-states'].includes(path)) {
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		if (path === '/shelves/11') return route.fulfill({ json: { shelf: shelf(11, 'Weekend reads') } });
		if (path === '/shelves/12') return route.fulfill({ json: { shelf: shelf(12, 'Second-page shelf') } });
		if (path.startsWith('/shelves/system/')) {
			const key = path.split('/').at(-1) ?? '';
			return route.fulfill({ json: { shelf: {
				key, name: key, mode: key === 'favorites' ? 'manual' : 'automatic',
				shelf_id: key === 'favorites' ? 13 : null, visible_book_count: scope === 2 ? 1 : 3
			} } });
		}
		if (path === '/books/count') return route.fulfill({ json: { count: 9 } });
		if (path === '/me/notes' || path === '/admin/bookheap/items') {
			return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
		}
		unexpected.push(`${route.request().method()} ${path}`);
		return route.fulfill({ status: 404, json: { title: 'Unexpected request', status: 404 } });
	});
	return { requests, unexpected };
}

test('library cards select a library and keep every shelf and its books scoped', async ({ page }) => {
	const { requests, unexpected } = await mockLibraries(page);
	await page.goto('/libraries');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await expect(sidebar.getByRole('link', { name: 'Library', exact: true })).toHaveAttribute('href', '/libraries');
	await expect(sidebar.getByText('Weekend reads')).toHaveCount(0);
	const fiction = page.getByRole('main').getByRole('listitem').filter({ hasText: 'Fiction' });
	await expect(fiction).toContainText('7 books');
	await fiction.getByRole('link', { name: /Fiction/ }).first().click();
	await expect(page).toHaveURL('/library/1');
	await expect(sidebar.getByRole('link', { name: 'Fiction', exact: true })).toBeVisible();
	const secondPage = sidebar.getByRole('link', { name: /Second-page shelf/ });
	await expect(secondPage).toHaveAttribute('href', /library_id=1/);
	await secondPage.click();
	await expect(page).toHaveURL(/\/shelves\/12\?library_id=1/);
	await expect(page.getByRole('main').getByRole('heading', { name: 'Second-page shelf', exact: true })).toBeAttached();
	await expect.poll(() => requests.some((url) =>
		url.pathname.endsWith('/shelves/12/books') && url.searchParams.get('library_id') === '1'
	)).toBe(true);
	await expect(sidebar.getByRole('link', { name: 'Fiction', exact: true })).toBeVisible();
	await sidebar.getByRole('link', { name: /Unshelved/ }).click();
	await expect.poll(() => requests.some((url) =>
		url.pathname.endsWith('/shelves/system/unshelved/books') && url.searchParams.get('library_id') === '1'
	)).toBe(true);
	await sidebar.getByRole('link', { name: 'Fiction', exact: true }).click();
	await expect(page).toHaveURL('/libraries');
	await expect(sidebar.getByRole('link', { name: 'Library', exact: true })).toBeVisible();
	await expect(sidebar.getByText('Weekend reads')).toHaveCount(0);
	expect(unexpected).toEqual([]);
});

test('library actions point to new, current settings, and all-library management', async ({ page }) => {
	const { unexpected } = await mockLibraries(page);
	await page.goto('/library/2');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	const actions = sidebar.getByRole('button', { name: 'Library actions' });
	await actions.click();
	await expect(sidebar.getByRole('menuitem', { name: 'New Library', exact: true }))
		.toHaveAttribute('href', '/admin/libraries?create=1');
	await expect(sidebar.getByRole('menuitem', { name: 'Edit Library', exact: true }))
		.toHaveAttribute('href', '/admin/libraries?edit=2');
	await expect(sidebar.getByRole('menuitem', { name: 'Manage Libraries', exact: true }))
		.toHaveAttribute('href', '/admin/libraries');
	await page.keyboard.press('Escape');
	await expect(actions).toBeFocused();
	await page.goto('/libraries');
	await actions.click();
	await expect(sidebar.getByRole('menuitem', { name: 'Edit Library', exact: true })).toHaveCount(0);
	expect(unexpected).toEqual([]);
});

test('direct scoped shelf links restore the library on mobile and readers cannot mutate libraries', async ({ page }) => {
	const { requests, unexpected } = await mockLibraries(page, 'user', 'zh');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/shelves/11?library_id=2');
	await page.getByRole('button', { name: /打开导航菜单|打开导航|菜单/ }).first().click();
	const sidebar = page.getByRole('navigation', { name: '主导航' });
	await expect(sidebar.getByRole('link', { name: 'History', exact: true })).toBeVisible();
	await expect(sidebar.getByRole('link', { name: /Weekend reads/ })).toContainText('1');
	await sidebar.getByRole('button', { name: '书库操作' }).click();
	await expect(sidebar.getByRole('menuitem', { name: '新建书库', exact: true })).toHaveCount(0);
	await expect(sidebar.getByRole('menuitem', { name: '编辑书库', exact: true })).toHaveCount(0);
	await expect(sidebar.getByRole('menuitem', { name: '管理书库', exact: true })).toHaveAttribute('href', '/libraries');
	expect(requests.some((url) =>
		url.pathname.endsWith('/shelves/11/books') && url.searchParams.get('library_id') === '2'
	)).toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(unexpected).toEqual([]);
});

test('editing the current library refreshes its sidebar name and New Library focuses the form', async ({ page }) => {
	const { unexpected } = await mockLibraries(page);
	let name = 'Fiction';
	await page.route('**/api/v1/libraries/1', (route) =>
		route.fulfill({ json: { library: { ...libraries[0], name } } }));
	await page.route('**/api/v1/admin/libraries?*', (route) =>
		route.fulfill({ json: { items: [{ ...libraries[0], name }], next_cursor: null } }));
	await page.route('**/api/v1/admin/libraries/1', async (route) => {
		expect(route.request().method()).toBe('PATCH');
		name = route.request().postDataJSON().name;
		return route.fulfill({ json: { library: { ...libraries[0], name } } });
	});
	await page.goto('/library/1');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await expect(sidebar.getByRole('link', { name: 'Fiction', exact: true })).toBeVisible();
	await sidebar.getByRole('button', { name: 'Library actions' }).click();
	await sidebar.getByRole('menuitem', { name: 'Edit Library', exact: true }).click();
	const editor = page.getByRole('region', { name: 'Edit “Fiction”', exact: true });
	await editor.getByLabel('Name', { exact: true }).fill('Renamed Fiction');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(sidebar.getByRole('link', { name: 'Renamed Fiction', exact: true })).toBeVisible();
	await sidebar.getByRole('button', { name: 'Library actions' }).click();
	await sidebar.getByRole('menuitem', { name: 'New Library', exact: true }).click();
	await expect(page.locator('#create-library-name')).toBeFocused();
	expect(unexpected).toEqual([]);
});

test('invalid library scope shows an error rather than unscoped shelf books', async ({ page }) => {
	const { requests } = await mockLibraries(page);
	for (const path of ['/shelves/11', '/shelves/system/unshelved']) {
		await page.goto(`${path}?library_id=invalid`);
		await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
		expect(requests.some((url) => url.pathname.endsWith(`${path}/books`))).toBe(false);
	}
});
