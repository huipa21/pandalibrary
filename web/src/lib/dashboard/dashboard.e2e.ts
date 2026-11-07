import { expect, test, type Page, type Route } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

type Layout = { version: number; sections: Array<{ id: string }> };
type Shelf = {
	id: number;
	kind: 'private' | 'shared';
	owner_id: number | null;
	name: string;
	description: string | null;
	created_by: number;
	visible_book_count: number;
	created_at: string;
	updated_at: string;
	mode: 'manual' | 'automatic';
	system_key: string | null;
};

const timestamp = '2026-11-04T00:00:00Z';
const book = (id: number, title: string) => ({
	id, library_id: 1, title, sort_title: title, subtitle: null, description: null, language: null,
	publisher: null, published_date: null, page_count: null, cover_url: null, cover_source: null,
	authors: [], series: null, tags: [], identifiers: [], field_sources: [],
	files: [
		{ id: 11, format: 'epub', size_bytes: 10, download_url: `/api/v1/books/${id}/files/11?v=${'a'.repeat(64)}` },
		{ id: 12, format: 'pdf', size_bytes: 10, download_url: `/api/v1/books/${id}/files/12?v=${'b'.repeat(64)}` }
	],
	created_at: timestamp, updated_at: timestamp
});
const shelf = (id: number, name: string, mode: 'manual' | 'automatic' = 'manual'): Shelf => ({
	id, kind: 'private', owner_id: 1, name, description: null, created_by: 1, visible_book_count: 0,
	created_at: timestamp, updated_at: timestamp, mode, system_key: id === 7 ? 'favorites' : null
});

interface ServerState {
	account: number;
	locale: 'en' | 'zh';
	revision: number;
	settings: Map<number, { value: Layout; rev: number; updated_at: string }>;
	shelves: Map<number, Shelf>;
	hidden: Set<number>;
	feedFailure: Set<string>;
	moreFailure: Set<string>;
	feedRequests: Array<{ section: string; cursor: string | null }>;
	shelfRequests: Array<string | null>;
	paginateShelves: boolean;
	progressFile: number | null;
	nextPush: 'applied' | 'stale' | 'rejected';
}

function state(): ServerState {
	return {
		account: 1, locale: 'en', revision: 0, settings: new Map(),
		shelves: new Map([[7, shelf(7, 'Server favorites')], [8, shelf(8, 'Automatic picks', 'automatic')]]),
		hidden: new Set(), feedFailure: new Set(), moreFailure: new Set(), feedRequests: [],
		shelfRequests: [], paginateShelves: false,
		progressFile: 12, nextPush: 'applied'
	};
}

function seed(server: ServerState, account: number, value: Layout) {
	server.revision += 1;
	server.settings.set(account, { value, rev: server.revision, updated_at: timestamp });
}

function problem(route: Route, status: number) {
	return route.fulfill({
		status, contentType: 'application/problem+json',
		body: JSON.stringify({ status, title: 'Request failed' })
	});
}

