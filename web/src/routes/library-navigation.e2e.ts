import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const timestamp = '2026-11-12T00:00:00Z';
const libraries = [
	{ id: 1, name: 'Fiction', slug: 'fiction', visible_book_count: 7, created_at: timestamp, updated_at: timestamp },
	{ id: 2, name: 'History', slug: 'history', visible_book_count: 2, created_at: timestamp, updated_at: timestamp }
];

async function setRange(slider: Locator, value: number) {
	await slider.evaluate((element, next) => {
		(element as HTMLInputElement).value = String(next);
		element.dispatchEvent(new Event('input', { bubbles: true }));
	}, value);
}

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
		if (path === '/stats') return route.fulfill({ json: {
			from: url.searchParams.get('from'), to: url.searchParams.get('to'),
			timezone: url.searchParams.get('timezone'), daily: [], finished_per_month: [],
			streaks: { current_days: 0, longest_days: 0 }, time_per_book: []
		} });
		if (path === '/me/notes' || path === '/admin/bookheap/items') {
			return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
		}
		unexpected.push(`${route.request().method()} ${path}`);
		return route.fulfill({ status: 404, json: { title: 'Unexpected request', status: 404 } });
	});
	return { requests, unexpected };
}

test('Libraries expands all physical libraries while Collections remains global', async ({ page }) => {
	const { requests, unexpected } = await mockLibraries(page);
	await page.goto('/libraries');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	const toggle = sidebar.getByRole('button', { name: 'Libraries', exact: true });
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(sidebar.getByRole('link', { name: /^Fiction/ })).toBeVisible();
	await expect(sidebar.locator('a[href="/library/2"]')).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(sidebar.getByRole('link', { name: /^Fiction/ })).toBeHidden();
	await expect(sidebar.getByRole('link', { name: /^Weekend reads/ })).toBeVisible();
	await expect(sidebar.getByRole('button', { name: 'Library actions' })).toBeVisible();
	await toggle.click();
	await expect(sidebar.locator('a[href="/books"]')).toHaveCount(0);
	const fiction = page.getByRole('main').getByRole('listitem').filter({ hasText: 'Fiction' });
	await expect(fiction).toContainText('7 books');
	await fiction.getByRole('link', { name: /Fiction/ }).first().click();
	await expect(page).toHaveURL('/library/1');
	await expect(sidebar.getByRole('link', { name: /^Fiction/ })).toHaveAttribute('aria-current', 'page');
	const secondPage = sidebar.getByRole('link', { name: /Second-page shelf/ });
	await expect(secondPage).toHaveAttribute('href', '/shelves/12');
	await secondPage.click();
	await expect(page).toHaveURL('/shelves/12');
	await expect(page.getByRole('main').getByRole('heading', { name: 'Second-page shelf', exact: true })).toBeAttached();
	await expect.poll(() => requests.some((url) =>
		url.pathname.endsWith('/shelves/12/books') && !url.searchParams.has('library_id')
	)).toBe(true);
	await sidebar.getByRole('link', { name: /^Fiction/ }).click();
	await expect(page).toHaveURL('/library/1');
	await expect(sidebar.getByRole('link', { name: /Weekend reads/ })).toBeVisible();
	expect(requests.filter((url) => url.pathname.endsWith('/shelves')).every((url) => !url.searchParams.has('library_id'))).toBe(true);
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
	await expect(sidebar.getByRole('link', { name: /^History/ })).toBeVisible();
	await expect(sidebar.getByRole('link', { name: /Weekend reads/ })).toContainText('3');
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
	await page.route('**/api/v1/libraries?*', (route) =>
		route.fulfill({ json: { items: [{ ...libraries[0], name }, libraries[1]], next_cursor: null } }));
	await page.route('**/api/v1/admin/libraries?*', (route) =>
		route.fulfill({ json: { items: [{ ...libraries[0], name }], next_cursor: null } }));
	await page.route('**/api/v1/admin/libraries/1', async (route) => {
		expect(route.request().method()).toBe('PATCH');
		name = route.request().postDataJSON().name;
		return route.fulfill({ json: { library: { ...libraries[0], name } } });
	});
	await page.goto('/library/1');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await expect(sidebar.getByRole('link', { name: /^Fiction/ })).toBeVisible();
	await sidebar.getByRole('button', { name: 'Library actions' }).click();
	await sidebar.getByRole('menuitem', { name: 'Edit Library', exact: true }).click();
	const editor = page.getByRole('region', { name: 'Edit “Fiction”', exact: true });
	await editor.getByLabel('Name', { exact: true }).fill('Renamed Fiction');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(sidebar.getByRole('link', { name: /^Renamed Fiction/ })).toBeVisible();
	await sidebar.getByRole('button', { name: 'Library actions' }).click();
	await sidebar.getByRole('menuitem', { name: 'New Library', exact: true }).click();
	await expect(page.locator('#create-library-name')).toBeFocused();
	expect(unexpected).toEqual([]);
});

