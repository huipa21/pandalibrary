import { expect, test, type Page } from '@playwright/test';
import type { Shelf, ShelfInput, ShelfPatch } from './types.js';

test.use({ serviceWorkers: 'block' });
const timestamp = '2026-11-04T00:00:00Z';

async function mockCollection(page: Page, locale = 'en') {
	let collection: Shelf = {
		id: 7, name: 'Across libraries', kind: 'private', owner_id: 1, description: null, created_by: 1,
		created_at: timestamp, updated_at: timestamp, visible_book_count: 0, mode: 'automatic',
		rule_groups: [{ id: 'legacy', name: 'Novels', rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'Novel' }] } }]
	};
	const patches: ShelfPatch[] = [];
	const creates: ShelfInput[] = [];
	const added: number[] = [];
	const searchURLs: string[] = [];
	const detailURLs: string[] = [];
	await page.route((url) => url.pathname.startsWith('/api/v1/'), async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale } } });
		if (path === '/sync/pull') return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: [] } });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/version') return route.fulfill({ json: { version: 'test', commit: 'test', commit_date: timestamp, dirty: false, release: null } });
		if (path === '/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Selected library', slug: 'selected', visible_book_count: 0, created_at: timestamp, updated_at: timestamp } } });
		if (path === '/shelves/7' && request.method() === 'PATCH') {
			const body = request.postDataJSON() as ShelfPatch;
			patches.push(body);
			collection = { ...collection, ...body };
			return route.fulfill({ json: { shelf: collection } });
		}
		if (path === '/shelves/7') {
			detailURLs.push(request.url());
			return route.fulfill({ json: { shelf: collection } });
		}
		if (path === '/shelves/7/books/42' && request.method() === 'PUT') {
			added.push(42);
			return route.fulfill({ json: { saved: true } });
		}
		if (path === '/search') {
			searchURLs.push(request.url());
			return route.fulfill({ json: { items: [{ id: 42, title: 'From another library', authors: [], series: null, cover_url: null, rank: 0 }], next_cursor: null } });
		}
		if (path === '/shelves' && request.method() === 'POST') {
			const body = request.postDataJSON() as ShelfInput;
			creates.push(body);
			return route.fulfill({ status: 201, json: { shelf: { ...collection, ...body, id: 8 } } });
		}
		if (path === '/shelves') return route.fulfill({ json: { items: [collection], next_cursor: null } });
		if (path.startsWith('/shelves/system/')) {
			if (path.endsWith('/books')) return route.fulfill({ json: { items: [], next_cursor: null } });
			return route.fulfill({ json: { shelf: { key: path.endsWith('favorites') ? 'favorites' : 'unshelved', name: 'System collection', mode: 'automatic', visible_book_count: 0, shelf_id: null } } });
		}
		if (path === '/shelves/7/books' || ['/books', '/libraries', '/authors', '/series', '/tags', '/me/book-states'].includes(path)) {
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		return route.fulfill({ status: 404, json: { status: 404, title: 'Not found' } });
	});
	return { patches, creates, added, searchURLs, detailURLs };
}

test('edits several independent all/any rules while allowing manual additions to legacy automatic collections', async ({ page }) => {
	const server = await mockCollection(page);
	await page.goto('/shelves/7');
	const main = page.getByRole('main');
	await expect(main.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await sidebar.getByRole('button', { name: 'Collection actions' }).click();
	await sidebar.getByRole('menuitem', { name: 'Manage collection', exact: true }).click();
	await main.getByRole('button', { name: 'Edit details' }).click();
	await main.getByRole('button', { name: 'Add automatic rule' }).click();
	await page.getByLabel('Rule name', { exact: true }).nth(1).fill('Authors');
	await page.locator('#edit-shelf-rules-1-match').selectOption('any');
	await page.locator('#edit-shelf-rules-1-0-field').selectOption('author_id');
	await page.getByLabel('Numeric ID', { exact: true }).fill('12');
	await page.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect.poll(() => server.patches.length).toBe(1);
	expect(server.patches[0].rule_groups).toEqual([
		{ id: 'legacy', name: 'Novels', rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'Novel' }] } },
		expect.objectContaining({ name: 'Authors', rules: { match: 'any', conditions: [{ field: 'author_id', op: 'eq', value: 12 }] } })
	]);
	await page.getByLabel('Find a book to add').fill('another library');
	await page.getByRole('button', { name: 'Find', exact: true }).click();
	await page.getByRole('button', { name: 'Add “From another library” to this collection', exact: true }).click();
	await expect.poll(() => server.added).toEqual([42]);
	expect(server.searchURLs).toHaveLength(1);
	expect(new URL(server.searchURLs[0]).searchParams.has('library_id')).toBe(false);
	expect(server.detailURLs.every((url) => !new URL(url).searchParams.has('library_id'))).toBe(true);
});

