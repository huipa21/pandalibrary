import { expect, test, type Page, type Route } from '@playwright/test';

async function authenticate(page: Page, role = 'user', locale = 'en') {
	await page.route('**/api/v1/me/book-states?*', (route) => route.fulfill({ json: { items: [] } }));
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role, locale } } })
	);
}

function problem(route: Route, status: number) {
	return route.fulfill({
		status,
		contentType: 'application/problem+json',
		body: JSON.stringify({ title: 'Problem', status })
	});
}

const result = (id: number, title: string) => ({
	id,
	title,
	authors: ['Frank Herbert'],
	series: { id: 3, name: 'Dune', index: id === 101 ? 1 : 2 },
	cover_url: `/api/v1/books/${id}/cover?v=1`,
	rank: -1.25
});

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
	series: null,
	tags: [],
	identifiers: [],
	files: [],
	field_sources: [],
	created_at: '2026-11-03T00:00:00Z',
	updated_at: '2026-11-03T00:00:00Z'
};

const shelf = (id: number, name: string, kind: 'private' | 'shared', count = 1) => ({
	id,
	kind,
	owner_id: kind === 'private' ? 1 : null,
	name,
	description: kind === 'shared' ? 'Picked by staff' : null,
	created_by: 1,
	visible_book_count: count,
	created_at: '2026-11-03T00:00:00Z',
	updated_at: '2026-11-03T00:00:00Z'
});

test('searches from the app shell with opaque cursors, empty, and stale-cursor states', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	const queries: URLSearchParams[] = [];
	await page.route('**/api/v1/search?*', async (route) => {
		const params = new URL(route.request().url()).searchParams;
		queries.push(params);
		const q = params.get('q');
		const cursor = params.get('cursor');
		if (q === 'dune' && cursor === null) return route.fulfill({ json: { items: [result(101, 'Dune')], next_cursor: 'opaque/+cursor=' } });
		if (q === 'dune') return route.fulfill({ json: { items: [result(102, 'Dune Messiah')], next_cursor: null } });
		if (q === 'stale' && cursor === null) return route.fulfill({ json: { items: [result(101, 'Dune')], next_cursor: 'stale-cursor' } });
		if (q === 'stale') return problem(route, 400);
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});

	await page.goto('/');
	const shellSearch = page.getByRole('searchbox', { name: 'Search books' });
	await shellSearch.fill('dune');
	await shellSearch.press('Enter');
	await expect(page).toHaveURL(/\/search\?q=dune$/);
	await expect(page.getByRole('link', { name: 'Dune', exact: true }).first()).toHaveAttribute('href', '/books/101');
	await expect(page.getByRole('img', { name: 'Cover of Dune' })).toBeVisible();
	await expect(page.getByText('Relevance 1.25')).toBeVisible();

	await page.getByRole('button', { name: 'Load more results' }).click();
	await expect(page.getByRole('link', { name: 'Dune Messiah' })).toBeVisible();
	await expect(page.getByText('You have reached the end of the results.')).toBeVisible();
	expect(queries).toHaveLength(2);
	expect(queries[1].get('cursor')).toBe('opaque/+cursor=');
	expect(queries[1].get('q')).toBe('dune');

	const pageSearch = page.getByRole('searchbox', { name: 'Search books' });
	await pageSearch.fill('nothing');
	await pageSearch.press('Enter');
	await expect(page.getByText('No books match “nothing”.')).toBeVisible();
	expect(queries.at(-1)?.has('cursor')).toBe(false);

	await pageSearch.fill('stale');
	await pageSearch.press('Enter');
	await page.getByRole('button', { name: 'Load more results' }).click();
	await expect(page.getByRole('alert')).toContainText('Start the search again');
	const before = queries.length;
	await page.getByRole('button', { name: 'Start the search again' }).click();
	await expect.poll(() => queries.length).toBe(before + 1);
	expect(queries.at(-1)?.get('q')).toBe('stale');
	expect(queries.at(-1)?.has('cursor')).toBe(false);

	await page.getByRole('button', { name: 'Clear search' }).click();
	await expect(page).toHaveURL(/\/search$/);
	await expect(page.getByText('Enter a word or phrase to search the books you can access.')).toBeVisible();
	await expect(pageSearch).toBeFocused();
});

