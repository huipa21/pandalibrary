import { expect, test, type APIRequestContext, type Locator, type Page, type Request, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { coverCloth } from '../lib/bookview/cover.js';
import { epubFixture, pdfFixture, pngFixture } from '../lib/reader/fixtures.js';
import { signInRealAdmin } from '../lib/real-auth.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');
test.describe.configure({ mode: 'serial' });

const statuses = [
	{ value: 'unread', label: 'Unread' },
	{ value: 'want_to_read', label: 'Want to read' },
	{ value: 'reading', label: 'Reading' },
	{ value: 'on_hold', label: 'On hold' },
	{ value: 'rereading', label: 'Re-reading' },
	{ value: 'finished', label: 'Read' },
	{ value: 'skimmed', label: 'Skimmed' },
	{ value: 'abandoned', label: 'Abandoned' }
] as const;

interface SeedBook {
	id: number;
	title: string;
	epubID: number;
}

interface ImportJob {
	id: number;
	status: string;
	book_id: number | null;
	error: string | null;
}

const seed = {
	libraryID: 0,
	shelfID: 0,
	heapID: 0,
	heapTitle: '',
	authorID: 0,
	pdfID: 0,
	books: [] as SeedBook[],
	jobs: [] as number[],
	previousLayout: undefined as unknown
};

const image = pngFixture(60, 90, [32, 96, 160]);

async function push(api: APIRequestContext, mutations: Array<Record<string, unknown>>) {
	const response = await api.post('/api/v1/sync/push', { data: { mutations } });
	expect(response.ok(), await response.text()).toBe(true);
	const { results } = await response.json() as { results: Array<{ status: string; reason?: string }> };
	expect(results.map((result) => result.reason ?? result.status)).toEqual(mutations.map(() => 'applied'));
}

async function imports(api: APIRequestContext): Promise<ImportJob[]> {
	const response = await api.get('/api/v1/imports?limit=100');
	expect(response.ok(), await response.text()).toBe(true);
	return (await response.json() as { items: ImportJob[] }).items;
}

async function waitForImports(api: APIRequestContext, ids: number[]) {
	let found: ImportJob[] = [];
	await expect.poll(async () => {
		const byID = new Map((await imports(api)).map((job) => [job.id, job]));
		found = ids.flatMap((id) => {
			const job = byID.get(id);
			return job ? [job] : [];
		});
		const failed = found.find((job) => job.status === 'failed' || job.status === 'duplicate');
		if (failed) throw new Error(`Import ${failed.id} ${failed.status}: ${failed.error ?? 'no error detail'}`);
		return found.filter((job) => job.status === 'imported').length;
	}, { timeout: 120_000 }).toBe(ids.length);
	return found;
}

async function upload(
	api: APIRequestContext,
	path: string,
	name: string,
	bytes: Buffer,
	libraryID?: number
) {
	const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
		file: { name, mimeType: 'application/octet-stream', buffer: bytes }
	};
	if (libraryID !== undefined) multipart.library_id = String(libraryID);
	const response = await api.post(path, { multipart });
	expect(response.status(), await response.text()).toBe(202);
	const { job } = await response.json() as { job: { id: number } };
	seed.jobs.push(job.id);
	return job.id;
}

function card(scope: Page | Locator, title: string) {
	const page = 'goto' in scope ? scope : scope.page();
	return scope.locator('li').filter({ has: page.getByTitle(title, { exact: true }) }).first();
}

function book(index: number): SeedBook {
	const result = seed.books[index];
	if (!result) throw new Error(`Missing seeded book ${index}`);
	return result;
}

function allBooksPath() {
	return `/books?author_id=${seed.authorID}`;
}

async function assertTile(tile: Locator, width = 208) {
	await expect(tile).toBeVisible();
	const cover = tile.locator('.book-cover');
	await expect(cover).toBeVisible();
	const box = await cover.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.width).toBeCloseTo(width, 0);
	expect(box!.height / box!.width).toBeCloseTo(1.5, 2);
	await expect(tile.locator(':scope > h3, :scope > p')).toHaveCount(0);
}