test('statistics menu links open distinct Books, Reading and History views', async ({ page }) => {
	const { unexpected } = await mockLibraries(page);
	await page.goto('/stats/books');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	for (const [label, path, heading] of [
		['Books', '/stats/books', 'Books'],
		['Reading', '/stats/reading', 'Reading stats'],
		['History', '/stats/history', 'History']
	]) {
		await sidebar.getByRole('link', { name: label, exact: true }).click();
		await expect(page).toHaveURL(path);
		await expect(sidebar.getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
		await expect(page.getByRole('main').getByRole('heading', { name: heading, level: 1, exact: true })).toBeAttached();
	}
	expect(unexpected).toEqual([]);
});

test('shared display controls change cover width and spacing and persist independently', async ({ page }) => {
	const { unexpected } = await mockLibraries(page);
	const book = {
		id: 21, library_id: 1, title: 'Display test', sort_title: 'Display test', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [], field_sources: [], created_at: timestamp, updated_at: timestamp
	};
	await page.route('**/api/v1/books?*', (route) => route.fulfill({ json: { items: [book], next_cursor: null } }));
	await page.route('**/api/v1/shelves/11/books?*', (route) => route.fulfill({ json: { items: [book], next_cursor: null } }));
	await page.goto('/library/1');
	const main = page.getByRole('main');
	const settings = main.getByRole('button', { name: 'Display settings', exact: true });
	const grid = main.locator('.book-grid-configurable');
	await expect(grid.locator(':scope > li')).toHaveCount(1);
	await settings.click();
	const panel = main.getByRole('dialog', { name: 'Display settings', exact: true });
	await setRange(panel.getByRole('slider', { name: /Cover size/ }), 200);
	await setRange(panel.getByRole('slider', { name: /Spacing/ }), 30);
	await expect(grid).toHaveCSS('column-gap', '30px');
	await expect(grid.locator(':scope > li')).toHaveCSS('width', '200px');
	await page.keyboard.press('Escape');
	await expect(settings).toBeFocused();
	await page.reload();
	await expect(grid.locator(':scope > li')).toHaveCSS('width', '200px');
	await expect(grid).toHaveCSS('column-gap', '30px');
	await page.goto('/shelves/11');
	await expect(grid.locator(':scope > li')).toHaveCSS('width', '160px');
	await settings.click();
	await setRange(panel.getByRole('slider', { name: /Cover size/ }), 220);
	await setRange(panel.getByRole('slider', { name: /Spacing/ }), 8);
	await expect(grid.locator(':scope > li')).toHaveCSS('width', '220px');
	await expect(grid).toHaveCSS('column-gap', '8px');
	await page.goto('/library/1');
	await expect(grid.locator(':scope > li')).toHaveCSS('width', '200px');
	await expect(grid).toHaveCSS('column-gap', '30px');
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
