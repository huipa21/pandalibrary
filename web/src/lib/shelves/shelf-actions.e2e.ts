import { expect, test, type Page, type Route } from '@playwright/test';
import type { Shelf, ShelfInput } from './types.js';

test.use({ serviceWorkers: 'block' });

const timestamp = '2026-11-04T00:00:00Z';

type ShelfDraft = ShelfInput;

const shelf = (id: number, name: string, systemKey: string | null = null): Shelf => ({
	id, kind: 'private', owner_id: 1, name, description: null, created_by: 1, visible_book_count: 0,
	created_at: timestamp, updated_at: timestamp, mode: 'manual', system_key: systemKey
});

function problem(route: Route, status: number) {
	return route.fulfill({
		status, contentType: 'application/problem+json',
		body: JSON.stringify({ status, title: 'Request failed' })
	});
}

async function mockApi(page: Page, options: {
	role?: string;
	locale?: string;
	failSystem?: boolean;
	beforeCreate?: () => Promise<void>;
} = {}) {
	const shelves: Shelf[] = [shelf(7, 'Weekend reads')];
	const requests: ShelfDraft[] = [];

	await page.route((url) => url.pathname.startsWith('/api/v1/'), async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: {
			id: 1, username: 'reader', display_name: 'Reader',
			role: options.role ?? 'user', locale: options.locale ?? 'en'
		} } });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: []
		} });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/me/book-states') return route.fulfill({ json: { items: [] } });
		if (path === '/version') return route.fulfill({ json: {
			version: 'test', commit: 'test', commit_date: timestamp, dirty: false, release: null
		} });
		if (path === '/shelves' && request.method() === 'GET') {
			if (options.failSystem) return problem(route, 503);
			return route.fulfill({ json: { items: shelves, next_cursor: null } });
		}
		if (path === '/shelves' && request.method() === 'POST') {
			const body = request.postDataJSON() as ShelfDraft;
			requests.push(body);
			await options.beforeCreate?.();
			if (body.name === 'Duplicate') return problem(route, 409);
			const created = { ...shelf(20 + shelves.length, body.name), ...body, owner_id: body.kind === 'shared' ? null : 1 };
			shelves.push(created);
			return route.fulfill({ status: 201, json: { shelf: created } });
		}
		if (path.startsWith('/shelves/system/')) {
			if (options.failSystem) return problem(route, 503);
			const key = path.endsWith('favorites') ? 'favorites' : 'unshelved';
			return route.fulfill({ json: { shelf: shelf(key === 'favorites' ? 8 : 9, key, key) } });
		}
		if (['/books', '/libraries', '/authors', '/series', '/tags'].includes(path) ||
			path.startsWith('/dashboard/sections/')) {
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		return problem(route, 404);
	});

	return { requests, shelves };
}

test('shelf actions are a keyboard-accessible three-dot menu in both themes', async ({ page }, info) => {
	await mockApi(page);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/shelves');

	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	const section = sidebar.getByRole('region', { name: 'Collections' });
	const trigger = section.getByRole('button', { name: 'Collection actions' });
	await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	expect(await trigger.locator('svg circle').evaluateAll((circles) =>
		circles.map((circle) => [circle.getAttribute('cx'), circle.getAttribute('cy')])
	)).toEqual([['10', '4'], ['10', '10'], ['10', '16']]);
	await expect(section.getByRole('menuitem')).toHaveCount(0);
	await expect(section.getByRole('link', { name: 'Manage collections' })).toHaveCount(0);
	await expect(page.getByRole('main').getByRole('button', { name: 'Create collection' })).toHaveCount(0);

	await trigger.focus();
	await page.keyboard.press('ArrowDown');
	const menu = section.getByRole('menu', { name: 'Collection actions' });
	const newShelf = menu.getByRole('menuitem', { name: 'New collection' });
	const manage = menu.getByRole('menuitem', { name: 'Manage collections' });
	await expect(menu.getByRole('menuitem')).toHaveText(['New collection', 'Manage collections']);
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await expect(newShelf).toBeFocused();
	await expect(manage).toHaveAttribute('aria-current', 'page');
	const menuBox = await menu.boundingBox();
	const scrollBox = await page.locator('.shell-scroll').boundingBox();
	if (!menuBox || !scrollBox) throw new Error('Shelf menu or sidebar is not visible');
	expect(menuBox.x).toBeGreaterThanOrEqual(scrollBox.x);
	expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(scrollBox.x + scrollBox.width);
	await page.locator('#app-sidebar').screenshot({ path: info.outputPath('shelves-menu-light.png') });

	await page.keyboard.press('End');
	await expect(manage).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(newShelf).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(manage).toBeFocused();
	await page.keyboard.press('Home');
	await expect(newShelf).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(trigger).toBeFocused();

	await trigger.click();
	await page.getByRole('heading', { name: 'Available collections' }).click();
	await expect(menu).toHaveCount(0);
	await trigger.click();
	const lightBackground = await menu.evaluate((element) => getComputedStyle(element).backgroundColor);
	await page.getByRole('button', { name: 'Switch to dark mode' }).click();
	await expect(menu).toHaveCount(0);
	await trigger.click();
	const darkBackground = await menu.evaluate((element) => getComputedStyle(element).backgroundColor);
	expect(lightBackground).not.toBe(darkBackground);
	await expect(newShelf).toBeVisible();
	await expect(manage).toBeVisible();
	await page.locator('#app-sidebar').screenshot({ path: info.outputPath('shelves-menu-dark.png') });
});

