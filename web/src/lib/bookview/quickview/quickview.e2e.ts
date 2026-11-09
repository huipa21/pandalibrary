import { expect, test, type Page, type Route } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const timestamp = '2026-11-04T00:00:00Z';
const description = Array.from({ length: 30 }, (_, index) =>
	`Paragraph ${index + 1} of a long synopsis about a quiet harbor town and its keepers.`).join('\n');
const file = (id: number, format: string, bookId: number, name: string) => ({
	id, format, size_bytes: 2_516_582,
	download_url: `/api/v1/books/${bookId}/files/${id}?v=${'a'.repeat(64)}`,
	original_filename: name, created_at: timestamp
});
const harbor = {
	id: 2, library_id: 1, title: 'Quiet Harbor', sort_title: 'Quiet Harbor', subtitle: null, description,
	language: 'en', publisher: 'Lighthouse Press', published_date: '2019-04-02', page_count: 320,
	cover_url: null, cover_source: null,
	authors: [{ id: 4, name: 'Mara Quill', role: 'author', position: 0 }],
	series: { id: 6, name: 'Coastline', index: 2 },
	tags: [{ id: 11, name: 'Mystery' }, { id: 12, name: 'Sea' }],
	identifiers: [{ scheme: 'isbn', value: '9780000000002' }],
	files: [file(201, 'epub', 2, 'quiet-harbor.epub'), file(202, 'pdf', 2, 'quiet-harbor.pdf')],
	field_sources: [], created_at: timestamp, updated_at: timestamp
};
const plain = {
	...harbor, id: 3, title: 'Second Story', sort_title: 'Second Story', description: null, series: null,
	tags: [], identifiers: [], language: null, publisher: null, published_date: null, page_count: null,
	files: [file(301, 'pdf', 3, 'second.pdf')]
};
const books = [harbor, plain];

const shelf = (id: number, name: string, systemKey: string | null = null) => ({
	id, kind: 'private', owner_id: 1, name, description: null, created_by: 1, visible_book_count: 1,
	created_at: timestamp, updated_at: timestamp, mode: 'manual', system_key: systemKey
});

interface MockState {
	userBooks: Map<number, Record<string, unknown>>;
	members: Map<number, number[]>;
	pushes: Array<{ entity: string; key?: string; data: Record<string, unknown> }>;
	shelfPuts: string[];
}

function mockState(): MockState {
	return {
		userBooks: new Map(),
		members: new Map([[2, [9, 7]], [3, []]]),
		pushes: [],
		shelfPuts: []
	};
}

const allShelves = [shelf(7, 'Weekend reads'), shelf(14, 'Classics'), shelf(9, 'Favorites', 'favorites')];

function problem(route: Route, status: number) {
	return route.fulfill({
		status, contentType: 'application/problem+json',
		body: JSON.stringify({ status, title: 'Request failed' })
	});
}

function iso(value: unknown): string | null {
	return typeof value === 'number' ? new Date(value).toISOString() : null;
}