async function assertSeparate(first: Locator, second: Locator, message: string) {
	const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
	if (!a || !b) throw new Error(`${message}: an element is not visible`);
	const separated = a.x + a.width <= b.x || b.x + b.width <= a.x ||
		a.y + a.height <= b.y || b.y + b.height <= a.y;
	expect(separated, message).toBe(true);
}

async function attachScreenshot(page: Page, info: TestInfo, name: string) {
	const screenshot = await page.screenshot({ path: info.outputPath(`${name}.png`) });
	await info.attach(name, { body: screenshot, contentType: 'image/png' });
}

test.beforeAll(async ({ browser }) => {
	test.setTimeout(240_000);
	const page = await browser.newPage();
	try {
		await signInRealAdmin(page);
		const suffix = randomUUID().slice(0, 8);
		const library = await page.request.post('/api/v1/admin/libraries', {
			data: { name: `BC8 Covers ${suffix}`, slug: `bc8-covers-${suffix}` }
		});
		expect(library.status(), await library.text()).toBe(201);
		seed.libraryID = (await library.json() as { library: { id: number } }).library.id;

		const settings = await page.request.get('/api/v1/me/settings');
		expect(settings.ok(), await settings.text()).toBe(true);
		const values = await settings.json() as { settings: Array<{ key: string; value: unknown }> };
		seed.previousLayout = values.settings.find((entry) => entry.key === 'dashboard.layout.v1')?.value;

		const titles = Array.from({ length: 50 }, (_, index) =>
			`BC8 ${String(index).padStart(2, '0')} ${statuses[index]?.label ?? 'Cloth'} ${suffix}`);
		for (let index = 0; index < titles.length; index++) {
			const title = titles[index];
			await upload(page.request, '/api/v1/uploads', `${title}.epub`, epubFixture(title, {
				author: `BC8 Writer ${suffix}`,
				...(index === 1 ? { cover: image } : {})
			}), seed.libraryID);
		}
		const jobs = await waitForImports(page.request, seed.jobs);
		for (let index = 0; index < jobs.length; index++) {
			const id = jobs[index].book_id;
			if (id === null) throw new Error(`Imported job ${jobs[index].id} has no book`);
			const response = await page.request.get(`/api/v1/books/${id}`);
			expect(response.ok(), await response.text()).toBe(true);
			const { book: item } = await response.json() as {
				book: { title: string; authors: Array<{ id: number }>; files: Array<{ id: number; format: string }> }
			};
			const epub = item.files.find((file) => file.format === 'epub');
			if (!epub || !item.authors[0]) throw new Error(`Missing EPUB or author for ${item.title}`);
			seed.authorID = item.authors[0].id;
			seed.books.push({ id, title: item.title, epubID: epub.id });
		}
		expect(seed.books.map((item) => item.title)).toEqual(titles);

		const pdfJob = await upload(
			page.request, `/api/v1/books/${book(2).id}/files`, `BC8 saved ${suffix}.pdf`,
			Buffer.concat([pdfFixture(), Buffer.from(`%${randomUUID()}\n`)])
		);
		await waitForImports(page.request, [pdfJob]);
		const multi = await page.request.get(`/api/v1/books/${book(2).id}`);
		expect(multi.ok(), await multi.text()).toBe(true);
		const { book: multiBook } = await multi.json() as { book: { files: Array<{ id: number; format: string }> } };
		const pdf = multiBook.files.find((file) => file.format === 'pdf');
		if (!pdf) throw new Error('The saved PDF was not attached');
		seed.pdfID = pdf.id;

		const shelf = await page.request.post('/api/v1/shelves', {
			data: { kind: 'private', mode: 'manual', name: `BC8 Shelf ${suffix}` }
		});
		expect(shelf.status(), await shelf.text()).toBe(201);
		seed.shelfID = (await shelf.json() as { shelf: { id: number } }).shelf.id;
		const favorites = await page.request.get('/api/v1/shelves/system/favorites');
		expect(favorites.ok(), await favorites.text()).toBe(true);
		const favoriteID = (await favorites.json() as { shelf: { shelf_id: number } }).shelf.shelf_id;
		for (const item of seed.books.slice(0, statuses.length)) {
			for (const shelfID of [seed.shelfID, favoriteID]) {
				const response = await page.request.put(`/api/v1/shelves/${shelfID}/books/${item.id}`, { data: {} });
				expect(response.ok(), await response.text()).toBe(true);
			}
		}

		const heapTitle = `BC8 Heap ${suffix}`;
		const heap = await page.request.post('/api/v1/admin/bookheap/files', { multipart: {
			file: {
				name: `${heapTitle}.epub`, mimeType: 'application/epub+zip',
				buffer: epubFixture(heapTitle, { author: `BC8 Writer ${suffix}` })
			}
		} });
		expect(heap.status(), await heap.text()).toBe(201);
		const heapItem = (await heap.json() as { item: { id: number; title: string } }).item;
		seed.heapID = heapItem.id;
		seed.heapTitle = heapItem.title;

		const now = Date.now() - 10_000;
		const mutations: Array<Record<string, unknown>> = statuses.map(({ value }, index) => ({
			entity: 'user_books', id: String(book(index).id), op: 'upsert', updated_at: now,
			data: { book_id: book(index).id, status: value, rating: 7 }
		}));
		for (const [index, percentage, fileID] of [
			[0, 0, book(0).epubID], [2, 0.42, seed.pdfID], [5, 1, book(5).epubID]
		] as const) {
			mutations.push({
				entity: 'reading_progress', id: String(book(index).id), op: 'upsert', updated_at: now,
				data: {
					book_id: book(index).id, book_file_id: fileID, source: 'web',
					locator: index === 2 ? { type: 'pdf', page: 1 } : null,
					percentage, device: 'BC8 browser', device_id: 'bc8-real'
				}
			});
		}
		mutations.push({
			entity: 'user_settings', key: 'dashboard.layout.v1', op: 'upsert', updated_at: Date.now(),
			data: { value: { version: 1, sections: [
				{ id: 'continue_reading' }, { id: 'recently_added' }, { id: 'read' }
			] } }
		});
		await push(page.request, mutations);
	} finally {
		await page.close();
	}
});

