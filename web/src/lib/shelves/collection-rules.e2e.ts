import { expect, test, type Page } from '@playwright/test';
import type { Shelf, ShelfInput, ShelfPatch } from './types.js';

test.use({ serviceWorkers: 'block' });
const timestamp = '2026-11-04T00:00:00Z';
const anotherBook = {
	id: 42, library_id: 2, title: 'From another library', sort_title: 'From another library',
	subtitle: null, description: null, language: null, publisher: null, published_date: null,
	page_count: null, cover_url: null, cover_source: null, authors: [], series: null, tags: [],
	identifiers: [], files: [], field_sources: [], created_at: timestamp, updated_at: timestamp
};

async function mockCollection(page: Page, locale = 'en', kind: Shelf['kind'] = 'private') {
	let collection: Shelf = {
		id: 7, name: 'Across libraries', icon: 'bookmark', kind, owner_id: kind === 'private' ? 1 : null, description: null, created_by: 1,
		created_at: timestamp, updated_at: timestamp, visible_book_count: 0, mode: 'automatic',
		rule_groups: [{ id: 'legacy', name: 'Novels', rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'Novel' }] } }]
	};
	const patches: ShelfPatch[] = [];
	const creates: ShelfInput[] = [];
	const added: number[] = [];
	const searchURLs: string[] = [];
	const detailURLs: string[] = [];
	const bookURLs: string[] = [];
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
		if (path === '/books/42') return route.fulfill({ json: { book: anotherBook } });
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
		if (path === '/shelves/7/books') {
			bookURLs.push(request.url());
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		if (['/books', '/libraries', '/authors', '/series', '/tags', '/me/book-states'].includes(path)) {
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		return route.fulfill({ status: 404, json: { status: 404, title: 'Not found' } });
	});
	return { patches, creates, added, searchURLs, detailURLs, bookURLs };
}

