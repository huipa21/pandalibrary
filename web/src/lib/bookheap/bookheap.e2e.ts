import { expect, test, type Page, type Route } from '@playwright/test';

const stamp = '2026-11-06T05:00:00Z';

async function authenticate(page: Page, role = 'admin') {
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'admin', display_name: 'Admin', role, locale: 'en' } } })
	);
	await page.route('**/api/v1/shelves?*', (route) => route.fulfill({ json: { items: [
		shelf(21, { name: 'Classics', kind: 'shared', owner_id: null }),
		shelf(22, { name: 'Smart', kind: 'shared', owner_id: null, mode: 'automatic' }),
		shelf(23, { name: 'Not mine', kind: 'private', owner_id: 2 })
	], next_cursor: null } }));
	for (const [key, id] of [['unshelved', 8], ['favorites', 9]] as const) {
		await page.route(`**/api/v1/shelves/system/${key}`, (route) =>
			route.fulfill({ json: { shelf: shelf(id, { name: key, mode: 'system', system_key: key }) } })
		);
	}
}

function shelf(id: number, overrides: Record<string, unknown> = {}) {
	return {
		id, kind: 'private', owner_id: 1, name: `Shelf ${id}`, description: null, created_by: 1,
		visible_book_count: 0, created_at: stamp, updated_at: stamp, mode: 'manual', system_key: null, ...overrides
	};
}

type Status = 'ready' | 'duplicate' | 'invalid' | 'queued' | 'importing' | 'failed';

interface Item {
	id: number;
	title: string;
	file_name: string;
	status: Status;
	error?: string | null;
	duplicate_of_book_id?: number | null;
	target_library_id?: number | null;
	target_shelf_ids?: number[];
	cover_url?: string;
}

function dto(item: Item) {
	return {
		id: item.id, file_name: item.file_name, rel_path: `incoming/${item.file_name}`,
		format: item.status === 'invalid' ? null : 'epub', size_bytes: 2048, sha256: 'a'.repeat(64),
		title: item.title, authors: ['Author'], language: null, series: null, series_index: null,
		has_cover: Boolean(item.cover_url), cover_url: item.cover_url ?? null, source: 'scan', status: item.status, error: item.error ?? null,
		duplicate_of_book_id: item.duplicate_of_book_id ?? null, duplicate_of_item_id: null,
		target_library_id: item.target_library_id ?? null, target_shelf_ids: item.target_shelf_ids ?? [],
		import_job_id: null, added_by: 1,
		created_at: `2026-11-06T05:${String(item.id).padStart(2, '0')}:00Z`, updated_at: stamp
	};
}

function scanDto(status: 'running' | 'completed', added: number) {
	return {
		id: 1, status, started_at: stamp, finished_at: status === 'running' ? null : stamp,
		added, updated: 0, removed: 0, unchanged: 0, invalid: 1, duplicates: 1, skipped: 0, in_progress: 0, error: null
	};
}