async function mockApi(page: Page, server: ServerState) {
	await page.route((url) => url.pathname.startsWith('/api/v1/'), async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.replace('/api/v1', '');
		const method = request.method();
		const current = server.settings.get(server.account);
		const setting = current && {
			key: 'dashboard.layout.v1', value: current.value, rev: current.rev, updated_at: current.updated_at
		};

		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: {
			id: server.account, username: `reader${server.account}`, display_name: '', role: 'user', locale: server.locale
		} } });
		if (path === '/sync/pull') {
			const cursor = Number(url.searchParams.get('cursor') ?? 0);
			return route.fulfill({ json: {
				cursor: Math.max(cursor, server.revision), user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [],
				user_settings: setting && setting.rev > cursor ? [setting] : []
			} });
		}
		if (path === '/sync/push' && method === 'POST') {
			const body = request.postDataJSON() as {
				mutations: Array<{ entity: string; key?: string; data: { value?: Layout } }>;
			};
			const results = body.mutations.map((mutation, index) => {
				const status = server.nextPush;
				server.nextPush = 'applied';
				if (status === 'applied' && mutation.entity === 'user_settings' &&
					mutation.key === 'dashboard.layout.v1' && mutation.data.value) {
					seed(server, server.account, mutation.data.value);
				}
				return { index, status, ...(status === 'rejected' ? { reason: 'denied' } : {}) };
			});
			return route.fulfill({ json: { results } });
		}
		if (path === '/me/settings') return route.fulfill({ json: { settings: setting ? [setting] : [] } });
		if (path === '/me/book-states') return route.fulfill({ json: { items: [{
			book_id: 21, status: 'reading', percentage: 0.4, book_file_id: 12, updated_at: timestamp
		}] } });
		if (path === '/shelves' && method === 'GET') {
			const cursor = url.searchParams.get('cursor');
			server.shelfRequests.push(cursor);
			const shelves = [...server.shelves.values()].filter((item) => !server.hidden.has(item.id));
			return route.fulfill({ json: {
				items: server.paginateShelves ? (cursor ? shelves.filter((item) => item.id !== 7) : shelves.filter((item) => item.id === 7)) : shelves,
				next_cursor: server.paginateShelves && !cursor ? 'shelves/+cursor=' : null
			} });
		}
		if (path === '/shelves' && method === 'POST') {
			const body = request.postDataJSON() as { name: string; mode: 'manual' | 'automatic' };
			const created = shelf(20, body.name, body.mode);
			server.shelves.set(created.id, created);
			return route.fulfill({ status: 201, json: { shelf: created } });
		}
		if (path.startsWith('/shelves/system/')) {
			return route.fulfill({ json: { shelf: shelf(7, 'Server favorites') } });
		}
		const shelfBooks = path.match(/^\/shelves\/(\d+)\/books$/);
		if (shelfBooks) {
			const id = Number(shelfBooks[1]);
			if (server.hidden.has(id)) return problem(route, 403);
			if (!server.shelves.has(id)) return problem(route, 404);
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		const shelfDetails = path.match(/^\/shelves\/(\d+)$/);
		if (shelfDetails) {
			const id = Number(shelfDetails[1]);
			const found = server.shelves.get(id);
			if (server.hidden.has(id)) return problem(route, 403);
			if (!found) return problem(route, 404);
			return route.fulfill({ json: { shelf: found } });
		}
		const feed = path.match(/^\/dashboard\/sections\/([^/]+)\/books$/);
		if (feed) {
			const section = feed[1];
			const cursor = url.searchParams.get('cursor');
			server.feedRequests.push({ section, cursor });
			if (server.feedFailure.has(section) || (cursor && server.moreFailure.has(section))) {
				return problem(route, 503);
			}
			if (section === 'continue_reading') {
				return route.fulfill({ json: cursor
					? { items: [book(21, 'First Book'), book(22, 'Second Book')], next_cursor: null }
					: { items: [book(21, 'First Book')], next_cursor: 'opaque/+cursor=' } });
			}
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		if (path === '/me/books/21') return route.fulfill({ json: {
			user_book: null, highlights: [], bookmarks: [], notes: [], progress: {
				book_file_id: server.progressFile, source: 'web', locator: null, percentage: 0.4,
				device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
			}
		} });
		if (path === '/books/21') return route.fulfill({ json: { book: book(21, 'First Book') } });
		return problem(route, 404);
	});
}

async function openConfig(page: Page) {
	await page.getByRole('button', { name: 'Configure dashboard' }).click();
	const dialog = page.getByRole('dialog', { name: 'Configure dashboard' });
	await expect(dialog).toBeVisible();
	return dialog;
}

test('defaults, keyboard dialog behavior, reorder, and a persisted empty dashboard', async ({ page }) => {
	const server = state();
	await mockApi(page, server);
	await page.goto('/');
	const sections = page.locator('[data-dashboard-section]');
	await expect(sections).toHaveCount(3);
	await expect.poll(() => sections.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute('data-dashboard-section'))
	)).toEqual(['continue_reading', 'recently_added', 'read']);

	let dialog = await openConfig(page);
	await expect(dialog.getByRole('heading', { name: 'Configure dashboard' })).toBeFocused();
	for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
	expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('button', { name: 'Configure dashboard' })).toBeFocused();

	dialog = await openConfig(page);
	await dialog.getByRole('button', { name: 'Move Continue Reading down' }).click();
	await dialog.getByRole('button', { name: 'Remove Read', exact: true }).click();
	await dialog.getByLabel('Choose a section').selectOption('unread');
	await dialog.getByRole('button', { name: 'Add section', exact: true }).click();
	await dialog.getByRole('button', { name: 'Save dashboard' }).click();
	await expect.poll(() => server.settings.get(1)?.value.sections.map((item) => item.id))
		.toEqual(['recently_added', 'continue_reading', 'unread']);
	await page.reload();
	await expect.poll(() => sections.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute('data-dashboard-section'))
	)).toEqual(['recently_added', 'continue_reading', 'unread']);

	dialog = await openConfig(page);
	for (const name of ['Recently Added', 'Continue Reading', 'Unread']) {
		await dialog.getByRole('button', { name: `Remove ${name}`, exact: true }).click();
	}
	await expect(dialog.getByText('No sections selected. Saving will leave your dashboard empty.')).toBeVisible();
	await dialog.getByRole('button', { name: 'Save dashboard' }).click();
	await expect(page.getByRole('heading', { name: 'Your dashboard has no sections.' })).toBeVisible();
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Your dashboard has no sections.' })).toBeVisible();
	await expect(sections).toHaveCount(0);
	await expect(page.getByRole('main').getByRole('button', { name: 'Create shelf', exact: true })).toHaveCount(0);
	await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'New shelf' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Configure dashboard' })).toBeEnabled();
	expect(server.settings.get(1)?.value).toEqual({ version: 1, sections: [] });
});