test.afterAll(async ({ browser }) => {
	test.setTimeout(180_000);
	if (!seed.libraryID && !seed.heapID) return;
	const page = await browser.newPage();
	try {
		await signInRealAdmin(page);
		if (seed.jobs.length) {
			await expect.poll(async () => {
				const pending = (await imports(page.request)).filter((job) =>
					seed.jobs.includes(job.id) && (job.status === 'pending' || job.status === 'processing'));
				return pending.length;
			}, { timeout: 120_000 }).toBe(0);
		}
		if (seed.heapID) {
			const response = await page.request.post('/api/v1/admin/bookheap/items/delete', { data: { ids: [seed.heapID] } });
			expect(response.ok(), await response.text()).toBe(true);
			const { results } = await response.json() as { results: Array<{ ok: boolean }> };
			expect(results).toHaveLength(1);
			expect(results[0].ok).toBe(true);
		}
		if (seed.shelfID) {
			const response = await page.request.delete(`/api/v1/shelves/${seed.shelfID}`);
			expect(response.ok(), await response.text()).toBe(true);
		}
		if (seed.libraryID) {
			const response = await page.request.get(`/api/v1/books?library_id=${seed.libraryID}&limit=100`);
			expect(response.ok(), await response.text()).toBe(true);
			const { items, next_cursor } = await response.json() as {
				items: Array<{ id: number }>; next_cursor: string | null
			};
			expect(next_cursor).toBeNull();
			for (const item of items) {
				const deleted = await page.request.delete(`/api/v1/books/${item.id}`);
				expect(deleted.ok(), await deleted.text()).toBe(true);
			}
			const deleted = await page.request.delete(`/api/v1/admin/libraries/${seed.libraryID}`);
			expect(deleted.ok(), await deleted.text()).toBe(true);
		}
		if (seed.previousLayout !== undefined) {
			await push(page.request, [{
				entity: 'user_settings', key: 'dashboard.layout.v1', op: 'upsert', updated_at: Date.now(),
				data: { value: seed.previousLayout }
			}]);
		}
	} finally {
		await page.close();
	}
});