test('one creation dialog refreshes the management page and sidebar', async ({ page }) => {
	const server = await mockApi(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/books');

	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	const trigger = sidebar.getByRole('button', { name: 'Collection actions' });
	await trigger.click();
	await sidebar.getByRole('menuitem', { name: 'Manage collections' }).click();
	await expect(page).toHaveURL('/shelves');
	const main = page.getByRole('main');
	await expect(main.getByRole('heading', { name: 'Available collections' })).toBeVisible();
	await expect(main.getByRole('button', { name: 'Create collection' })).toHaveCount(0);
	await expect(main.getByLabel('Collection name')).toHaveCount(0);

	await trigger.click();
	await sidebar.getByRole('menuitem', { name: 'New collection' }).click();
	const creator = page.getByRole('dialog', { name: 'Create collection' });
	const name = creator.getByLabel('Collection name');
	await expect(name).toBeFocused();
	await expect(creator.getByLabel('Shared', { exact: true })).toHaveCount(0);
	await creator.getByRole('button', { name: 'Create collection' }).click();
	await expect(name).toHaveAttribute('aria-invalid', 'true');
	await expect(creator.getByRole('alert')).toContainText('Enter a collection name.');
	expect(server.requests).toHaveLength(0);

	await name.fill('Duplicate');
	await creator.getByRole('button', { name: 'Create collection' }).click();
	await expect(creator.getByRole('alert')).toContainText('A collection with this name already exists.');
	await name.fill('  New reading  ');
	await creator.getByLabel('Description (optional)').fill('  Notes  ');
	await creator.getByRole('button', { name: 'Create collection' }).click();
	await expect(creator).toHaveCount(0);
	await expect(trigger).toBeFocused();
	expect(server.requests.at(-1)).toEqual({
		kind: 'private', name: 'New reading', description: '  Notes  ', rule_groups: []
	});
	await expect(main.getByRole('status').filter({ hasText: 'Collection created.' })).toBeVisible();
	await expect(main.getByRole('region', { name: 'Available collections' }).getByRole('link', { name: 'New reading' })).toBeVisible();
	await expect(sidebar.getByRole('link', { name: 'New reading 0' })).toBeVisible();
});

test('mobile drawer keeps focus and creates a shared collection with automatic rules', async ({ page }, info) => {
	let releaseCreate = () => {};
	const pendingCreate = new Promise<void>((resolve) => { releaseCreate = resolve; });
	const server = await mockApi(page, { role: 'admin', beforeCreate: () => pendingCreate });
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto('/shelves');
	const toggle = page.getByRole('button', { name: 'Open navigation menu' });
	await toggle.click();
	const drawer = page.getByRole('dialog', { name: 'Sidebar' });
	const trigger = drawer.getByRole('button', { name: 'Collection actions' });
	await trigger.click();
	const menu = drawer.getByRole('menu', { name: 'Collection actions' });
	const menuBox = await menu.boundingBox();
	const drawerBox = await drawer.boundingBox();
	if (!menuBox || !drawerBox) throw new Error('Shelf menu or drawer is not visible');
	expect(menuBox.x).toBeGreaterThanOrEqual(drawerBox.x);
	expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(drawerBox.x + drawerBox.width);
	await drawer.screenshot({ path: info.outputPath('shelves-menu-mobile.png') });
	await menu.getByRole('menuitem', { name: 'New collection' }).click();

	let creator = page.getByRole('dialog', { name: 'Create collection' });
	await expect(creator.getByLabel('Collection name')).toBeFocused();
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press('Tab');
		expect(await creator.evaluate((node) => node.contains(document.activeElement))).toBe(true);
	}
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press('Shift+Tab');
		expect(await creator.evaluate((node) => node.contains(document.activeElement))).toBe(true);
	}
	await page.keyboard.press('Escape');
	await expect(creator).toHaveCount(0);
	await expect(drawer).toBeVisible();
	await expect(trigger).toBeFocused();

	await trigger.click();
	await drawer.getByRole('menuitem', { name: 'New collection' }).click();
	creator = page.getByRole('dialog', { name: 'Create collection' });
	await creator.getByLabel('Collection name').fill('Shared recommendations');
	await creator.getByLabel('Shared', { exact: true }).check();
	await creator.getByRole('button', { name: 'Add automatic rule' }).click();
	await creator.getByLabel('Rule name', { exact: true }).fill('Moon titles');
	await creator.getByRole('combobox', { name: 'Field', exact: true }).selectOption('title');
	await creator.getByLabel('Value', { exact: true }).fill('Moon');
	await creator.getByRole('button', { name: 'Create collection' }).click();
	try {
		await expect(creator.getByRole('button', { name: 'Creating collection…' })).toBeDisabled();
		await page.keyboard.press('Escape');
		await expect(creator).toBeVisible();
		await expect(drawer).toBeVisible();
	} finally {
		releaseCreate();
	}
	await expect(creator).toHaveCount(0);
	expect(server.requests).toEqual([{
		kind: 'shared', name: 'Shared recommendations', description: null,
		rule_groups: [{ id: expect.any(String), name: 'Moon titles', rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'Moon' }] } }]
	}]);
	await expect(drawer).toBeVisible();
	await expect(trigger).toBeFocused();
	await expect(drawer.getByRole('link', { name: 'Shared recommendations 0' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden();
	await expect(toggle).toBeFocused();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('shelf actions stay available when sidebar shelf loading fails', async ({ page }) => {
	await mockApi(page, { failSystem: true });
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/books');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await expect(sidebar.getByRole('alert')).toContainText('The collection request failed.');
	await sidebar.getByRole('button', { name: 'Collection actions' }).click();
	await expect(sidebar.getByRole('menuitem', { name: 'New collection' })).toBeVisible();
	await sidebar.getByRole('menuitem', { name: 'Manage collections' }).click();
	await expect(page).toHaveURL('/shelves');
	await expect(page.getByRole('main').getByRole('heading', { name: 'Available collections' })).toBeVisible();
});

test('the full shelf menu remains visible in a short mobile drawer', async ({ page }) => {
	await mockApi(page, { role: 'admin' });
	await page.setViewportSize({ width: 320, height: 480 });
	await page.goto('/books');
	await page.getByRole('button', { name: 'Open navigation menu' }).click();
	const drawer = page.getByRole('dialog', { name: 'Sidebar' });
	await drawer.getByRole('button', { name: 'Collection actions' }).click();
	const menu = drawer.getByRole('menu', { name: 'Collection actions' });
	const menuBox = await menu.boundingBox();
	const scrollBox = await drawer.getByRole('navigation', { name: 'Main navigation' }).boundingBox();
	if (!menuBox || !scrollBox) throw new Error('Shelf menu or drawer navigation is not visible');
	expect(menuBox.y).toBeGreaterThanOrEqual(scrollBox.y);
	expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(scrollBox.y + scrollBox.height);
	await menu.getByRole('menuitem', { name: 'Manage collections' }).click();
	await expect(page).toHaveURL('/shelves');
	await expect(drawer).toBeHidden();
});

test('the Chinese shelf menu identifies the active management page', async ({ page }) => {
	await mockApi(page, { role: 'admin', locale: 'zh' });
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/zh/shelves');
	const sidebar = page.getByRole('navigation', { name: '主导航' });
	await sidebar.getByRole('button', { name: '合集操作' }).click();
	await expect(sidebar.getByRole('menuitem', { name: '新建合集' })).toBeVisible();
	await expect(sidebar.getByRole('menuitem', { name: '管理合集' })).toHaveAttribute('aria-current', 'page');
});