test('invalid layouts require explicit recovery and rejected saves remain visible', async ({ page }) => {
	const server = state();
	seed(server, 1, { version: 2, sections: [{ id: 'read' }] });
	await mockApi(page, server);
	await page.goto('/');
	await expect(page.getByText(/invalid or use an unsupported version/)).toBeVisible();
	expect(server.settings.get(1)?.value.version).toBe(2);
	await page.getByRole('button', { name: 'Reset dashboard to defaults' }).click();
	await expect.poll(() => server.settings.get(1)?.value.version).toBe(1);
	await expect(page.locator('[data-dashboard-section]')).toHaveCount(3);

	const dialog = await openConfig(page);
	await dialog.getByRole('button', { name: 'Remove Read', exact: true }).click();
	server.nextPush = 'stale';
	await dialog.getByRole('button', { name: 'Save dashboard' }).click();
	await expect(dialog.getByRole('alert')).toContainText('rejected or conflicted');
	await expect(dialog).toBeVisible();
	expect(server.settings.get(1)?.value.sections).toHaveLength(3);
});

test('adds shelves created in the sidebar and removes unavailable shelves', async ({ page }) => {
	const server = state();
	server.shelves.set(9, shelf(9, 'Hidden private name'));
	server.hidden.add(9);
	await mockApi(page, server);
	await page.goto('/');
	const createButton = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'New shelf' });
	await createButton.click();
	const creator = page.getByRole('dialog', { name: 'Create shelf' });
	await expect(creator).toBeVisible();
	expect(await creator.evaluate((node) => node.contains(document.activeElement))).toBe(true);
	await page.keyboard.press('Escape');
	await expect(creator).toBeHidden();
	await expect(createButton).toBeFocused();
	await createButton.click();
	await creator.getByLabel('Shelf name').fill('Newly created');
	await creator.getByRole('button', { name: 'Create shelf', exact: true }).click();
	await expect(creator).toBeHidden();

	const dialog = await openConfig(page);
	await expect(dialog.getByRole('button', { name: 'Create shelf', exact: true })).toHaveCount(0);
	const select = dialog.getByLabel('Choose an existing shelf');
	await expect(select.locator('option')).toContainText(['Select an option', 'Favorites', 'Automatic picks']);
	await expect(select).not.toContainText('Hidden private name');
	await select.selectOption('8');
	await dialog.getByRole('button', { name: 'Add shelf section' }).click();
	await expect(dialog.locator('[data-config-section="shelf:8"]')).toContainText('Automatic picks');

	await expect(select.locator('option', { hasText: 'Newly created' })).toHaveCount(1);
	await select.selectOption('7');
	await dialog.getByRole('button', { name: 'Add shelf section' }).click();
	await expect(dialog.locator('[data-config-section="shelf:7"]')).toContainText('Favorites');
	await expect(dialog.locator('[data-config-section="shelf:20"]')).toHaveCount(0);
	await select.selectOption('20');
	await dialog.getByRole('button', { name: 'Add shelf section' }).click();
	await dialog.getByRole('button', { name: 'Save dashboard' }).click();
	await expect.poll(() => server.settings.get(1)?.value.sections.map((item) => item.id))
		.toContain('shelf:20');

	const panel = page.locator('[data-dashboard-section="shelf:20"]');
	await panel.scrollIntoViewIfNeeded();
	await expect(panel.getByRole('heading', { name: 'Newly created' })).toBeVisible();
	server.shelves.delete(20);
	await page.evaluate(() => window.dispatchEvent(new Event('pandalibrary-shelves-changed')));
	await expect(panel.getByRole('heading', { name: 'Unavailable shelf' })).toBeVisible();
	await expect(panel).not.toContainText('Newly created');
	await panel.getByRole('button', { name: 'Remove unavailable section' }).click();
	await expect(panel).toHaveCount(0);
	await expect.poll(() => server.settings.get(1)?.value.sections.map((item) => item.id))
		.not.toContain('shelf:20');
});