test('batches a real 50-cover page and renders all statuses and progress', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await signInRealAdmin(page);
	await page.waitForLoadState('networkidle');
	const requests: Request[] = [];
	page.on('request', (request) => {
		const path = new URL(request.url()).pathname;
		if (path === '/api/v1/me/book-states' || /^\/api\/v1\/me\/books\/\d+$/.test(path)) {
			requests.push(request);
		}
	});
	await page.goto(allBooksPath());
	await expect(page.locator('main .book-grid > li')).toHaveCount(50);
	for (const [index, status] of statuses.entries()) {
		const tile = card(page, book(index).title);
		const badge = tile.getByRole('button', { name: `Reading status: ${status.label}. Change` });
		await expect(badge.locator(`[data-status-icon="${status.value}"]`)).toHaveCount(1);
	}
	await page.mouse.move(0, 0);
	const unread = card(page, book(0).title);
	await expect(unread.locator('.cover-status.unread')).toHaveCSS('opacity', '0');
	await expect(unread.getByRole('progressbar')).toHaveCount(0);
	await unread.locator('.cover-frame').hover();
	await expect(unread.locator('.cover-status.unread')).toHaveCSS('opacity', '1');
	const reading = card(page, book(2).title);
	await reading.locator('.cover-frame').hover();
	await expect(reading.getByRole('progressbar', { name: '42% read' })).toBeVisible();
	await expect(reading.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
	const finished = card(page, book(5).title);
	await finished.locator('.cover-frame').hover();
	await expect(finished.getByRole('progressbar', { name: '100% read' })).toBeVisible();

	await expect(card(page, book(0).title).locator('[data-generated-cover]')).toBeVisible();
	const covered = card(page, book(1).title);
	await expect(covered.locator('[data-generated-cover]')).toHaveCount(0);
	await expect.poll(() => covered.locator('.book-cover img').evaluate((node) =>
		(node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

	await page.waitForLoadState('networkidle');
	const batched = requests.filter((request) => new URL(request.url()).pathname === '/api/v1/me/book-states');
	const individual = requests.filter((request) => /\/api\/v1\/me\/books\/\d+$/.test(new URL(request.url()).pathname));
	expect(individual).toHaveLength(0);
	expect(batched).toHaveLength(1);
	const ids = new URL(batched[0].url()).searchParams.get('ids')?.split(',').map(Number);
	expect(ids?.sort((a, b) => a - b)).toEqual(seed.books.map((item) => item.id).sort((a, b) => a - b));
});

test('uses the same 208 px tile on dashboard, catalog, shelves, related books and Bookheap', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await signInRealAdmin(page);
	const stateRequests: Request[] = [];
	page.on('request', (request) => {
		if (new URL(request.url()).pathname === '/api/v1/me/book-states') stateRequests.push(request);
	});
	const title = book(2).title;
	const surfaces = [
		{ path: '/', tile: () => card(page.locator('[data-dashboard-section="continue_reading"]'), title) },
		{ path: allBooksPath(), tile: () => card(page, title) },
		{ path: `/shelves/${seed.shelfID}`, tile: () => card(page, title) },
		{ path: '/shelves/system/favorites', tile: () => card(page, title) },
		{ path: `/books/${book(0).id}`, tile: () => card(page.locator('[aria-labelledby="related-books-heading"]'), title) }
	];
	for (const surface of surfaces) {
		stateRequests.length = 0;
		await page.goto(surface.path);
		await assertTile(surface.tile());
		await expect(surface.tile().getByRole('button', { name: 'Reading status: Reading. Change' })).toBeVisible();
		await page.waitForLoadState('networkidle');
		expect(stateRequests, `${surface.path} book-state requests`).toHaveLength(1);
	}
	stateRequests.length = 0;
	await page.goto('/bookheap');
	const heap = page.locator(`[data-heap-tile][data-id="${seed.heapID}"]`);
	await assertTile(heap);
	await expect(heap.getByTestId('bh4-row-title')).toHaveText(seed.heapTitle);
	await page.waitForLoadState('networkidle');
	expect(stateRequests).toHaveLength(0);
});

test('the rendered author colors meet contrast against the textured cloth', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await signInRealAdmin(page);
	await page.goto(allBooksPath());
	const palettes = new Map<string, ReturnType<typeof coverCloth>>();
	for (let id = 1; id <= 1000 && palettes.size < 8; id++) {
		const palette = coverCloth(id);
		palettes.set(palette.name, palette);
	}
	expect(palettes.size).toBe(8);
	const cover = card(page, book(0).title).locator('.book-cover');
	await cover.scrollIntoViewIfNeeded();
	for (const [name, palette] of palettes) {
		// Exercise every actual palette regardless of the IDs assigned to imported books.
		await cover.evaluate((node, colors) => {
			for (const [key, value] of Object.entries(colors)) {
				if (key === 'name') continue;
				const cssName = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
				node.style.setProperty(`--cover-${cssName}`, value);
			}
		}, palette);
		const author = cover.locator('.cover-author');
		await page.mouse.move(0, 0);
		await expect(author).toBeVisible();
		const geometry = await author.evaluate((node) => {
			const cover = node.closest('.book-cover');
			if (!cover) throw new Error('The author has no cover');
			const textBox = node.getBoundingClientRect();
			const coverBox = cover.getBoundingClientRect();
			return {
				color: getComputedStyle(node).color,
				left: textBox.left - coverBox.left, top: textBox.top - coverBox.top,
				width: textBox.width, height: textBox.height, coverWidth: coverBox.width, coverHeight: coverBox.height
			};
		});
		const previous = await author.evaluate((node) => {
			const value = node.style.visibility;
			node.style.visibility = 'hidden';
			return value;
		});
		let screenshot: Buffer;
		try {
			screenshot = await cover.screenshot();
		} finally {
			await author.evaluate((node, value) => { node.style.visibility = value; }, previous);
		}
		const ratio = await page.evaluate(async ({ base64, geometry }) => {
			const image = new Image();
			image.src = `data:image/png;base64,${base64}`;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('Canvas is unavailable for contrast measurement');
			context.drawImage(image, 0, 0);
			const pixels = context.getImageData(0, 0, image.width, image.height).data;
			const foreground = geometry.color.match(/\d+/g)?.slice(0, 3).map(Number);
			if (!foreground || foreground.length !== 3) throw new Error(`Invalid author color ${geometry.color}`);
			const luminance = (rgb: number[]) => rgb.map((channel) => {
				const value = channel / 255;
				return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
			}).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
			const ink = luminance(foreground);
			const scaleX = image.width / geometry.coverWidth;
			const scaleY = image.height / geometry.coverHeight;
			let minimum = Infinity;
			for (let y = Math.ceil(geometry.top * scaleY); y < (geometry.top + geometry.height) * scaleY; y++) {
				for (let x = Math.ceil(geometry.left * scaleX); x < (geometry.left + geometry.width) * scaleX; x++) {
					const offset = (y * image.width + x) * 4;
					const background = luminance([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
					minimum = Math.min(minimum, (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05));
				}
			}
			return minimum;
		}, { base64: screenshot.toString('base64'), geometry });
		expect(ratio, `${name} textured author contrast`).toBeGreaterThanOrEqual(4.5);
	}
});

test('captures responsive rest, hover and edge-menu states and supports keyboard and reduced motion', async ({ page }, info) => {
	test.setTimeout(240_000);
	await signInRealAdmin(page);
	const title = book(2).title;
	const surfaces = [
		{ name: 'dashboard', path: '/', tile: () => card(page.locator('[data-dashboard-section="continue_reading"]'), title) },
		{ name: 'all-books', path: allBooksPath(), tile: () => card(page, title) },
		{ name: 'manual-shelf', path: `/shelves/${seed.shelfID}`, tile: () => card(page, title) },
		{ name: 'system-shelf', path: '/shelves/system/favorites', tile: () => card(page, title) },
		{ name: 'related', path: `/books/${book(0).id}`, tile: () => card(page.locator('[aria-labelledby="related-books-heading"]'), title) },
		{ name: 'bookheap', path: '/bookheap', tile: () => page.locator(`[data-heap-tile][data-id="${seed.heapID}"]`) }
	];
	for (const width of [360, 768, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		for (const surface of surfaces) {
			await page.goto(surface.path);
			const tile = surface.tile();
			await expect(tile).toBeVisible();
			await tile.scrollIntoViewIfNeeded();
			await page.mouse.move(0, 0);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
				`${surface.name} at ${width}px overflows`).toBe(true);
			if (surface.name === 'bookheap') {
				const filters = page.getByRole('main').getByRole('search');
				const search = filters.getByRole('searchbox', { name: 'Search', exact: true });
				const box = await search.boundingBox();
				if (!box) throw new Error('Bookheap search is not visible');
				expect(box.width, `Bookheap search at ${width}px`).toBeGreaterThanOrEqual(160);
				await assertSeparate(search, filters.getByRole('combobox', { name: 'Status', exact: true }),
					`Bookheap search and status at ${width}px`);
				await assertSeparate(search, filters.getByRole('button', { name: 'Switch to list view', exact: true }),
					`Bookheap search and view controls at ${width}px`);
			}
			await attachScreenshot(page, info, `${surface.name}-${width}-rest`);
			const frame = tile.locator('.book-tile-lift');
			await frame.hover();
			await expect.poll(() => frame.evaluate((node) => getComputedStyle(node).transform))
				.toBe('matrix(1, 0, 0, 1, 0, -4)');
			await attachScreenshot(page, info, `${surface.name}-${width}-hover`);
		}

		await page.goto('/');
		const row = page.locator('[data-dashboard-section="recently_added"]');
		const scroller = row.getByRole('region');
		await expect(scroller.locator('li')).not.toHaveCount(0);
		await scroller.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
		const edgeTile = scroller.locator('li').last();
		await edgeTile.locator('.cover-frame').hover();
		await edgeTile.getByRole('button', { name: /^Reading status:/ }).click();
		const menu = edgeTile.getByRole('menu', { name: 'Reading status' });
		await expect(menu).toBeVisible();
		const box = await menu.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		expect(box!.y).toBeGreaterThanOrEqual(0);
		expect(box!.y + box!.height).toBeLessThanOrEqual(900);
		expect(await menu.evaluate((node) => {
			const box = node.getBoundingClientRect();
			return [[box.left + 5, box.top + 5], [box.right - 5, box.bottom - 5]].every(([x, y]) => {
				const hit = document.elementFromPoint(x, y);
				return hit !== null && node.contains(hit);
			});
		})).toBe(true);
		await attachScreenshot(page, info, `dashboard-${width}-edge-menu`);
		await page.keyboard.press('Escape');
	}

	await page.goto(allBooksPath());
	const unread = card(page, book(0).title);
	const badge = unread.getByRole('button', { name: 'Reading status: Unread. Change' });
	for (let i = 0; i < 100 && !(await badge.evaluate((node) => node === document.activeElement)); i++) {
		await page.keyboard.press('Tab');
	}
	await expect(badge).toBeFocused();
	await expect(unread.locator('.cover-status.unread')).toHaveCSS('opacity', '1');
	await page.keyboard.press('Enter');
	const menu = unread.getByRole('menu', { name: 'Reading status' });
	await expect(menu.getByRole('menuitemradio', { name: 'Unread' })).toBeFocused();
	await page.keyboard.press('End');
	await expect(menu.getByRole('menuitemradio', { name: 'Abandoned' })).toBeFocused();
	await page.keyboard.press('Home');
	await expect(menu.getByRole('menuitemradio', { name: 'Unread' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(badge).toBeFocused();
	await expect(menu).toHaveCount(0);

	await page.emulateMedia({ reducedMotion: 'reduce' });
	const frame = unread.locator('.book-tile-lift');
	await frame.hover();
	await expect(frame).toHaveCSS('transform', 'none');
	await expect(frame).toHaveCSS('transition-duration', '0s');
});

test.describe('touch viewport', () => {
	test.use({ viewport: { width: 360, height: 900 }, hasTouch: true, isMobile: true });

	test('keeps unread status and progress visible and usable', async ({ page }, info) => {
		await signInRealAdmin(page);
		await page.goto(allBooksPath());
		expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);

		const unread = card(page, book(0).title);
		const badge = unread.getByRole('button', { name: 'Reading status: Unread. Change' });
		await expect(unread.locator('.cover-status.unread')).toHaveCSS('opacity', '1');
		await expect(unread.locator('.book-tile-lift')).toHaveCSS('transform', 'none');

		const reading = card(page, book(2).title);
		const progress = reading.getByRole('progressbar', { name: '42% read' });
		const quickView = reading.getByRole('button', { name: `Quick view: ${book(2).title}` });
		await expect(progress).toBeVisible();
		await expect(reading.locator('.cover-progress-visibility')).toHaveCSS('opacity', '1');
		const infoBox = await quickView.boundingBox();
		const progressBox = await progress.boundingBox();
		expect(infoBox).not.toBeNull();
		expect(progressBox).not.toBeNull();
		expect(infoBox!.y + infoBox!.height).toBeLessThanOrEqual(progressBox!.y);
		for (const tile of [unread, reading]) {
			await assertSeparate(tile.locator('.cover-author'), tile.getByRole('button', { name: /^Quick view:/ }),
				'Quick view must not obscure the cover author');
		}
		await attachScreenshot(page, info, 'all-books-360-touch');

		await badge.tap();
		await expect(unread.getByRole('menu', { name: 'Reading status' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(unread.getByRole('menu', { name: 'Reading status' })).toHaveCount(0);
	});
});

test('Play resumes the saved file and a status change moves the dashboard book', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await signInRealAdmin(page);
	const title = book(2).title;
	const continuing = page.locator('[data-dashboard-section="continue_reading"]');
	await page.goto('/');
	let reading = card(continuing, title);
	await reading.locator('.cover-frame').hover();
	await reading.getByRole('button', { name: `Read ${title}` }).click();
	await expect(page).toHaveURL(`/read/${book(2).id}/${seed.pdfID}`);

	await page.goto('/');
	reading = card(continuing, title);
	await reading.locator('.cover-frame').hover();
	await reading.getByRole('button', { name: 'Reading status: Reading. Change' }).click();
	await reading.getByRole('menuitemradio', { name: 'Skimmed' }).click();
	await expect.poll(async () => {
		const response = await page.request.get(`/api/v1/me/books/${book(2).id}`);
		expect(response.ok(), await response.text()).toBe(true);
		return (await response.json() as { user_book: { status: string; rating: number } }).user_book;
	}).toMatchObject({ status: 'skimmed', rating: 7 });
	await expect(card(continuing, title)).toHaveCount(0);
	const read = page.locator('[data-dashboard-section="read"]');
	await read.scrollIntoViewIfNeeded();
	await expect(card(read, title).getByRole('button', { name: 'Reading status: Skimmed. Change' })).toBeVisible();
	await page.reload();
	await expect(card(continuing, title)).toHaveCount(0);
	await read.scrollIntoViewIfNeeded();
	await expect(card(read, title).getByRole('button', { name: 'Reading status: Skimmed. Change' })).toBeVisible();
});