const problem = (route: Route, status: number) =>
	route.fulfill({ status, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Error', status }) });

/** In-memory Bookheap API: list with offset cursors, scan, assign (queued items import after a few polls), delete. */
async function mockBookheap(page: Page, initial: Item[], { scanAdds = [] as Item[] } = {}) {
	let items = [...initial];
	let scan: ReturnType<typeof scanDto> | null = null;
	let pending: Item[] = [];
	const listQueries: string[] = [];
	const assignBodies: unknown[] = [];
	const deleteBodies: unknown[] = [];
	let queuedPolls = 0;

	await page.route('**/api/v1/admin/bookheap/items?*', (route) => {
		const url = new URL(route.request().url());
		const status = url.searchParams.get('status');
		const q = url.searchParams.get('q')?.toLowerCase() ?? '';
		const limit = Number(url.searchParams.get('limit') ?? 50);
		const offset = Number(url.searchParams.get('cursor') ?? 0);
		if (!(status === 'ready' && limit === 1)) listQueries.push(url.search);
		// Queued items import after a few list reads.
		if (items.some((item) => item.status === 'queued') && ++queuedPolls > 2) {
			items = items.filter((item) => item.status !== 'queued');
		}
		const matched = items
			.filter((item) => !status || item.status === status)
			.filter((item) => !q || item.title.toLowerCase().includes(q) || item.file_name.toLowerCase().includes(q))
			.sort((a, b) => b.id - a.id);
		const slice = matched.slice(offset, offset + limit);
		const next = offset + limit < matched.length ? String(offset + limit) : null;
		return route.fulfill({ json: { items: slice.map(dto), next_cursor: next, total: matched.length } });
	});
	await page.route('**/api/v1/admin/bookheap/scan', (route) => {
		if (route.request().method() === 'POST') {
			scan = scanDto('running', 0);
			pending = scanAdds;
			return route.fulfill({ status: 202, json: { scan } });
		}
		if (scan?.status === 'running') {
			items = [...items, ...pending];
			scan = scanDto('completed', pending.length);
			return route.fulfill({ json: { scan: scanDto('running', 0) } });
		}
		return route.fulfill({ json: { scan } });
	});
	await page.route('**/api/v1/admin/libraries?*', (route) => route.fulfill({ json: { items: [
		{ id: 2, name: 'Main', slug: 'main', created_at: stamp, updated_at: stamp },
		{ id: 3, name: 'Comics', slug: 'comics', created_at: stamp, updated_at: stamp }
	], next_cursor: null } }));
	await page.route('**/api/v1/admin/bookheap/assign', (route) => {
		const body = route.request().postDataJSON() as { ids: number[]; library_id: number; shelf_ids: number[] };
		assignBodies.push(body);
		const results = body.ids.map((id) => {
			const item = items.find((entry) => entry.id === id);
			if (!item) return { id, ok: false, error: 'not_found', import_job_id: null };
			item.status = 'queued';
			item.target_library_id = body.library_id;
			item.target_shelf_ids = body.shelf_ids;
			queuedPolls = 0;
			return { id, ok: true, error: null, import_job_id: 100 + id };
		});
		return route.fulfill({ status: 202, json: { results } });
	});
	await page.route('**/api/v1/admin/bookheap/items/delete', (route) => {
		const body = route.request().postDataJSON() as { ids: number[] };
		deleteBodies.push(body);
		const results = body.ids.map((id) => {
			const item = items.find((entry) => entry.id === id);
			if (!item) return { id, ok: false, error: 'not_found' };
			if (item.status === 'importing') return { id, ok: false, error: 'busy' };
			items = items.filter((entry) => entry.id !== id);
			return { id, ok: true, error: null };
		});
		return route.fulfill({ json: { results } });
	});
	return { listQueries, assignBodies, deleteBodies };
}

const readyItems = (from: number, to: number): Item[] =>
	Array.from({ length: to - from + 1 }, (_, index) => {
		const id = from + index;
		return { id, title: `Ready ${id}`, file_name: `ready-${id}.epub`, status: 'ready' as const };
	});

test('administrators see Bookheap in HOME, an empty heap, and a scan that refreshes the list', async ({ page }) => {
	await authenticate(page);
	await mockBookheap(page, [], {
		scanAdds: [
			{ id: 1, title: 'Dune', file_name: 'dune.epub', status: 'ready' },
			{ id: 2, title: 'Copy', file_name: 'copy.epub', status: 'duplicate', duplicate_of_book_id: 44 },
			{ id: 3, title: 'broken', file_name: 'broken.epub', status: 'invalid', error: 'not a valid EPUB' }
		]
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/bookheap');

	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	const home = sidebar.getByRole('region', { name: 'Home' }).getByRole('link');
	await expect(home).toHaveText(['Dashboard', 'All Books', /^Bookheap/, 'Annotations']);
	await expect(sidebar.getByRole('link', { name: /^Bookheap/ })).toHaveAttribute('aria-current', 'page');
	await expect(page).toHaveTitle(/^Bookheap ·/);
	await expect(page.getByRole('heading', { level: 1, name: 'Bookheap' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'The Bookheap is empty' })).toBeVisible();
	await expect(page.getByTestId('bh4-nav-count')).toHaveCount(0);

	await page.getByRole('main').getByRole('search').getByRole('button', { name: 'Scan', exact: true }).click();
	const summary = page.getByTestId('bh4-scan-summary');
	await expect(page.getByTestId('bh4-scan-status')).toContainText('Scan complete');
	await expect(summary).toContainText('Added: 3');
	await expect(summary).toContainText('Duplicates: 1');
	await expect(summary).toContainText('Invalid: 1');
	await page.getByRole('button', { name: 'Switch to list view', exact: true }).click();

	const rows = page.getByTestId('bh4-row');
	await expect(rows).toHaveCount(3);
	await expect(page.getByTestId('bh4-total')).toContainText('Files: 3');
	const duplicate = rows.filter({ hasText: 'Copy' });
	await expect(duplicate.getByTestId('bh4-row-status')).toHaveText('Duplicate');
	await expect(duplicate.getByRole('link', { name: 'View the existing book' })).toHaveAttribute('href', '/books/44');
	const invalid = rows.filter({ hasText: 'broken' });
	await expect(invalid.getByTestId('bh4-row-error')).toHaveText('not a valid EPUB');
	await expect(invalid).toContainText('Unknown');
	await expect(page.getByTestId('bh4-nav-count')).toContainText('1');
});

for (const view of ['grid', 'list'] as const) {
	test(`filters, paging, and Assign work in ${view} view`, async ({ page }) => {
		await authenticate(page);
		const heap = await mockBookheap(page, [
			...readyItems(1, 55),
			{ id: 60, title: 'Twin', file_name: 'twin.epub', status: 'duplicate', duplicate_of_book_id: 7 }
		]);
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/bookheap?status=ready');
		if (view === 'list') await page.getByRole('button', { name: 'Switch to list view', exact: true }).click();

		const main = page.getByRole('main');
		await expect(main.getByLabel('Status')).toHaveValue('ready');
		const rows = page.getByTestId('bh4-row');
		await expect(rows).toHaveCount(50);
		await expect(page.getByTestId('bh4-total')).toContainText('Files: 55');

		await main.getByLabel('Select all shown').check();
		await expect(page.getByTestId('bh4-selected-count')).toHaveText('Selected: 50');
		await main.getByRole('button', { name: 'Load more files' }).click();
		await expect(rows).toHaveCount(55);
		await expect(main.getByLabel('Select all shown')).not.toBeChecked();
		await main.getByRole('checkbox', { name: 'Select Ready 1', exact: true }).check();
		await expect(page.getByTestId('bh4-selected-count')).toHaveText('Selected: 51');

		await page.getByTestId('bh4-bulk-bar').getByRole('button', { name: 'Assign…' }).click();
		const dialog = page.getByRole('dialog', { name: 'Assign to a library' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByTestId('bh4-assign-count')).toHaveText('Files to assign: 51');
		await expect(dialog.getByLabel('Library')).toBeFocused();
		await expect(dialog.getByRole('checkbox')).toHaveCount(2);
		await expect(dialog.getByLabel('Favorites')).toBeVisible();
		await dialog.getByRole('button', { name: 'Assign (51)' }).click();
		await expect(dialog.getByText('Choose a library.')).toBeVisible();
		await dialog.getByLabel('Library').selectOption({ label: 'Main' });
		await dialog.getByLabel(/Classics/).check();
		await dialog.getByRole('button', { name: 'Assign (51)' }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId('bh4-notice')).toContainText('Queued for import: 51');
		await expect(page.getByTestId('bh4-bulk-bar')).toBeHidden();
		expect(heap.assignBodies).toHaveLength(1);
		const body = heap.assignBodies[0] as { ids: number[]; library_id: number; shelf_ids: number[] };
		expect(body.library_id).toBe(2);
		expect(body.shelf_ids).toEqual([21]);
		expect(body.ids).toHaveLength(51);

		await expect(rows).toHaveCount(4, { timeout: 15_000 });
		await expect(page.getByTestId('bh4-total')).toContainText('Files: 4');

		await main.getByRole('searchbox', { name: 'Search', exact: true }).fill('ready 5');
		await expect(page).toHaveURL(/status=ready/);
		await expect(page).toHaveURL(/q=ready\+5/);
		await main.getByLabel('Status').selectOption('');
		await expect(page).not.toHaveURL(/status=/);
		await expect(page).toHaveURL(/q=ready\+5/);
		await main.getByRole('searchbox', { name: 'Search', exact: true }).fill('nothing here');
		await expect(main.getByText('No files match these filters.')).toBeVisible();
		await main.getByRole('button', { name: 'Clear filters' }).first().click();
		await expect(page).toHaveURL(/\/bookheap$/);
		await expect(rows).toHaveCount(5);

		await page.goto('/bookheap?status=duplicate&q=twin');
		await expect(rows).toHaveCount(1);
		await expect(main.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue('twin');
		expect(heap.listQueries.some((query) => query.includes('status=duplicate') && query.includes('q=twin'))).toBe(true);
	});
}

test('Assign skips items that cannot be assigned and the combined active filter merges statuses', async ({ page }) => {
	await authenticate(page);
	const heap = await mockBookheap(page, [
		{ id: 1, title: 'Ready one', file_name: 'one.epub', status: 'ready' },
		{ id: 2, title: 'Twin', file_name: 'twin.epub', status: 'duplicate', duplicate_of_book_id: 7 },
		{ id: 3, title: 'Waiting', file_name: 'waiting.epub', status: 'importing' }
	]);
	await page.goto('/bookheap');
	const main = page.getByRole('main');
	await expect(page.getByTestId('bh4-row')).toHaveCount(3);
	await main.getByRole('checkbox', { name: 'Select Ready one', exact: true }).check();
	await main.getByRole('checkbox', { name: 'Select Twin', exact: true }).check();
	await page.getByRole('button', { name: 'Assign…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Assign to a library' });
	await expect(dialog.getByTestId('bh4-assign-count')).toHaveText('Files to assign: 1');
	await expect(dialog.getByTestId('bh4-assign-skipped')).toContainText(': 1');
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('button', { name: 'Assign…' })).toBeFocused();
	expect(heap.assignBodies).toHaveLength(0);

	await main.getByLabel('Status').selectOption({ label: 'Queued/Importing' });
	await expect(page).toHaveURL(/status=active/);
	await expect(page.getByTestId('bh4-row')).toHaveCount(1);
	await expect(page.getByTestId('bh4-row-status')).toHaveText('Importing');
	await expect(page.getByTestId('bh4-selected-count')).toBeHidden();
	expect(heap.listQueries.filter((query) => /status=(queued|importing)/.test(query)).length).toBeGreaterThanOrEqual(2);
});

for (const view of ['grid', 'list'] as const) {
	test(`Delete confirms and reports failures in ${view} view`, async ({ page }) => {
		await authenticate(page);
		const heap = await mockBookheap(page, [
			{ id: 1, title: 'Keep', file_name: 'keep.epub', status: 'ready' },
			{ id: 2, title: 'Gone', file_name: 'gone.epub', status: 'ready' },
			{ id: 3, title: 'Busy', file_name: 'busy.epub', status: 'importing' }
		]);
		await page.goto('/bookheap');
		if (view === 'list') await page.getByRole('button', { name: 'Switch to list view', exact: true }).click();
		const main = page.getByRole('main');
		await main.getByRole('checkbox', { name: 'Select Gone', exact: true }).check();
		await main.getByRole('checkbox', { name: 'Select Busy', exact: true }).check();
		await page.getByRole('button', { name: 'Delete…' }).click();
		const dialog = page.getByRole('dialog', { name: 'Delete from the Bookheap' });
		await expect(dialog).toContainText('Delete 2 files from the server Bookheap? This cannot be undone.');
		await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		expect(heap.deleteBodies).toHaveLength(0);

		await page.getByRole('button', { name: 'Delete…' }).click();
		await dialog.getByRole('button', { name: 'Delete (2)' }).click();
		const results = dialog.getByTestId('bh4-bulk-results');
		await expect(results).toContainText('Deleted: 1. Not deleted: 1.');
		await expect(results.getByRole('list', { name: 'Files that were not processed' })).toContainText('Busy');
		await expect(results).toContainText('Being imported; try again when it finishes');
		await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(page.getByTestId('bh4-row')).toHaveCount(2);
		await expect(page.getByTestId('bh4-selected-count')).toHaveText('Selected: 1');
		expect(heap.deleteBodies).toEqual([{ ids: [2, 3] }]);
	});
}

test('grid is the default, uses standard covers, and respects responsive sizing and reduced motion', async ({ page }) => {
	await authenticate(page);
	await mockBookheap(page, [
		...readyItems(1, 2),
		{ id: 3, title: 'Broken cover', file_name: 'broken.epub', status: 'ready', cover_url: '/heap-cover.jpg' },
		{ id: 4, title: 'Real cover', file_name: 'real.epub', status: 'ready', cover_url: '/good-cover.svg' }
	]);
	await page.route('**/heap-cover.jpg?thumbnail=1', (route) => route.fulfill({ status: 404 }));
	await page.route('**/good-cover.svg?thumbnail=1', (route) => route.fulfill({
		contentType: 'image/svg+xml',
		body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="navy"/></svg>'
	}));
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/bookheap');
	await expect(page.getByRole('button', { name: 'Switch to list view', exact: true })).toBeVisible();
	const tiles = page.locator('[data-heap-tile]');
	await expect(tiles).toHaveCount(4);
	const generated = tiles.filter({ hasText: 'Ready 2' }).locator('[data-generated-cover]');
	await expect(generated).toHaveAttribute('aria-label', 'Ready 2');
	await expect(tiles.filter({ hasText: 'Broken cover' }).locator('[data-generated-cover]')).toBeVisible();
	await expect(tiles.filter({ hasText: 'Real cover' }).getByRole('img', { name: 'Real cover' })).toHaveAttribute('src', '/good-cover.svg?thumbnail=1');

	const cover = tiles.filter({ hasText: 'Ready 2' }).locator('.book-cover');
	const geometry = await cover.evaluate((element) => ({
		width: element.getBoundingClientRect().width,
		height: element.getBoundingClientRect().height,
		standard: Number.parseFloat(getComputedStyle(element).getPropertyValue('--spacing-book')) *
			Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
	}));
	expect(geometry.width).toBe(geometry.standard);
	expect(geometry.width).toBe(208);
	expect(geometry.height / geometry.width).toBeCloseTo(1.5);
	await expect(tiles.filter({ hasText: 'Ready 2' }).getByText('ready-2.epub')).toHaveAttribute('title', 'incoming/ready-2.epub');

	const frame = cover.locator('..');
	await frame.hover();
	await expect(frame).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -4)');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(frame).toHaveCSS('transform', 'none');
	await expect(frame).toHaveCSS('transition-duration', '0s');
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByRole('list', { name: 'Bookheap files' })).toHaveCSS('grid-template-columns', /^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('keeps Bookheap filters and view controls usable on narrow screens', async ({ page }) => {
	await authenticate(page);
	await mockBookheap(page, readyItems(1, 2));
	await page.setViewportSize({ width: 360, height: 844 });
	await page.goto('/bookheap');
	const filters = page.getByRole('main').getByRole('search');
	const search = filters.getByRole('searchbox', { name: 'Search', exact: true });
	const status = filters.getByRole('combobox', { name: 'Status', exact: true });
	const views = filters.getByRole('button', { name: 'Switch to list view', exact: true });
	for (const width of [320, 360, 390, 768]) {
		await page.setViewportSize({ width, height: 844 });
		const boxes = await Promise.all([search.boundingBox(), status.boundingBox(), views.boundingBox()]);
		if (boxes.some((box) => box === null)) throw new Error('A Bookheap filter is not visible');
		const [searchBox, statusBox, viewsBox] = boxes;
		expect(searchBox!.width).toBeGreaterThanOrEqual(160);
		for (const other of [statusBox!, viewsBox!]) {
			const separated = searchBox!.x + searchBox!.width <= other.x ||
				other.x + other.width <= searchBox!.x ||
				searchBox!.y + searchBox!.height <= other.y ||
				other.y + other.height <= searchBox!.y;
			expect(separated, `Bookheap search overlaps another control at ${width}px`).toBe(true);
		}
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
	}
	await page.setViewportSize({ width: 320, height: 844 });
	await search.fill('Ready 2');
	await search.press('Enter');
	await expect(page).toHaveURL(/q=Ready(?:\+|%20)2/);
	await expect(page.getByTestId('bh4-row')).toHaveCount(1);
	const filteredBox = await search.boundingBox();
	if (!filteredBox) throw new Error('Bookheap search disappeared after filtering');
	expect(filteredBox.width).toBeGreaterThanOrEqual(160);
	await filters.getByRole('button', { name: 'Clear filters' }).click();
	await expect(search).toHaveValue('');
	await expect(page.getByTestId('bh4-row')).toHaveCount(2);
});

test('switching views preserves selection and persists across reload', async ({ page }) => {
	await authenticate(page);
	const heap = await mockBookheap(page, readyItems(1, 2));
	await page.goto('/bookheap?status=ready');
	await page.getByRole('checkbox', { name: 'Select Ready 2', exact: true }).check();
	const queries = heap.listQueries.length;
	await page.getByRole('button', { name: 'Switch to list view', exact: true }).click();
	await expect(page.locator('[data-heap-tile]')).toHaveCount(0);
	await expect(page.getByRole('checkbox', { name: 'Select Ready 2', exact: true })).toBeChecked();
	await expect(page.getByTestId('bh4-selected-count')).toHaveText('Selected: 1');
	await expect(page.getByTestId('bh4-row').locator('[data-generated-cover]')).toHaveCount(2);
	await expect(page.getByTestId('bh4-row').first().locator('.book-cover')).toHaveCSS('width', '48px');
	expect(heap.listQueries).toHaveLength(queries);
	await expect(page).toHaveURL(/status=ready/);
	expect(await page.evaluate(() => localStorage.getItem('pandalibrary.bookheap.view'))).toBe('list');
	await page.reload();
	await expect(page.getByRole('button', { name: 'Switch to grid view', exact: true })).toBeVisible();
	await page.getByRole('checkbox', { name: 'Select Ready 2', exact: true }).check();
	await page.getByRole('button', { name: 'Switch to grid view', exact: true }).click();
	await expect(page.getByRole('checkbox', { name: 'Select Ready 2', exact: true })).toBeChecked();
	await page.reload();
	await expect(page.getByRole('button', { name: 'Switch to list view', exact: true })).toBeVisible();
	await expect(page.locator('[data-heap-tile]')).toHaveCount(2);
});

test('storage failures are reported without blocking view changes', async ({ page }) => {
	await authenticate(page);
	await mockBookheap(page, readyItems(1, 1));
	await page.addInitScript(() => {
		const getItem = Storage.prototype.getItem;
		const setItem = Storage.prototype.setItem;
		Storage.prototype.getItem = function (key) {
			if (key === 'pandalibrary.bookheap.view') throw new DOMException('Blocked', 'SecurityError');
			return getItem.call(this, key);
		};
		Storage.prototype.setItem = function (key, value) {
			if (key === 'pandalibrary.bookheap.view') throw new DOMException('Full', 'QuotaExceededError');
			return setItem.call(this, key, value);
		};
	});
	await page.goto('/bookheap');
	await expect(page.getByRole('alert')).toContainText('Could not load your saved view');
	await page.getByRole('button', { name: 'Switch to list view', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Could not save your view');
	await expect(page.getByRole('button', { name: 'Switch to grid view', exact: true })).toBeVisible();
	await expect(page.getByTestId('bh4-row')).toHaveCount(1);
	await expect(page.locator('[data-heap-tile]')).toHaveCount(0);
});

test('an unrecognized saved view uses grid and load errors remain retryable in either view', async ({ page }) => {
	await authenticate(page);
	await mockBookheap(page, readyItems(1, 1));
	await page.addInitScript(() => localStorage.setItem('pandalibrary.bookheap.view', 'obsolete'));
	let unavailable = true;
	await page.route('**/api/v1/admin/bookheap/items?*', (route) => {
		if (new URL(route.request().url()).searchParams.get('limit') === '50' && unavailable) {
			return problem(route, 503);
		}
		return route.fallback();
	});
	await page.goto('/bookheap');
	await expect(page.getByRole('button', { name: 'Switch to list view', exact: true })).toBeVisible();
	await expect(page.getByRole('alert')).toBeVisible();
	await page.getByRole('button', { name: 'Switch to list view', exact: true }).click();
	await expect(page.getByRole('alert')).toBeVisible();
	unavailable = false;
	await page.getByRole('alert').getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(page.getByTestId('bh4-row')).toHaveCount(1);
	await expect(page.getByRole('alert')).toBeHidden();
	await page.getByRole('button', { name: 'Switch to grid view', exact: true }).click();
	await expect(page.locator('[data-heap-tile]')).toHaveCount(1);
});

test('readers do not see Bookheap and are told the page is for administrators', async ({ page }) => {
	await authenticate(page, 'user');
	const requests: string[] = [];
	await page.route('**/api/v1/admin/bookheap/**', (route) => {
		requests.push(route.request().url());
		return problem(route, 403);
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/bookheap');
	await expect(page.getByRole('alert')).toContainText(/administrator/i);
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await expect(sidebar.getByRole('region', { name: 'Home' }).getByRole('link')).toHaveText(['Dashboard', 'All Books', 'Annotations']);
	await expect(page.getByTestId('bh4-row')).toHaveCount(0);
	expect(requests).toEqual([]);
});