async function mockApi(page: Page, state: MockState) {
	await page.route((url) => url.pathname.startsWith('/api/v1/'), async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: {
			id: 1, username: 'reader', display_name: '', role: 'user', locale: 'en'
		} } });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: Number(url.searchParams.get('cursor') ?? 0),
			user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: []
		} });
		if (path === '/sync/push') {
			const body = request.postDataJSON() as { mutations: MockState['pushes'] };
			for (const mutation of body.mutations) {
				if (mutation.entity !== 'user_books') continue;
				state.pushes.push(mutation);
				const data = mutation.data;
				state.userBooks.set(Number(data.book_id), {
					status: data.status, rating: data.rating, started_at: iso(data.started_at),
					finished_at: iso(data.finished_at), updated_at: new Date().toISOString(), rev: state.pushes.length
				});
			}
			return route.fulfill({ json: { results: body.mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/shelves') return route.fulfill({ json: { items: allShelves.filter((item) => !item.system_key), next_cursor: null } });
		const system = /^\/shelves\/system\/(\w+)$/.exec(path);
		if (system) {
			return system[1] === 'favorites'
				? route.fulfill({ json: { shelf: allShelves[2] } })
				: route.fulfill({ json: { shelf: { ...shelf(8, 'Unshelved', 'unshelved'), mode: 'system' } } });
		}
		const membership = /^\/shelves\/(\d+)\/books\/(\d+)$/.exec(path);
		if (membership && request.method() === 'PUT') {
			state.shelfPuts.push(path);
			const bookId = Number(membership[2]);
			state.members.set(bookId, [...(state.members.get(bookId) ?? []), Number(membership[1])]);
			return route.fulfill({ json: { saved: true } });
		}
		if (['/authors', '/series', '/tags', '/libraries'].includes(path)) {
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		if (path === '/books') return route.fulfill({ json: { items: books, next_cursor: null } });
		if (path === '/me/book-states') {
			const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number);
			return route.fulfill({ json: { items: ids.flatMap((id) => {
				const userBook = state.userBooks.get(id);
				if (!userBook && id !== 2) return [];
				return [{
					book_id: id, status: userBook?.status ?? 'unread', percentage: id === 2 ? 0.42 : null,
					book_file_id: id === 2 ? 201 : null, updated_at: timestamp
				}];
			}) } });
		}
		const shelvesOf = /^\/books\/(\d+)\/shelves$/.exec(path);
		if (shelvesOf) {
			const ids = state.members.get(Number(shelvesOf[1]));
			if (!ids) return problem(route, 404);
			const found = allShelves.filter((item) => ids.includes(item.id))
				.sort((left, right) => left.name.localeCompare(right.name));
			return route.fulfill({ json: { shelves: found } });
		}
		const details = /^\/books\/(\d+)$/.exec(path);
		if (details) {
			const found = books.find((item) => item.id === Number(details[1]));
			return found ? route.fulfill({ json: { book: found } }) : problem(route, 404);
		}
		const bookState = /^\/me\/books\/(\d+)$/.exec(path);
		if (bookState) {
			const id = Number(bookState[1]);
			if (!books.some((item) => item.id === id)) return problem(route, 404);
			return route.fulfill({ json: {
				user_book: state.userBooks.get(id) ?? null, highlights: [], bookmarks: [], notes: [],
				progress: id === 2 ? {
					book_file_id: 201, source: 'web', locator: null, percentage: 0.42,
					device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
				} : null
			} });
		}
		return problem(route, 404);
	});
}

function card(page: Page, title: string) {
	return page.locator('li').filter({ has: page.getByTitle(title, { exact: true }) }).first();
}

async function openHarbor(page: Page) {
	await page.goto('/books');
	const info = card(page, 'Quiet Harbor').getByRole('button', { name: 'Quick view: Quiet Harbor' });
	await card(page, 'Quiet Harbor').locator('div.cover-frame').hover();
	await info.click();
	const drawer = page.getByRole('dialog', { name: 'Quiet Harbor' });
	await expect(drawer).toBeVisible();
	return { info, drawer };
}

test('shows the quick view structure and expands the synopsis', async ({ page }) => {
	const state = mockState();
	await mockApi(page, state);
	await page.setViewportSize({ width: 1280, height: 900 });
	const { drawer } = await openHarbor(page);

	await expect(drawer).toHaveAttribute('aria-modal', 'true');
	await expect(drawer.getByRole('button', { name: 'Close quick view' })).toBeFocused();
	await expect(drawer.getByRole('link', { name: 'Quiet Harbor' })).toHaveAttribute('href', '/books/2');
	await expect(drawer.getByRole('link', { name: 'Mara Quill' })).toHaveAttribute('href', '/authors/4');
	await expect(drawer.getByRole('link', { name: /Open Library/ }).first()).toHaveAttribute('target', '_blank');

	const facts = drawer.getByRole('list', { name: 'Book facts' });
	await expect(facts).toContainText('EPUB');
	await expect(facts).toContainText('PDF');
	await expect(facts).toContainText('320 pages');
	await expect(facts).toContainText('Apr 2, 2019');
	await expect(facts).toContainText('ENGLISH');
	await expect(drawer).toContainText('Lighthouse Press');
	await expect(drawer.getByRole('link', { name: 'Coastline #2' })).toHaveAttribute('href', '/series/6');

	const primary = drawer.getByRole('region', { name: 'Primary file' });
	await expect(primary).toContainText('quiet-harbor.epub');
	await expect(primary).toContainText('2.4 MB');
	await expect(primary).toContainText('42% read');

	const tags = drawer.getByRole('region', { name: 'Tags' });
	await expect(tags.getByRole('link', { name: 'Mystery' })).toHaveAttribute('href', '/tags/11');
	const collections = drawer.getByRole('region', { name: 'Collections' }).getByRole('link');
	await expect(collections).toHaveText(['Favorites', 'Weekend reads']);
	await expect(collections.first()).toHaveAttribute('href', '/shelves/system/favorites');
	await expect(collections.nth(1)).toHaveAttribute('href', '/shelves/7');

	const synopsis = drawer.getByRole('region', { name: 'Synopsis' });
	const text = synopsis.locator('p').first();
	const collapsed = await text.evaluate((node) => node.clientHeight);
	await synopsis.getByRole('button', { name: 'Show more' }).click();
	await expect(synopsis.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
	expect(await text.evaluate((node) => node.clientHeight)).toBeGreaterThan(collapsed);

	await expect(drawer.getByRole('button', { name: 'Resume' })).toBeEnabled();
	await expect(drawer.getByRole('link', { name: 'Details' })).toBeVisible();
	await expect(drawer.getByRole('button', { name: 'Reading status' })).toBeVisible();
	await expect(drawer.getByRole('button', { name: 'Add to shelf' })).toBeVisible();
	expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
});

test('closes on Escape and backdrop, restores focus, and traps Tab', async ({ page }) => {
	await mockApi(page, mockState());
	await page.setViewportSize({ width: 1280, height: 900 });
	const { info, drawer } = await openHarbor(page);

	for (let index = 0; index < 25; index += 1) {
		await page.keyboard.press(index % 3 === 0 ? 'Shift+Tab' : 'Tab');
		expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true);
	}
	await page.keyboard.press('Escape');
	await expect(drawer).toHaveCount(0);
	await expect(info).toBeFocused();
	expect(await page.evaluate(() => document.body.style.overflow)).toBe('');

	await info.click();
	await expect(drawer).toBeVisible();
	await page.mouse.click(40, 450);
	await expect(drawer).toHaveCount(0);
	await expect(info).toBeFocused();
});

test('Details navigates and closes; Read opens the reader', async ({ page }) => {
	await mockApi(page, mockState());
	await page.setViewportSize({ width: 1280, height: 900 });
	let { drawer } = await openHarbor(page);
	await drawer.getByRole('link', { name: 'Details' }).click();
	await expect(page).toHaveURL(/\/books\/2$/);
	await expect(page.getByRole('dialog')).toHaveCount(0);

	({ drawer } = await openHarbor(page));
	await drawer.getByRole('button', { name: 'Resume' }).click();
	await expect(page).toHaveURL(/\/read\/2\/201$/);
});

test('changes the reading status with one mutation and adds the book to a shelf', async ({ page }) => {
	const state = mockState();
	await mockApi(page, state);
	await page.setViewportSize({ width: 1280, height: 900 });
	const { drawer } = await openHarbor(page);

	const status = drawer.getByRole('button', { name: 'Reading status' });
	await expect(status).toHaveAttribute('title', 'Reading status: Unread');
	await status.click();
	const menu = page.getByRole('menu', { name: 'Reading status' });
	const menuBox = await menu.boundingBox();
	expect(menuBox?.x ?? -1).toBeGreaterThanOrEqual(0);
	expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(1280);
	expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(900);
	await menu.getByRole('menuitemradio', { name: 'Want to read' }).click();
	await expect(status).toHaveAttribute('title', 'Reading status: Want to read');
	await expect.poll(() => state.pushes.length).toBe(1);
	expect(state.pushes[0]).toMatchObject({ entity: 'user_books', key: '2', data: { book_id: 2, status: 'want_to_read' } });
	await expect(status).toHaveAttribute('title', 'Reading status: Want to read');

	await drawer.getByRole('button', { name: 'Add to shelf' }).click();
	const popover = drawer.getByRole('dialog', { name: 'Add to shelf' });
	await expect(popover.getByRole('button', { name: /Weekend reads/ })).toHaveAttribute('aria-disabled', 'true');
	await popover.getByRole('button', { name: /Classics/ }).click();
	await expect.poll(() => state.shelfPuts).toEqual(['/shelves/14/books/2']);
	await expect(drawer.getByRole('region', { name: 'Collections' }).getByRole('link'))
		.toHaveText(['Favorites', 'Classics', 'Weekend reads']);
	await expect(drawer.getByRole('button', { name: 'Add to shelf' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(card(page, 'Quiet Harbor').getByRole('button',
		{ name: 'Reading status: Want to read. Change' })).toBeVisible();
});

test('the empty shelf picker points to the shelf menu and management page', async ({ page }) => {
	await mockApi(page, mockState());
	await page.route((url) => url.pathname === '/api/v1/shelves', (route) =>
		route.fulfill({ json: { items: [], next_cursor: null } })
	);
	await page.setViewportSize({ width: 1280, height: 900 });
	const { drawer } = await openHarbor(page);
	await drawer.getByRole('button', { name: 'Add to shelf' }).click();
	const popover = drawer.getByRole('dialog', { name: 'Add to shelf' });
	await expect(popover).toContainText('Create one from the shelves menu in the sidebar.');
	const manage = popover.getByRole('link', { name: 'Manage shelves' });
	await expect(manage).toHaveAttribute('href', '/shelves');
	await manage.click();
	await expect(page).toHaveURL('/shelves');
	await expect(page.getByRole('main')).toContainText('choose New shelf from the shelves menu');
	await expect(page.getByRole('button', { name: 'Shelf actions' })).toBeVisible();
});

test('shows not found and replaces the book without stale responses', async ({ page }) => {
	await mockApi(page, mockState());
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/books');
	await expect(card(page, 'Quiet Harbor')).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-quick-view', {
		detail: { bookId: 404, trigger: null }
	})));
	const missing = page.getByRole('dialog', { name: 'Book unavailable' });
	await expect(missing).toContainText('This book is unavailable or you do not have access.');
	await page.keyboard.press('Escape');
	await expect(missing).toHaveCount(0);

	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => { release = resolve; });
	await page.route('**/api/v1/books/2', async (route) => {
		await held;
		await route.fallback();
	});
	await page.evaluate(() => {
		const open = (bookId: number) => window.dispatchEvent(new CustomEvent('pandalibrary-quick-view', {
			detail: { bookId, trigger: null }
		}));
		open(2);
		open(3);
	});
	await expect(page.getByRole('dialog', { name: 'Second Story' })).toBeVisible();
	release();
	await page.waitForTimeout(300);
	await expect(page.getByRole('dialog', { name: 'Second Story' })).toBeVisible();
	await expect(page.getByRole('dialog', { name: 'Quiet Harbor' })).toHaveCount(0);
});

test('is full width on a 390px viewport without horizontal scroll', async ({ page }) => {
	await mockApi(page, mockState());
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/books');
	const info = card(page, 'Quiet Harbor').getByRole('button', { name: 'Quick view: Quiet Harbor' });
	await info.click();
	const drawer = page.getByRole('dialog', { name: 'Quiet Harbor' });
	await expect(drawer).toBeVisible();
	await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
	expect((await drawer.boundingBox())?.width).toBe(390);
	const widths = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		content: document.documentElement.scrollWidth,
		drawer: document.querySelector('[role="dialog"]')?.scrollWidth ?? 0
	}));
	expect(widths.content).toBeLessThanOrEqual(widths.viewport);
	expect(widths.drawer).toBeLessThanOrEqual(390);
});

test('skips the slide animation with reduced motion', async ({ page }) => {
	await mockApi(page, mockState());
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1280, height: 900 });
	const { drawer } = await openHarbor(page);
	expect(await drawer.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
});