test('creates, browses, edits membership, and deletes a private shelf', async ({ page }) => {
	await authenticate(page);
	const created: unknown[] = [];
	let favoritesBooks = [book];
	let deleted = false;
	const patches: unknown[] = [];
	let favorites = { ...shelf(7, 'Favorites', 'private'), description: 'Old notes' as string | null };
	const listed = [shelf(7, 'Favorites', 'private'), shelf(8, 'Staff picks', 'shared')];
	await page.route('**/api/v1/shelves?*', (route) =>
		route.fulfill({ json: { items: listed, next_cursor: null } })
	);
	await page.route('**/api/v1/shelves', async (route) => {
		const body = route.request().postDataJSON();
		created.push(body);
		if (body.name === 'Favorites') return problem(route, 409);
		const createdShelf = shelf(9, body.name, 'private', 0);
		listed.push(createdShelf);
		return route.fulfill({ status: 201, json: { shelf: createdShelf } });
	});
	await page.route('**/api/v1/shelves/7', async (route) => {
		if (route.request().method() === 'DELETE') {
			deleted = true;
			return route.fulfill({ json: { deleted: true } });
		}
		if (route.request().method() === 'PATCH') {
			const body = route.request().postDataJSON();
			patches.push(body);
			favorites = { ...favorites, ...body };
		}
		return route.fulfill({ json: { shelf: { ...favorites, visible_book_count: favoritesBooks.length } } });
	});
	const bookQueries: URLSearchParams[] = [];
	await page.route('**/api/v1/shelves/7/books?*', (route) => {
		const params = new URL(route.request().url()).searchParams;
		bookQueries.push(params);
		if (params.get('cursor') === 'shelf-cursor') return problem(route, 400);
		return route.fulfill({ json: { items: favoritesBooks, next_cursor: favoritesBooks.length ? 'shelf-cursor' : null } });
	});
	await page.route('**/api/v1/shelves/7/books/21', (route) => {
		favoritesBooks = [];
		return route.fulfill({ json: { removed: true } });
	});
	await page.route('**/api/v1/shelves/8', (route) => route.fulfill({ json: { shelf: shelf(8, 'Staff picks', 'shared') } }));
	await page.route('**/api/v1/shelves/8/books?*', (route) => route.fulfill({ json: { items: [book], next_cursor: null } }));

	await page.goto('/shelves');
	await expect(page.getByRole('main').getByRole('link', { name: 'Favorites' })).toBeVisible();
	await expect(page.getByText('Shared', { exact: true })).toBeVisible();
	await expect(page.getByRole('main').getByRole('button', { name: 'Create shelf' })).toHaveCount(0);

	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await sidebar.getByRole('button', { name: 'Shelf actions' }).click();
	await sidebar.getByRole('menuitem', { name: 'New shelf' }).click();
	const creator = page.getByRole('dialog', { name: 'Create shelf' });
	await expect(creator.getByLabel('Shared', { exact: true })).toHaveCount(0);
	await creator.getByRole('button', { name: 'Create shelf' }).click();
	await expect(creator.getByText('Enter a shelf name.')).toBeVisible();
	expect(created).toHaveLength(0);

	await creator.getByLabel('Shelf name').fill('Favorites');
	await creator.getByRole('button', { name: 'Create shelf' }).click();
	await expect(creator.getByRole('alert')).toContainText('A shelf with this name already exists.');

	await creator.getByLabel('Shelf name').fill('  To read  ');
	await creator.getByRole('button', { name: 'Create shelf' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Shelf created.' })).toBeVisible();
	expect(created.at(-1)).toEqual({ kind: 'private', name: 'To read', description: null, mode: 'manual' });
	await expect(creator).toHaveCount(0);
	await expect(page.getByRole('main').getByRole('link', { name: 'To read', exact: true })).toHaveCount(2);

	await page.goto('/shelves/8');
	await expect(page.getByRole('heading', { name: 'Staff picks' })).toHaveClass('sr-only');
	await expect(page.getByTitle('A Book', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Remove “A Book”/ })).toHaveCount(0);

	await page.goto('/shelves/7');
	await page.getByText('Shelf details', { exact: true }).click();
	await expect(page.getByText('Old notes')).toBeVisible();
	await page.getByRole('button', { name: 'Edit details' }).click();
	await expect(page.getByLabel('Name')).toHaveValue('Favorites');
	await page.getByLabel('Name').fill('Best books');
	await page.getByLabel('Description (optional)').fill('');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('heading', { name: 'Best books', level: 1 })).toHaveClass('sr-only');
	await expect(page.getByText('Shelf updated.')).toBeVisible();
	await expect(page.getByText('Old notes')).toHaveCount(0);
	expect(patches).toEqual([{ name: 'Best books', description: null }]);

	await expect(page.getByTitle('A Book', { exact: true })).toHaveAttribute('href', '/books/21');
	await page.getByRole('button', { name: 'Load more books' }).click();
	await expect(page.getByRole('alert')).toContainText('This shelf changed while you were browsing.');
	expect(bookQueries.at(-1)?.get('cursor')).toBe('shelf-cursor');

	await page.getByRole('button', { name: 'Remove “A Book” from this shelf' }).click();
	await expect(page.getByText('This shelf has no books you can see.')).toBeVisible();
	await expect(page.getByText('The book itself was not deleted.')).toBeVisible();
	expect(bookQueries.at(-1)?.has('cursor')).toBe(false);

	await expect(page.getByText('Deleting a shelf removes only the shelf, not the books on it.')).toBeVisible();
	page.once('dialog', (dialog) => dialog.dismiss());
	await page.getByRole('button', { name: 'Delete shelf' }).click();
	expect(deleted).toBe(false);
	page.once('dialog', (dialog) => {
		expect(dialog.message()).toContain('will not be deleted');
		void dialog.accept();
	});
	await page.getByRole('button', { name: 'Delete shelf' }).click();
	await expect(page).toHaveURL(/\/shelves$/);
	expect(deleted).toBe(true);
});