test('pages shelf choices including a shelf created in the sidebar', async ({ page }) => {
	const server = state();
	server.paginateShelves = true;
	server.shelves.set(25, shelf(25, 'Later shelf'));
	await mockApi(page, server);
	await page.goto('/');
	await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'New shelf' }).click();
	const creator = page.getByRole('dialog', { name: 'Create shelf' });
	await creator.getByLabel('Shelf name').fill('Created outside first page');
	await creator.getByRole('button', { name: 'Create shelf', exact: true }).click();
	await expect(creator).toBeHidden();
	const dialog = await openConfig(page);
	const select = dialog.getByLabel('Choose an existing shelf');
	await expect(select.locator('option', { hasText: 'Created outside first page' })).toHaveCount(0);
	await expect(select).toHaveValue('');
	await dialog.getByRole('button', { name: 'Load more shelves' }).click();
	await expect(select.locator('option', { hasText: 'Created outside first page' })).toHaveCount(1);
	await expect(select.locator('option', { hasText: 'Later shelf' })).toHaveCount(1);
	expect(server.shelfRequests).toContain('shelves/+cursor=');
	await select.selectOption('25');
	await dialog.getByRole('button', { name: 'Add shelf section' }).click();
	await expect(dialog.locator('[data-config-section="shelf:25"]')).toContainText('Later shelf');
	await expect(dialog.locator('[data-config-section="shelf:20"]')).toHaveCount(0);
});

test('does not disclose metadata for an inaccessible saved shelf', async ({ page }) => {
	const server = state();
	server.shelves.set(9, shelf(9, 'Hidden private name'));
	server.hidden.add(9);
	seed(server, 1, { version: 1, sections: [{ id: 'shelf:9' }] });
	await mockApi(page, server);
	await page.goto('/');
	const panel = page.locator('[data-dashboard-section="shelf:9"]');
	await expect(panel.getByRole('heading', { name: 'Unavailable shelf' })).toBeVisible();
	await expect(panel).not.toContainText('Hidden private name');
	await panel.getByRole('button', { name: 'Remove unavailable section' }).click();
	await expect(page.getByRole('heading', { name: 'Your dashboard has no sections.' })).toBeVisible();
});

test('discards a late shelf response after a refresh', async ({ page }) => {
	const server = state();
	seed(server, 1, { version: 1, sections: [{ id: 'shelf:8' }] });
	await mockApi(page, server);
	let firstStarted!: () => void;
	let releaseFirst!: () => void;
	let firstFinished!: () => void;
	const started = new Promise<void>((resolve) => { firstStarted = resolve; });
	const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const finished = new Promise<void>((resolve) => { firstFinished = resolve; });
	let requests = 0;
	await page.route((url) => url.pathname === '/api/v1/shelves/8', async (route) => {
		requests += 1;
		if (requests === 1) {
			firstStarted();
			await release;
			await route.fulfill({ json: { shelf: shelf(8, 'Stale shelf') } });
			firstFinished();
		} else {
			await route.fulfill({ json: { shelf: shelf(8, 'Fresh shelf') } });
		}
	});
	await page.goto('/');
	await started;
	await page.evaluate(() => window.dispatchEvent(new Event('pandalibrary-shelves-changed')));
	const panel = page.locator('[data-dashboard-section="shelf:8"]');
	await expect(panel.getByRole('heading', { name: 'Fresh shelf' })).toBeVisible();
	releaseFirst();
	await finished;
	await expect(panel.getByRole('heading', { name: 'Fresh shelf' })).toBeVisible();
	await expect(panel).not.toContainText('Stale shelf');
});