for (const remove of [false, true]) {
	test(`deleting a rule explicitly ${remove ? 'removes' : 'retains'} mapped books`, async ({ page }) => {
		const server = await mockCollection(page);
		await page.goto('/shelves/7?manage=1');
		await page.getByRole('button', { name: 'Edit details' }).click();
		await page.getByRole('button', { name: 'Delete rule', exact: true }).click();
		await expect(page.getByText('What happens to books mapped by deleted rules?')).toBeVisible();
		await page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(page.getByRole('alert')).toContainText('Choose whether to retain or remove');
		expect(server.patches).toHaveLength(0);
		await page.getByLabel(remove ? 'Remove the deleted rules’ mapped books from the collection' : 'Retain the mapped books as manual members').check();
		await page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect.poll(() => server.patches.length).toBe(1);
		expect(server.patches[0]).toMatchObject({ rule_groups: [], remove_rule_books: remove });
	});
}

test('Chinese collection rule controls and deletion choices are localized', async ({ page }) => {
	await mockCollection(page, 'zh');
	await page.goto('/shelves/7');
	const sidebar = page.getByRole('navigation', { name: '主导航' });
	await sidebar.getByRole('button', { name: '合集操作' }).click();
	await sidebar.getByRole('menuitem', { name: '管理当前合集', exact: true }).click();
	await page.getByRole('button', { name: '编辑详情' }).click();
	await expect(page.getByRole('heading', { name: '编辑合集' })).toBeVisible();
	await expect(page.getByRole('heading', { name: '自动规则' })).toBeVisible();
	await page.getByRole('button', { name: '删除规则', exact: true }).click();
	await expect(page.getByLabel('将匹配的图书保留为手动成员')).toBeVisible();
	await expect(page.getByRole('main')).not.toContainText('书架');
});

test('explicit legacy library filters affect detail only, not manual candidate search', async ({ page }) => {
	const server = await mockCollection(page);
	await page.goto('/shelves/7?library_id=3&manage=1');
	await page.getByLabel('Find a book to add').fill('another library');
	await page.getByRole('button', { name: 'Find', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Add “From another library” to this collection', exact: true })).toBeVisible();
	expect(server.detailURLs.every((url) => new URL(url).searchParams.get('library_id') === '3')).toBe(true);
	expect(server.searchURLs.every((url) => !new URL(url).searchParams.has('library_id'))).toBe(true);
});

test('invalid explicit legacy library filters show an error without requesting collection details', async ({ page }) => {
	const server = await mockCollection(page);
	await page.goto('/shelves/7?library_id=bad');
	await expect(page.getByRole('main').getByRole('alert')).toContainText('The collection details are not valid');
	expect(server.detailURLs).toHaveLength(0);
});

test('creates a collection with optional automatic rules instead of exclusive membership modes', async ({ page }) => {
	const server = await mockCollection(page);
	await page.goto('/library/1');
	await page.getByRole('button', { name: 'Collection actions', exact: true }).click();
	await page.getByRole('menuitem', { name: 'New collection', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Create collection' });
	await dialog.getByLabel('Collection name', { exact: true }).fill('Mixed collection');
	await dialog.getByRole('button', { name: 'Add automatic rule' }).click();
	await dialog.getByLabel('Rule name', { exact: true }).fill('Reading list');
	await page.locator('#create-shelf-rules-0-0-field').selectOption('reading_status');
	await page.locator('#create-shelf-rules-0-0-value').selectOption('reading');
	await dialog.getByRole('button', { name: 'Create collection', exact: true }).click();
	await expect.poll(() => server.creates.length).toBe(1);
	expect(server.creates[0]).toMatchObject({
		kind: 'private', name: 'Mixed collection',
		rule_groups: [expect.objectContaining({ name: 'Reading list', rules: { match: 'all', conditions: [{ field: 'reading_status', op: 'eq', value: 'reading' }] } })]
	});

	expect(server.creates[0].mode).toBeUndefined();
	await expect(dialog).not.toBeVisible();
});

test('built-in collections have separately persisted display settings', async ({ page }) => {
	await mockCollection(page);
	const main = page.getByRole('main');
	await page.goto('/shelves/system/favorites');
	await main.getByRole('button', { name: 'Display settings', exact: true }).click();
	await main.getByRole('slider').first().focus();
	await page.keyboard.press('End');
	await expect(main.locator('output').first()).toHaveText('280px');
	await page.reload();
	await main.getByRole('button', { name: 'Display settings', exact: true }).click();
	await expect(main.locator('output').first()).toHaveText('280px');
	await page.goto('/shelves/system/unshelved');
	await main.getByRole('button', { name: 'Display settings', exact: true }).click();
	await expect(main.locator('output').first()).toHaveText('208px');
});