test('offers shared shelves to administrators and reports shelf permission failures', async ({ page }) => {
	await authenticate(page, 'admin', 'zh');
	const created: unknown[] = [];
	let attempts = 0;
	await page.route('**/api/v1/shelves?*', (route) =>
		route.fulfill({ json: { items: [shelf(8, 'Staff picks', 'shared')], next_cursor: null } })
	);
	await page.route('**/api/v1/shelves', (route) => {
		const body = route.request().postDataJSON();
		created.push(body);
		return route.fulfill({ status: 201, json: { shelf: { ...shelf(10, body.name, 'shared', 0) } } });
	});
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book } }));
	await page.route('**/api/v1/shelves/8/books/21', (route) => {
		attempts += 1;
		return attempts === 1 ? problem(route, 403) : route.fulfill({ json: { saved: true } });
	});

	await page.goto('/shelves');
	const sidebar = page.getByRole('navigation', { name: '主导航' });
	await sidebar.getByRole('button', { name: '书架操作' }).click();
	await sidebar.getByRole('menuitem', { name: '新建书架' }).click();
	const creator = page.getByRole('dialog', { name: '创建书架' });
	await creator.getByLabel('书架名称').fill('Staff favourites');
	await creator.getByLabel('共享', { exact: true }).check();
	await creator.getByRole('button', { name: '创建书架' }).click();
	await expect(page.getByText('书架已创建。')).toBeVisible();
	expect(created).toEqual([{ kind: 'shared', name: 'Staff favourites', description: null, mode: 'manual' }]);

	await page.goto('/books/21');
	const picker = page.getByRole('dialog', { name: '添加到书架' });
	await page.getByRole('main').getByRole('button', { name: '添加到书架', exact: true }).click();
	const staffPicks = picker.getByRole('button', { name: /Staff picks/ });
	await expect(staffPicks).toContainText('共享');
	await staffPicks.click();
	await expect(picker.getByText('你没有权限更改此书架。')).toBeVisible();
	await staffPicks.click();
	await expect(page.getByText('已添加到“Staff picks”。')).toBeAttached();
	await expect(picker).toHaveCount(0);
	expect(attempts).toBe(2);
});