test('discards a shelf selection response from a closed configuration dialog', async ({ page }) => {
	const server = state();
	await mockApi(page, server);
	let firstStarted!: () => void;
	let releaseFirst!: () => void;
	let firstFinished!: () => void;
	const started = new Promise<void>((resolve) => { firstStarted = resolve; });
	const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const finished = new Promise<void>((resolve) => { firstFinished = resolve; });
	await page.route((url) => url.pathname === '/api/v1/shelves/8', async (route) => {
		firstStarted();
		await release;
		await route.fulfill({ json: { shelf: shelf(8, 'Automatic picks', 'automatic') } });
		firstFinished();
	});
	await page.goto('/');
	let dialog = await openConfig(page);
	await dialog.getByLabel('Choose an existing shelf').selectOption('8');
	await dialog.getByRole('button', { name: 'Add shelf section' }).click();
	await started;
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	dialog = await openConfig(page);
	await dialog.getByLabel('Choose an existing shelf').selectOption('7');
	await dialog.getByRole('button', { name: 'Add shelf section' }).click();
	await expect(dialog.locator('[data-config-section="shelf:7"]')).toBeVisible();
	releaseFirst();
	await finished;
	await expect(dialog.locator('[data-config-section="shelf:8"]')).toHaveCount(0);
});

test('keeps feeds independent, pages with opaque cursors, and resumes the exact saved file', async ({ page }) => {
	const server = state();
	server.feedFailure.add('recently_added');
	server.moreFailure.add('continue_reading');
	await mockApi(page, server);
	await page.goto('/');
	const continuing = page.locator('[data-dashboard-section="continue_reading"]');
	const recent = page.locator('[data-dashboard-section="recently_added"]');
	const read = page.locator('[data-dashboard-section="read"]');
	await expect(continuing.getByTitle('First Book', { exact: true })).toBeVisible();
	await expect(recent.getByRole('alert')).toContainText('Could not load books');
	await expect(read.getByText('No books in this section yet.')).toBeVisible();
	await continuing.getByRole('button', { name: 'Load more books' }).click();
	await expect(continuing.getByRole('alert')).toContainText('Could not load more books');
	await expect(continuing.getByTitle('First Book', { exact: true })).toBeVisible();
	server.moreFailure.clear();
	await continuing.getByRole('button', { name: 'Load more books' }).click();
	await expect(continuing.getByTitle('Second Book', { exact: true })).toBeVisible();
	await expect(continuing.getByTitle('First Book', { exact: true })).toHaveCount(1);
	expect(server.feedRequests.filter((item) => item.cursor).map((item) => item.cursor))
		.toEqual(['opaque/+cursor=', 'opaque/+cursor=']);
	server.feedFailure.clear();
	await recent.getByRole('button', { name: 'Retry' }).click();
	await expect(recent.getByText('No books in this section yet.')).toBeVisible();

	await expect(continuing.getByRole('button', { name: 'Resume reading' })).toHaveCount(0);
	const first = continuing.locator('li').filter({ has: page.getByTitle('First Book', { exact: true }) });
	await first.locator('div.cover-frame').hover();
	await first.getByRole('button', { name: 'Read First Book' }).click();
	await expect(page).toHaveURL('/read/21/12');
});

test('opens the first readable format when the saved file is missing', async ({ page }) => {
	const server = state();
	server.progressFile = null;
	await mockApi(page, server);
	await page.goto('/');
	const continuing = page.locator('[data-dashboard-section="continue_reading"]');
	const first = continuing.locator('li').filter({ has: page.getByTitle('First Book', { exact: true }) });
	await first.locator('div.cover-frame').hover();
	await first.getByRole('button', { name: 'Read First Book' }).click();
	await expect(page).toHaveURL('/read/21/11');
});

test('renders cover-only tiles at the standard width without clipping the lift', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const server = state();
	await mockApi(page, server);
	await page.goto('/');
	const continuing = page.locator('[data-dashboard-section="continue_reading"]');
	const scroller = continuing.getByRole('region');
	const tile = continuing.locator('li').filter({ has: page.getByTitle('First Book', { exact: true }) });
	await expect(tile).toBeVisible();
	const standard = await page.evaluate(() => {
		const probe = document.createElement('div');
		probe.style.width = 'var(--spacing-book)';
		document.body.append(probe);
		const width = probe.getBoundingClientRect().width;
		probe.remove();
		return width;
	});
	expect(standard).toBeGreaterThan(0);
	expect((await tile.boundingBox())?.width).toBeCloseTo(standard, 0);
	await expect(tile.getByRole('button', { name: /^Resume/ })).toHaveCount(0);
	await expect(tile.getByRole('alert')).toHaveCount(0);

	const frame = tile.locator('div.cover-frame');
	await frame.hover();
	await expect.poll(() => frame.evaluate((node) => getComputedStyle(node).transform))
		.toBe('matrix(1, 0, 0, 1, 0, -4)');
	const frameBox = await frame.boundingBox();
	const scrollerBox = await scroller.boundingBox();
	expect(frameBox && scrollerBox && frameBox.y >= scrollerBox.y).toBe(true);
	expect(frameBox && scrollerBox && frameBox.y + frameBox.height <= scrollerBox.y + scrollerBox.height).toBe(true);
});