test('All Collections covers open settings while sidebar links still browse books', async ({ page }) => {
	const server = await mockCollection(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/shelves');
	const main = page.getByRole('main');
	const cover = main.getByRole('link', { name: 'Across libraries', exact: true });
	await expect(cover).toHaveAttribute('href', '/shelves/7?manage=1');
	const box = await cover.boundingBox();
	if (!box) throw new Error('Collection cover is missing');
	expect(box.height / box.width).toBeCloseTo(1.5, 1);
	await cover.click();
	await expect(page).toHaveURL('/shelves/7?manage=1');
	await expect(main.getByLabel('Name', { exact: true })).toHaveValue('Across libraries');
	await expect(main.getByRole('radio', { name: 'Bookmark', exact: true })).toBeChecked();
	await expect(main.getByLabel('Description (optional)')).toBeVisible();
	await expect(main.getByLabel('Visibility', { exact: true })).toHaveCount(0);
	const settings = main.getByRole('region', { name: 'Collection settings', exact: true });
	await expect(main.locator('.app-panel > *')).toHaveCount(1);
	await expect(settings).toHaveClass('card space-y-4 p-6');
	await expect(settings.getByRole('heading', { level: 1 })).toHaveText('Collection settings');
	await expect(settings.locator('header')).toHaveClass('flex items-center justify-between gap-4');
	const back = settings.getByRole('link', { name: 'Back to collections', exact: true });
	await expect(main.getByRole('link')).toHaveCount(1);
	await expect(back).toHaveAttribute('href', '/shelves');
	await expect(back).toHaveAttribute('title', 'Back to collections');
	await expect(back).toHaveClass('shell-icon-button');
	await expect(back).toHaveText('');
	await expect(back.locator('svg')).toBeVisible();
	await expect(main.getByText('Manage book membership', { exact: true })).toHaveCount(0);
	await expect(main.getByRole('heading', { name: 'Add books', exact: true })).toHaveCount(0);
	await expect(main.getByRole('heading', { name: 'Automatic rules', exact: true })).toBeVisible();
	await expect(main.getByRole('button', { name: 'Display settings', exact: true })).toHaveCount(0);
	await expect(main.getByRole('combobox', { name: 'Sort', exact: true })).toHaveCount(0);
	await expect(main.getByLabel('Find a book to add')).toHaveCount(0);
	expect(server.bookURLs).toHaveLength(0);

	await back.click();
	await expect(page).toHaveURL('/shelves');
	await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Across libraries 0' }).click();
	await expect(page).toHaveURL('/shelves/7');
	await expect(main.getByLabel('Name', { exact: true })).toHaveCount(0);
	await expect(main.getByRole('button', { name: 'Display settings', exact: true })).toBeVisible();
	await expect.poll(() => server.bookURLs.length).toBeGreaterThan(0);
});

test('shared collection settings are read-only for a non-administrator', async ({ page }) => {
	const server = await mockCollection(page, 'en', 'shared');
	await page.goto('/shelves');
	const main = page.getByRole('main');
	await main.getByRole('link', { name: 'Across libraries', exact: true }).click();
	await expect(main.getByLabel('Name', { exact: true })).toBeDisabled();
	await expect(main.getByRole('radio', { name: 'Bookmark', exact: true })).toBeDisabled();
	await expect(main.getByLabel('Visibility', { exact: true })).toHaveCount(0);
	await expect(main.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
	await expect(main.getByRole('button', { name: 'Delete collection', exact: true })).toHaveCount(0);
	await expect(main.getByText('Manage book membership', { exact: true })).toHaveCount(0);
	expect(server.patches).toHaveLength(0);
	expect(server.bookURLs).toHaveLength(0);
});

test('collection icon edits preserve existing selections, save changes, and clear to automatic', async ({ page }) => {
	const server = await mockCollection(page);
	await page.goto('/shelves/7?manage=1');
	const main = page.getByRole('main');
	await expect(main.getByRole('radio', { name: 'Bookmark', exact: true })).toBeChecked();
	await main.getByLabel('Name', { exact: true }).fill('Renamed collection');
	await main.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect.poll(() => server.patches.length).toBe(1);
	expect(server.patches[0]).not.toHaveProperty('icon');

	await expect(main.getByRole('radio', { name: 'Bookmark', exact: true })).toBeChecked();
	await main.getByRole('radio', { name: 'Star', exact: true }).check();
	await main.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect.poll(() => server.patches.length).toBe(2);
	expect(server.patches[1].icon).toBe('star');

	await expect(main.getByRole('radio', { name: 'Star', exact: true })).toBeChecked();
	await main.getByRole('radio', { name: 'Automatic', exact: true }).check();
	await main.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect.poll(() => server.patches.length).toBe(3);
	expect(server.patches[2].icon).toBe('');
});

test('edits several independent all/any rules while allowing manual additions to legacy automatic collections', async ({ page }) => {
	const server = await mockCollection(page);
	await page.goto('/shelves/7');
	const main = page.getByRole('main');
	await expect(main.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await sidebar.getByRole('button', { name: 'Collection actions' }).click();
	await sidebar.getByRole('menuitem', { name: 'All Collections', exact: true }).click();
	await main.getByRole('link', { name: 'Across libraries', exact: true }).click();
	await main.getByRole('button', { name: 'Add group' }).click();
	await page.getByLabel('Rule name', { exact: true }).nth(1).fill('Authors');
	await page.locator('#edit-shelf-rules-1-match').selectOption('any');
	await page.locator('#edit-shelf-rules-1-0-field').selectOption('author_id');
	await page.getByLabel('Numeric ID', { exact: true }).fill('12');
	await page.getByLabel('NOT (exclude matching books)', { exact: true }).nth(1).check();
	await page.getByRole('button', { name: 'Add rule', exact: true }).nth(1).click();
	await page.locator('#edit-shelf-rules-1-1-value').fill('Moon');
	await page.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect.poll(() => server.patches.length).toBe(1);
	expect(server.patches[0].rule_groups).toEqual([
		{ id: 'legacy', name: 'Novels', rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'Novel' }] } },
		expect.objectContaining({ name: 'Authors', rules: { match: 'any', conditions: [
			{ field: 'author_id', op: 'eq', value: 12, not: true },
			{ field: 'title', op: 'contains', value: 'Moon' }
		] } })
	]);
	await page.goto('/books/42');
	await page.getByRole('main').getByRole('button', { name: 'Add to collection', exact: true }).click();
	await page.getByRole('dialog', { name: 'Add to collection', exact: true }).getByRole('button', { name: /Across libraries/ }).click();
	await expect.poll(() => server.added).toEqual([42]);
	expect(server.searchURLs).toHaveLength(0);
	expect(server.detailURLs.every((url) => !new URL(url).searchParams.has('library_id'))).toBe(true);
});

for (const remove of [false, true]) {
	test(`deleting a rule explicitly ${remove ? 'removes' : 'retains'} mapped books`, async ({ page }) => {
		const server = await mockCollection(page);
		await page.goto('/shelves/7?manage=1');
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
	await sidebar.getByRole('menuitem', { name: '所有合集', exact: true }).click();
	await page.getByRole('main').getByRole('link', { name: 'Across libraries', exact: true }).click();
	await expect(page.getByRole('heading', { name: '合集设置' })).toBeVisible();
	await expect(page.getByRole('heading', { name: '自动规则' })).toBeVisible();
	await page.getByRole('button', { name: '显示更多图标' }).click();
	await expect(page.getByRole('radio', { name: '望远镜', exact: true })).toBeVisible();
	await page.getByRole('button', { name: '删除规则', exact: true }).click();
	await expect(page.getByLabel('将匹配的图书保留为手动成员')).toBeVisible();
	await expect(page.getByRole('main')).not.toContainText('书架');
});

test('explicit legacy library filters scope collection details and browsing without membership search', async ({ page }) => {
	const server = await mockCollection(page);
	await page.goto('/shelves/7?library_id=3&manage=1');
	await expect(page.getByRole('heading', { name: 'Collection settings', exact: true })).toBeVisible();
	expect(server.bookURLs).toHaveLength(0);
	await page.goto('/shelves/7?library_id=3');
	await expect.poll(() => server.bookURLs.length).toBeGreaterThan(0);
	expect(server.detailURLs.every((url) => new URL(url).searchParams.get('library_id') === '3')).toBe(true);
	expect(server.bookURLs.every((url) => new URL(url).searchParams.get('library_id') === '3')).toBe(true);
	expect(server.searchURLs).toHaveLength(0);
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
	await dialog.getByRole('button', { name: 'Add group' }).click();
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