async function expectStandardTiles(page: Page, count: number) {
	const covers = page.locator('ul.book-grid > li .book-cover');
	await expect(covers).toHaveCount(count);
	const geometry = await covers.evaluateAll((elements) => ({
		widths: elements.map((element) => element.getBoundingClientRect().width),
		standard: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--spacing-book')) *
			Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
	}));
	expect(geometry.standard).toBe(208);
	expect(geometry.widths).toEqual(Array.from({ length: count }, () => geometry.standard));
}

async function expectFluidTwoColumns(page: Page) {
	await page.setViewportSize({ width: 360, height: 800 });
	await expect(page.locator('ul.book-grid')).toHaveCSS('grid-template-columns', /^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
}

test('manual and system shelves use the standard tile grid', async ({ page }) => {
	await authenticate(page);
	const books = [1, 2, 3, 4, 5].map((index) => ({ ...book, id: 60 + index, title: `Shelf Book ${index}`, sort_title: `Shelf Book ${index}` }));
	await page.route('**/api/v1/shelves?*', (route) => route.fulfill({ json: { items: [shelf(7, 'Favorites', 'private', books.length)], next_cursor: null } }));
	await page.route('**/api/v1/shelves/7', (route) => route.fulfill({ json: { shelf: shelf(7, 'Favorites', 'private', books.length) } }));
	await page.route('**/api/v1/shelves/7/books?*', (route) => route.fulfill({ json: { items: books, next_cursor: null } }));
	await page.route('**/api/v1/shelves/system/favorites', (route) => route.fulfill({ json: { shelf: {
		...shelf(12, 'favorites', 'private', books.length), mode: 'system', system_key: 'favorites'
	} } }));
	await page.route('**/api/v1/shelves/system/favorites/books?*', (route) => route.fulfill({ json: { items: books, next_cursor: null } }));

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/shelves/7');
	await expect(page.getByTitle('Shelf Book 1', { exact: true })).toHaveAttribute('href', '/books/61');
	await expectStandardTiles(page, books.length);
	const tile = page.locator('ul.book-grid > li').first();
	const remove = tile.getByRole('button', { name: 'Remove “Shelf Book 1” from this shelf' });
	await expect(remove).toHaveText('Remove from shelf');
	await expect(remove).toHaveCSS('font-size', '12px');
	const [tileBox, removeBox] = await Promise.all([tile.boundingBox(), remove.boundingBox()]);
	if (!tileBox || !removeBox) throw new Error('Missing shelf tile layout.');
	expect(removeBox.width).toBe(tileBox.width);
	expect(removeBox.y).toBeGreaterThan(tileBox.y + tileBox.width * 1.5);
	await expectFluidTwoColumns(page);

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/shelves/system/favorites');
	await expect(page.getByTitle('Shelf Book 1', { exact: true })).toHaveAttribute('href', '/books/61');
	await expectStandardTiles(page, books.length);
	await expect(page.locator('ul.book-grid li li')).toHaveCount(0);
	await expectFluidTwoColumns(page);
});