test('opens a cover status menu beyond the dashboard scroller', async ({ page }) => {
	const server = state();
	await mockApi(page, server);
	await page.goto('/');
	const continuing = page.locator('[data-dashboard-section="continue_reading"]');
	const scroller = continuing.getByRole('region');
	const badge = continuing.getByRole('button', { name: 'Reading status: Reading. Change' });
	await badge.click();
	const menu = continuing.getByRole('menu', { name: 'Reading status' });
	const menuBox = await menu.boundingBox();
	const scrollerBox = await scroller.boundingBox();
	expect(menuBox && scrollerBox && (
		menuBox.y < scrollerBox.y || menuBox.y + menuBox.height > scrollerBox.y + scrollerBox.height
	)).toBe(true);
	await menu.getByRole('menuitemradio', { name: 'On hold' }).click();
	await expect(page).toHaveURL('/');
});

test('isolates accounts and synchronizes a dashboard saved while offline', async ({ page, context }) => {
	const server = state();
	seed(server, 1, { version: 1, sections: [{ id: 'read' }] });
	seed(server, 2, { version: 1, sections: [{ id: 'unread' }] });
	await mockApi(page, server);
	await page.goto('/');
	await expect(page.locator('[data-dashboard-section="read"]')).toBeVisible();
	server.account = 2;
	await page.reload();
	await expect(page.locator('[data-dashboard-section="unread"]')).toBeVisible();
	await expect(page.locator('[data-dashboard-section="read"]')).toHaveCount(0);

	await context.setOffline(true);
	const dialog = await openConfig(page);
	await dialog.getByRole('button', { name: 'Remove Unread' }).click();
	await dialog.getByRole('button', { name: 'Save dashboard' }).click();
	await expect(page.getByText('Dashboard saved on this device and waiting to sync.')).toBeVisible();
	expect(server.settings.get(2)?.value.sections).toEqual([{ id: 'unread' }]);
	const queued = await page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('pandalibrary-offline');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const entries = await new Promise<Array<{ account: number; mutation: { key?: string } }>>((resolve, reject) => {
			const request = database.transaction('outbox').objectStore('outbox').getAll();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		database.close();
		return entries.filter((entry) => entry.account === 2 && entry.mutation.key === 'dashboard.layout.v1').length;
	});
	expect(queued).toBe(1);
	await context.setOffline(false);
	await expect.poll(() => server.settings.get(2)?.value.sections).toEqual([]);
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Your dashboard has no sections.' })).toBeVisible();
	expect(server.settings.get(1)?.value.sections).toEqual([{ id: 'read' }]);
});

test('reports an offline layout rejected after reconnection', async ({ page, context }) => {
	const server = state();
	seed(server, 1, { version: 1, sections: [{ id: 'read' }] });
	await mockApi(page, server);
	await page.goto('/');
	await expect(page.locator('[data-dashboard-section="read"]')).toBeVisible();
	await context.setOffline(true);
	const dialog = await openConfig(page);
	await dialog.getByRole('button', { name: 'Remove Read', exact: true }).click();
	await dialog.getByRole('button', { name: 'Save dashboard' }).click();
	await expect(page.getByRole('heading', { name: 'Your dashboard has no sections.' })).toBeVisible();
	server.nextPush = 'rejected';
	await context.setOffline(false);
	await expect(page.getByText(/A dashboard change was rejected or conflicted/)).toBeVisible();
	await expect(page.getByRole('link', { name: 'Review offline changes' })).toHaveAttribute('href', '/settings');
	await expect(page.locator('[data-dashboard-section="read"]')).toBeVisible();
});

test('localizes controls and fits a narrow viewport', async ({ page }) => {
	const server = state();
	server.locale = 'zh';
	await mockApi(page, server);
	await page.setViewportSize({ width: 360, height: 740 });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: '仪表盘', level: 1 })).toHaveClass('sr-only');
	await page.getByRole('button', { name: '配置仪表盘' }).click();
	await expect(page.getByRole('dialog', { name: '配置仪表盘' })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth))
		.toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
});
