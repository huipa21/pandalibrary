import { expect, test, type Page, type Route } from '@playwright/test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { build } from 'vite';

// The kit fixture injects a locally built bundle, which the real server's CSP would block.
test.use({ serviceWorkers: 'block', bypassCSP: true });

const timestamp = '2026-11-04T00:00:00Z';
const longTitle = '星'.repeat(90);
const file = (id: number, format: string, bookId: number) => ({
	id, format, size_bytes: 4096,
	download_url: `/api/v1/books/${bookId}/files/${id}?v=${'a'.repeat(64)}`,
	original_filename: `${bookId}-${id}.${format}`, created_at: timestamp
});
const book = (
	id: number,
	title: string,
	coverUrl: string | null = null,
	metadata: { subtitle?: string; series?: { id: number; name: string; index: number | null } } = {}
) => ({
	id, library_id: 1, title, sort_title: title, subtitle: metadata.subtitle ?? null, description: null, language: null,
	publisher: null, published_date: null, page_count: null, cover_url: coverUrl, cover_source: null,
	authors: [{ id: 1, name: 'First Writer', role: 'author', position: 0 }],
	series: metadata.series ?? null, tags: [], identifiers: [], field_sources: [],
	files: [file(id * 100 + 1, 'pdf', id), file(id * 100 + 2, 'epub', id)],
	created_at: timestamp, updated_at: timestamp
});
const books = [
	book(2, 'Generated Book', null, { subtitle: 'A generated subtitle', series: { id: 8, name: 'Example Series', index: 2 } }),
	book(4, 'PDF Book'),
	book(5, longTitle),
	book(7, 'Palette Four'),
	book(10, 'Read Failure'),
	book(3, 'Palette Six'),
	book(13, 'Palette Seven'),
	book(1, 'Palette Eight'),
	book(21, 'Broken Cover', '/cover-broken.png'),
	book(22, 'Real Cover', '/cover-good.png')
];
books[1].files = [file(401, 'pdf', 4)];
books[3].files = [file(701, 'zip', 7)];
books[7].files = [];
const searchResult = { id: 70, title: 'Search Book', authors: ['Search Writer'], series: { id: 8, name: 'Search Series', index: null }, cover_url: null, rank: -1 };

interface MockState {
	locale: 'en' | 'zh';
	pushStatus: 'applied' | 'stale' | 'rejected';
	holdPush: boolean;
	releasePush: (() => void) | null;
	pushes: Array<{ entity: string; key?: string; data: Record<string, unknown> }>;
	summaries: Map<number, { status: string; percentage: number | null }>;
	userBooks: Map<number, {
		status: string; rating: number | null; started_at: string | null; finished_at: string | null;
		updated_at: string; rev: number;
	}>;
	stateRequests: number[][];
	failUserBook: Set<number>;
	holdUserBook: boolean;
	releaseUserBook: (() => void) | null;
}

function mockState(locale: 'en' | 'zh' = 'en'): MockState {
	return {
		locale, pushStatus: 'applied', holdPush: false, releasePush: null, pushes: [],
		summaries: new Map([
			[2, { status: 'reading', percentage: 0.42 }],
			[4, { status: 'unread', percentage: 0 }],
			[5, { status: 'finished', percentage: null }]
		]),
		userBooks: new Map([[2, {
			status: 'reading', rating: 7, started_at: '2026-01-02T03:04:05Z',
			finished_at: '2026-02-01T00:00:00Z', updated_at: timestamp, rev: 3
		}]]),
		stateRequests: [], failUserBook: new Set(), holdUserBook: false, releaseUserBook: null
	};
}

function problem(route: Route, status: number) {
	return route.fulfill({
		status, contentType: 'application/problem+json',
		body: JSON.stringify({ status, title: 'Request failed' })
	});
}

async function mockApi(page: Page, state: MockState) {
	await page.addInitScript(() => {
		window.addEventListener('pandalibrary-quick-view', (event) => {
			const detail = (event as CustomEvent<{ bookId: number; book?: { title: string }; trigger: Element | null }>).detail;
			document.documentElement.dataset.quickBook = String(detail.bookId);
			document.documentElement.dataset.quickBookProvided = String(Boolean(detail.book));
			document.documentElement.dataset.quickTrigger = String(detail.trigger === document.activeElement);
		});
		window.addEventListener('pandalibrary-book-state-changed', (event) => {
			document.documentElement.dataset.stateBook = String((event as CustomEvent<{ bookId: number }>).detail.bookId);
		});
	});
	await page.route('**/cover-broken.png', (route) => route.fulfill({ status: 404, body: 'missing' }));
	await page.route('**/cover-good.png', (route) => route.fulfill({
		contentType: 'image/png',
		body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=', 'base64')
	}));
	await page.route((url) => url.pathname.startsWith('/api/v1/'), async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: {
			id: 1, username: 'reader', display_name: '', role: 'user', locale: state.locale
		} } });
		if (path === '/version') return route.fulfill({ json: {
			version: 'test', commit: '0123456789abcdef', commit_date: timestamp, dirty: false, release: null
		} });
		if (path === '/shelves/system/unshelved' || path === '/shelves/system/favorites') {
			return route.fulfill({ json: { shelf: {
				id: path.endsWith('favorites') ? 7 : 8, name: 'System shelf', system_key: path.split('/').at(-1),
				visible_book_count: 0
			} } });
		}
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: Number(url.searchParams.get('cursor') ?? 0),
			user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: []
		} });
		if (path === '/sync/push') {
			const body = request.postDataJSON() as { mutations: MockState['pushes'] };
			const entries = body.mutations.filter((mutation) => mutation.entity === 'user_books');
			state.pushes.push(...entries);
			if (entries.length && state.holdPush) {
				await new Promise<void>((release) => { state.releasePush = release; });
				state.holdPush = false;
				state.releasePush = null;
			}
			if (state.pushStatus === 'applied') {
				for (const { data } of entries) {
					const id = Number(data.book_id);
					const status = String(data.status);
					const date = (value: unknown) => typeof value === 'number' ? new Date(value).toISOString() : null;
					state.userBooks.set(id, {
						status, rating: typeof data.rating === 'number' ? data.rating : null,
						started_at: date(data.started_at), finished_at: date(data.finished_at),
						updated_at: new Date().toISOString(), rev: state.pushes.length
					});
					state.summaries.set(id, { status, percentage: state.summaries.get(id)?.percentage ?? null });
				}
			}
			return route.fulfill({ json: { results: body.mutations.map((mutation, index) => ({
				index, status: mutation.entity === 'user_books' ? state.pushStatus : 'applied'
			})) } });
		}
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (['/authors', '/series', '/tags', '/libraries', '/shelves'].includes(path)) {
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		if (path === '/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Library' } } });
		if (path === '/books') return route.fulfill({ json: { items: books, next_cursor: null } });
		if (path === '/search') return route.fulfill({ json: { items: [searchResult], next_cursor: null } });
		if (path === '/me/book-states') {
			const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number);
			state.stateRequests.push(ids);
			return route.fulfill({ json: { items: ids.flatMap((id) => {
				const summary = state.summaries.get(id);
				return summary ? [{ book_id: id, ...summary, book_file_id: null, updated_at: timestamp }] : [];
			}) } });
		}
		if (/^\/books\/\d+\/shelves$/.test(path)) return route.fulfill({ json: { shelves: [] } });
		const details = /^\/books\/(\d+)$/.exec(path);
		if (details) {
			const found = books.find((item) => item.id === Number(details[1]));
			return found ? route.fulfill({ json: { book: found } }) : problem(route, 404);
		}
		const progress = /^\/me\/books\/(\d+)$/.exec(path);
		if (progress) {
			const id = Number(progress[1]);
			if (id === 10 || state.failUserBook.has(id)) return problem(route, 503);
			if (id === 2 && state.holdUserBook) {
				await new Promise<void>((release) => { state.releaseUserBook = release; });
				state.holdUserBook = false;
				state.releaseUserBook = null;
			}
			return route.fulfill({ json: {
				user_book: state.userBooks.get(id) ?? null, highlights: [], bookmarks: [], notes: [],
				progress: id === 2 ? {
					book_file_id: 201, source: 'web', locator: null, percentage: 0.4,
					device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
				} : null
			} });
		}
		if (/^\/me\/books\/\d+\/reading-summary$/.test(path)) return route.fulfill({ json: { summary: {
			progress: 0, sessions: 0, total_seconds: 0, average_seconds: 0, active_days: 0, span_days: 0,
			first_read_at: null, last_read_at: null, pace_percent_per_hour: null, estimated_seconds_left: null,
			records: { longest_session: null, best_day: null, longest_streak_days: 0 }, attempts: [], days: []
		} } });
		return problem(route, 404);
	});
}

function card(page: Page, title: string) {
	return page.locator('li').filter({ has: page.getByTitle(title, { exact: true }) }).first();
}

async function mountKitFixture(page: Page) {
	const result = await build({
		configFile: false,
		plugins: [svelte()],
		resolve: { alias: [{ find: '#lib', replacement: resolve('src/lib') }] },
		build: {
			write: false,
			lib: { entry: resolve('src/lib/bookview/kit-fixture.ts'), formats: ['es'] }
		}
	});
	const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
		if (!('output' in item)) throw new Error('Unexpected fixture build result.');
		return item.output;
	});
	const script = outputs.find((output) => output.type === 'chunk');
	const css = outputs.find((output) => output.type === 'asset' && output.fileName.endsWith('.css'));
	if (!script || script.type !== 'chunk' || !css || css.type !== 'asset') {
		throw new Error('The component fixture did not produce JavaScript and CSS.');
	}
	await page.evaluate(() => {
		const root = document.createElement('div');
		root.id = 'bv3-test-root';
		document.body.append(root);
	});
	await page.addStyleTag({ content: typeof css.source === 'string' ? css.source : Buffer.from(css.source).toString('utf8') });
	await page.addScriptTag({ content: script.code, type: 'module' });
	await expect(page.locator('#bv3-test-root [role="radiogroup"]')).toBeVisible();
}

async function measureBookGrid(page: Page, width: number) {
	return page.evaluate((gridWidth) => {
		const grid = document.createElement('div');
		grid.className = 'book-grid';
		grid.style.width = `${gridWidth}px`;
		for (let index = 0; index < 4; index += 1) grid.append(document.createElement('span'));
		document.body.append(grid);
		const style = getComputedStyle(grid);
		const result = {
			widths: Array.from(grid.children, (child) => child.getBoundingClientRect().width),
			rowGap: style.rowGap, columnGap: style.columnGap, justifyContent: style.justifyContent
		};
		grid.remove();
		return result;
	}, width);
}

test('generates accessible, contrast-checked covers and badges in grid and list modes', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	await expect(generated.locator('[data-generated-cover]')).toContainText('Generated Book');
	await expect(generated.locator('[data-generated-cover]')).toContainText('First Writer');
	await expect(generated.getByRole('img', { name: 'Generated Book', exact: true })).toHaveAttribute('data-generated-cover', '');
	await expect(generated.getByRole('img', { name: 'Formats: EPUB, PDF' })).toContainText('EPUB +1');
	await expect(card(page, 'PDF Book').getByRole('img', { name: 'Formats: PDF' })).toContainText('PDF');
	await expect(card(page, longTitle).locator('.cover-title')).toHaveText(`${'星'.repeat(79)}…`);
	await expect(card(page, 'Broken Cover').locator('[data-generated-cover]')).toContainText('Broken Cover');
	await expect(card(page, 'Real Cover').getByRole('img', { name: 'Real Cover' })).toBeVisible();
	await expect.poll(() => card(page, 'Real Cover').locator('img').evaluate((image) =>
		image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
	)).toBe(true);
	await expect(card(page, 'Palette Four').getByRole('img', { name: 'Formats: ZIP' })).toBeVisible();
	await expect(card(page, 'Palette Eight').getByRole('img', { name: /^Formats:/ })).toHaveCount(0);
	await expect(page.getByText('Cover unavailable')).toHaveCount(0);

	const colors = await page.locator('[data-generated-cover]').evaluateAll((nodes) => {
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas color conversion is unavailable.');
		const rgb = (color: string) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
		};
		const luminance = (values: number[]) => values.map((value) => {
			const channel = value / 255;
			return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		}).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
		return nodes.map((node) => {
			const title = node.querySelector('.cover-title');
			const plate = node.querySelector('.cover-plate');
			if (!title || !plate) throw new Error('Generated cover title or plate is missing.');
			const board = getComputedStyle(node).backgroundColor;
			const background = getComputedStyle(plate).backgroundColor;
			const foreground = getComputedStyle(title).color;
			const first = luminance(rgb(background));
			const second = luminance(rgb(foreground));
			return { board, contrast: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) };
		});
	});
	expect(new Set(colors.map((color) => color.board)).size).toBe(8);
	for (const color of colors) expect(color.contrast).toBeGreaterThanOrEqual(4.5);

	await page.getByRole('button', { name: 'Switch to list view', exact: true }).click();
	await expect(card(page, 'Generated Book').locator('[data-generated-cover]')).toBeVisible();
	await expect(card(page, 'Generated Book').getByRole('img', { name: 'Formats: EPUB, PDF' })).toBeVisible();
	await expect(card(page, 'Generated Book').getByRole('heading', { name: 'Generated Book' })).toBeVisible();
	await expect(card(page, 'Generated Book').getByRole('button', { name: 'Reading status: Reading. Change' })).toBeVisible();
	await expect(card(page, 'Generated Book').getByRole('progressbar')).toHaveCount(0);
	expect(await card(page, longTitle).locator('.cover-title').evaluate((node) => getComputedStyle(node).webkitLineClamp)).toBe('3');
	await expect(page.getByText('Cover unavailable')).toHaveCount(0);
});

test('renders cloth covers at the measured size without overflowing', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockApi(page, mockState());
	await page.goto('/books');

	const long = card(page, longTitle).locator('.cover-title');
	await expect(long).toHaveAttribute('data-title-scale', 'sm');
	expect(await long.evaluate((node) => getComputedStyle(node).webkitLineClamp)).toBe('5');
	expect(await long.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);

	const realCover = card(page, 'Real Cover').locator('.book-cover');
	const generatedCover = card(page, 'Generated Book').locator('.book-cover');
	const geometry = await generatedCover.evaluate((node) => {
		const rect = node.getBoundingClientRect();
		const style = getComputedStyle(node);
		return { width: rect.width, height: rect.height, ratio: style.aspectRatio, radius: style.borderRadius, shadow: style.boxShadow };
	});
	expect(geometry.ratio).toBe('2 / 3');
	expect(geometry.height / geometry.width).toBeCloseTo(1.5, 2);
	expect(await realCover.evaluate((node) => {
		const style = getComputedStyle(node);
		return { ratio: style.aspectRatio, radius: style.borderRadius, shadow: style.boxShadow };
	})).toEqual({ ratio: geometry.ratio, radius: geometry.radius, shadow: geometry.shadow });
	expect(await realCover.locator('img').evaluate((node) => getComputedStyle(node).objectFit)).toBe('cover');

	const appScreenshot = testInfo.outputPath('bc3-app-1440.png');
	await page.screenshot({ path: appScreenshot });
	await testInfo.attach('BC3 app at 1440px', { path: appScreenshot, contentType: 'image/png' });

	await mountKitFixture(page);
	const gallery = page.locator('[data-test="cloth-cover-gallery"]');
	const covers = gallery.locator('[data-generated-cover]');
	await expect(covers).toHaveCount(6);
	for (const [title, scale, factor] of [
		['Emma', 'xl', 0.17],
		['Frankenstein', 'lg', 0.12],
		['Pride and Prejudice', 'md', 0.095],
		['Twenty Thousand Leagues Under the Seas', 'sm', 0.08]
	] as const) {
		const label = gallery.locator(`[aria-label="${title}"] .cover-title`);
		await expect(label).toHaveAttribute('data-title-scale', scale);
		expect(await label.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)))
			.toBeCloseTo(208 * factor, 1);
	}
	await expect(gallery.locator('[aria-label="Emma"] .cloth-frame')).toHaveCount(2);
	await expect(gallery.locator('[aria-label="Emma"] .cover-texture')).toHaveCSS('mix-blend-mode', 'multiply');
	await expect(gallery.locator('[aria-label="Emma"] .cover-texture')).toHaveCSS('opacity', '0.18');
	const referenceTitle = gallery.locator('[aria-label="Twenty Thousand Leagues Under the Seas"] .cover-title');
	await expect(referenceTitle).toHaveAttribute('data-title-scale', 'sm');
	const referenceLines = await referenceTitle.evaluate((node) =>
		node.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(node).lineHeight)
	);
	expect(referenceLines).toBeGreaterThan(1);
	expect(referenceLines).toBeLessThanOrEqual(5.01);
	await expect(gallery.locator('[aria-label="The Adventures of Sherlock Holmes"] .cover-series')).toHaveText('Sherlock Holmes');
	await expect(gallery.locator('[aria-label="Frankenstein"] .cover-subtitle')).toHaveText('The Modern Prometheus');
	await expect(gallery.locator('[aria-label="Frankenstein"] .cover-author')).toHaveText('Mary Shelley');

	const layout = await covers.evaluateAll((nodes) => nodes.map((node) => {
		const root = node.parentElement;
		const plate = node.querySelector('.cover-plate');
		const footer = node.querySelector('.cover-footer');
		if (!root || !plate || !footer) throw new Error('Generated cover layers are missing.');
		const rootRect = root.getBoundingClientRect();
		const plateRect = plate.getBoundingClientRect();
		const footerRect = footer.getBoundingClientRect();
		const contents = Array.from(plate.querySelectorAll('.cover-title, .cover-series, .cover-subtitle'), (element) => {
			const rect = element.getBoundingClientRect();
			return rect.top >= plateRect.top && rect.bottom <= plateRect.bottom &&
				rect.left >= plateRect.left && rect.right <= plateRect.right;
		});
		return {
			width: rootRect.width, height: rootRect.height,
			plateAboveFooter: plateRect.bottom <= footerRect.top,
			contentsFit: contents.every(Boolean)
		};
	}));
	for (const cover of layout) {
		expect(cover.width).toBe(208);
		expect(cover.height / cover.width).toBeCloseTo(1.5, 2);
		expect(cover.plateAboveFooter).toBe(true);
		expect(cover.contentsFit).toBe(true);
	}

	const galleryScreenshot = testInfo.outputPath('bc3-cloth-covers-1440.png');
	await gallery.screenshot({ path: galleryScreenshot });
	await testInfo.attach('BC3 cloth covers at 1440px', { path: galleryScreenshot, contentType: 'image/png' });

	const xs = page.locator('[data-test="cover-xs"]');
	const sm = page.locator('[data-test="cover-sm"]');
	for (const compact of [xs, sm]) {
		expect(await compact.locator('.cover-title').evaluate((node) => getComputedStyle(node).webkitLineClamp)).toBe('3');
		await expect(compact.locator('.cover-subtitle')).toHaveCount(0);
	}
	await expect(xs.locator('.cover-series, .cover-footer')).toHaveCount(0);
	await expect(sm.locator('.cover-series')).toHaveText('A long series');
	await expect(sm.locator('.cover-author')).toHaveText('First Writer');

	const overflow = page.locator('[data-test="cover-overflow"]');
	for (const selector of ['.cover-series', '.cover-subtitle', '.cover-author']) {
		expect(await overflow.locator(selector).evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
	}
	const overflowLayout = await overflow.locator('[data-generated-cover]').evaluate((node) => {
		const plate = node.querySelector('.cover-plate');
		const footer = node.querySelector('.cover-footer');
		if (!plate || !footer) throw new Error('Generated cover layers are missing.');
		const plateRect = plate.getBoundingClientRect();
		return {
			plateAboveFooter: plateRect.bottom <= footer.getBoundingClientRect().top,
			contentsFit: Array.from(plate.querySelectorAll('.cover-title, .cover-series, .cover-subtitle'), (element) => {
				const rect = element.getBoundingClientRect();
				return rect.top >= plateRect.top && rect.bottom <= plateRect.bottom &&
					rect.left >= plateRect.left && rect.right <= plateRect.right;
			}).every(Boolean)
		};
	});
	expect(overflowLayout).toEqual({ plateAboveFooter: true, contentsFit: true });

	expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--spacing-book').trim())).toBe('13rem');
	expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--aspect-book').trim())).toBe('2 / 3');
	expect(await measureBookGrid(page, 900)).toEqual({
		widths: [208, 208, 208, 208], rowGap: '28px', columnGap: '20px', justifyContent: 'start'
	});
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await measureBookGrid(page, 300)).toEqual({
		widths: [140, 140, 140, 140], rowGap: '28px', columnGap: '20px', justifyContent: 'start'
	});
	await page.setViewportSize({ width: 639, height: 844 });
	expect((await measureBookGrid(page, 300)).widths).toEqual([140, 140, 140, 140]);
	await page.setViewportSize({ width: 640, height: 844 });
	expect((await measureBookGrid(page, 900)).widths).toEqual([208, 208, 208, 208]);
});

test('passes cover metadata through the catalog, quick view, details, and files', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	const catalogCover = generated.locator('[data-generated-cover]');
	await expect(catalogCover.locator('.cover-series')).toHaveText('Example Series');
	await expect(catalogCover.locator('.cover-subtitle')).toHaveText('A generated subtitle');
	await generated.locator('div.cover-frame').hover();
	await generated.getByRole('button', { name: 'Quick view: Generated Book' }).click();
	const drawerCover = page.getByRole('dialog', { name: 'Generated Book' }).locator('[data-generated-cover]');
	await expect(drawerCover.locator('.cover-series')).toHaveText('Example Series');
	await expect(drawerCover.locator('.cover-subtitle')).toHaveCount(0);
	await page.keyboard.press('Escape');

	await page.goto('/books/2');
	const detailsCover = page.locator('[data-generated-cover][aria-label="Generated Book"]').first();
	await expect(detailsCover.locator('.cover-series')).toHaveText('Example Series');
	await expect(detailsCover.locator('.cover-subtitle')).toHaveText('A generated subtitle');

	await page.goto('/books/2/files');
	const filesCover = page.locator('[data-generated-cover][aria-label="Generated Book"]').first();
	await expect(filesCover.locator('.cover-series')).toHaveText('Example Series');
	await expect(filesCover.locator('.cover-subtitle')).toHaveCount(0);
});

test('batches state loading without shifting the cover and renders cover-only cards', async ({ page }) => {
	const state = mockState();
	await mockApi(page, state);
	let release = () => {};
	const held = new Promise<void>((resolve) => { release = resolve; });
	await page.route('**/api/v1/me/book-states?*', async (route) => {
		await held;
		await route.fallback();
	});
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	await expect(generated.locator('.book-cover')).toBeVisible();
	const before = await generated.boundingBox();
	await expect(generated.locator('.cover-status, [role="progressbar"]')).toHaveCount(0);
	release();
	await expect(generated.getByRole('button', { name: 'Reading status: Reading. Change' })).toBeVisible();
	const after = await generated.boundingBox();
	expect(after?.width).toBe(before?.width);
	expect(after?.height).toBe(before?.height);
	await expect(generated.getByRole('heading', { name: 'Generated Book' })).toHaveCount(0);
	await expect(generated.locator(':scope > *')).toHaveCount(1);
	await expect(generated.getByRole('link', { name: 'Open book details' })).toHaveAttribute('title', 'Generated Book');
	await expect.poll(() => state.stateRequests.length).toBe(1);
	expect([...state.stateRequests[0]].sort((a, b) => a - b)).toEqual(books.map(({ id }) => id).sort((a, b) => a - b));
});

test('keeps the format and status badges separate on narrow list covers', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockApi(page, mockState());
	await page.goto('/books');
	await page.getByRole('button', { name: 'Switch to list view', exact: true }).click();
	const generated = card(page, 'Generated Book');
	const format = generated.getByRole('img', { name: 'Formats: EPUB, PDF' });
	const status = generated.getByRole('button', { name: 'Reading status: Reading. Change' });
	await expect(format).toBeVisible();
	await expect(status).toBeVisible();
	for (const width of [390, 640]) {
		await page.setViewportSize({ width, height: 844 });
		const formatBox = await format.boundingBox();
		const statusBox = await status.boundingBox();
		expect(formatBox).not.toBeNull();
		expect(statusBox).not.toBeNull();
		expect(formatBox!.x + formatBox!.width <= statusBox!.x ||
			formatBox!.y >= statusBox!.y + statusBox!.height,
		`Badges overlap at viewport ${width}: ${JSON.stringify({ formatBox, statusBox })}`).toBe(true);
	}
});

test('shows status and progress on hover, including zero and finished cases', async ({ page }, testInfo) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	const tile = generated.locator('.cover-frame');
	const badge = generated.getByRole('button', { name: 'Reading status: Reading. Change' });
	await expect(badge.locator('svg[data-status-icon="reading"]')).toHaveClass(/text-blue-600/);
	const unread = card(page, 'PDF Book');
	await expect(unread.getByRole('button', { name: 'Reading status: Unread. Change' })).toBeAttached();
	await expect(unread.locator('.cover-status')).toHaveCSS('opacity', '0');
	await expect(generated.locator('.cover-progress-visibility')).toHaveCSS('opacity', '0');

	await tile.hover();
	await expect.poll(() => tile.evaluate((node) => getComputedStyle(node).transform)).toBe('matrix(1, 0, 0, 1, 0, -4)');
	await expect(tile).toHaveCSS('box-shadow', 'rgba(15, 23, 42, 0.35) 0px 10px 24px -6px');
	await expect(generated.locator('.cover-progress-visibility')).toHaveCSS('opacity', '1');
	const progress = generated.getByRole('progressbar', { name: '42% read' });
	await expect(progress).toHaveAttribute('aria-valuenow', '42');
	await expect(progress).toContainText('42%');
	await expect(progress.locator('[style*="width"]')).toHaveAttribute('style', /width:\s*42%/);
	const screenshot = testInfo.outputPath('bc4-cover-hover.png');
	await generated.screenshot({ path: screenshot });
	await testInfo.attach('BC4 cover hover', { path: screenshot, contentType: 'image/png' });

	await unread.locator('.cover-frame').hover();
	await expect(unread.locator('.cover-status')).toHaveCSS('opacity', '1');
	await expect(unread.getByRole('progressbar')).toHaveCount(0);
	await expect(card(page, 'Palette Four').getByRole('progressbar')).toHaveCount(0);
	const finished = card(page, longTitle);
	await finished.locator('.cover-frame').hover();
	await expect(finished.getByRole('progressbar', { name: '100% read' })).toHaveAttribute('aria-valuenow', '100');

	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(tile).toHaveCSS('transform', 'none');
	await tile.hover();
	await expect(tile).toHaveCSS('transform', 'none');
	await expect(tile).toHaveCSS('transition-duration', '0s');
});

test('changes the badge outside a clipped scroller without losing reading metadata', async ({ page }) => {
	const state = mockState();
	await mockApi(page, state);
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	const badge = generated.getByRole('button', { name: 'Reading status: Reading. Change' });
	await expect(badge).toBeVisible();
	await generated.evaluate((element) => {
		element.style.height = '52px';
		element.style.overflow = 'hidden';
	});
	await badge.click();
	const menu = generated.getByRole('menu', { name: 'Reading status' });
	const onHold = menu.getByRole('menuitemradio', { name: 'On hold' });
	await expect(onHold).toBeVisible();
	const cardBox = await generated.boundingBox();
	const optionBox = await onHold.boundingBox();
	expect(optionBox!.y).toBeGreaterThan(cardBox!.y + cardBox!.height);
	await onHold.click();
	await expect.poll(() => state.pushes.length).toBe(1);
	expect(state.pushes[0]).toMatchObject({
		entity: 'user_books', key: '2', data: {
			book_id: 2, status: 'on_hold', rating: 7,
			started_at: Date.parse('2026-01-02T03:04:05Z'),
			finished_at: null
		}
	});
	await expect(generated.getByRole('button', { name: 'Reading status: On hold. Change' })
		.locator('svg[data-status-icon="on_hold"]')).toHaveClass(/text-amber-500/);
	await expect(page).toHaveURL(/\/books$/);
});

test('keeps a clipped badge menu usable without native popover support', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: undefined });
	});
	const state = mockState();
	await mockApi(page, state);
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	await generated.evaluate((element) => {
		element.style.height = '52px';
		element.style.overflow = 'hidden';
	});
	const badge = generated.getByRole('button', { name: 'Reading status: Reading. Change' });
	await badge.click();
	const menu = page.getByRole('menu', { name: 'Reading status' });
	await expect(menu.getByRole('menuitemradio', { name: 'On hold' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(badge).toBeFocused();
	await badge.click();
	await menu.getByRole('menuitemradio', { name: 'On hold' }).click();
	await expect.poll(() => state.pushes.length).toBe(1);
	await expect(generated.getByRole('button', { name: 'Reading status: On hold. Change' })).toBeVisible();
	await expect(menu).toHaveCount(0);
});

test('reports a menu opening failure and keeps the badge usable', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(HTMLElement.prototype, 'showPopover', {
			configurable: true, value: () => { throw new Error('Popover unavailable'); }
		});
	});
	await mockApi(page, mockState());
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	const badge = generated.getByRole('button', { name: 'Reading status: Reading. Change' });
	await badge.click();
	await expect(generated.getByRole('alert')).toContainText('Could not open the reading status menu');
	await expect(badge).toBeFocused();
	await expect(generated.getByRole('menu')).toHaveCount(0);
});

test('preserves queued reading metadata when changing the badge', async ({ page }) => {
	const state = mockState();
	await mockApi(page, state);
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	const badge = generated.getByRole('button', { name: 'Reading status: Reading. Change' });
	await expect(badge).toBeVisible();
	await page.evaluate(async () => {
		await navigator.locks.request('pandalibrary-session-and-sync', () => undefined);
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('pandalibrary-offline');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction('outbox', 'readwrite');
			transaction.objectStore('outbox').add({
				account: 1, status: 'pending', mutation: {
					entity: 'user_books', key: '2', op: 'upsert', updated_at: Date.now() - 1000,
					data: {
						book_id: 2, status: 'reading', rating: 9,
						started_at: Date.parse('2026-03-04T00:00:00Z'),
						finished_at: Date.parse('2026-05-06T00:00:00Z')
					}
				}
			});
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
		database.close();
	});
	await badge.click();
	await generated.getByRole('menuitemradio', { name: 'On hold' }).click();
	await expect.poll(() => state.pushes.length).toBe(1);
	expect(state.pushes[0].data).toMatchObject({
		status: 'on_hold', rating: 9,
		started_at: Date.parse('2026-03-04T00:00:00Z'),
		finished_at: null
	});
});

test('hides unavailable state and recovers after a refresh', async ({ page }) => {
	const state = mockState();
	await mockApi(page, state);
	let fail = true;
	await page.route('**/api/v1/me/book-states?*', (route) =>
		fail ? problem(route, 503) : route.fallback());
	const failed = page.waitForResponse((response) =>
		new URL(response.url()).pathname === '/api/v1/me/book-states' && response.status() === 503);
	await page.goto('/books');
	await failed;
	const generated = card(page, 'Generated Book');
	await expect(generated.locator('.book-cover')).toBeVisible();
	await expect(generated.locator('.cover-status, [role="progressbar"]')).toHaveCount(0);
	fail = false;
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', {
		detail: { bookId: 2 }
	})));
	await expect(generated.getByRole('button', { name: 'Reading status: Reading. Change' })).toBeVisible();
});

test('reports a failed status lookup instead of overwriting existing metadata', async ({ page }) => {
	const state = mockState();
	state.failUserBook.add(2);
	await mockApi(page, state);
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	await generated.getByRole('button', { name: 'Reading status: Reading. Change' }).click();
	await generated.getByRole('menuitemradio', { name: 'On hold' }).click();
	await expect(generated.getByRole('alert')).toContainText('Could not update reading status');
	await expect(generated.getByRole('button', { name: 'Reading status: Reading. Change' })).toBeVisible();
	expect(state.pushes).toHaveLength(0);
});

test('reports a concurrent status change instead of overwriting it', async ({ page }) => {
	const state = mockState();
	state.holdUserBook = true;
	await mockApi(page, state);
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	await generated.getByRole('button', { name: 'Reading status: Reading. Change' }).click();
	await generated.getByRole('menuitemradio', { name: 'On hold' }).click();
	await expect.poll(() => state.releaseUserBook !== null).toBe(true);
	state.summaries.set(2, { status: 'finished', percentage: 0.42 });
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', {
		detail: { bookId: 2 }
	})));
	await expect(generated.getByRole('button', { name: 'Reading status: Read. Change' })).toBeVisible();
	state.releaseUserBook?.();
	await expect(generated.getByRole('alert')).toContainText('Could not update reading status');
	expect(state.pushes).toHaveLength(0);
});

test('shows a non-interactive badge while offline', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	await expect(generated.getByRole('button', { name: 'Reading status: Reading. Change' })).toBeVisible();
	await page.evaluate(() => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
		window.dispatchEvent(new Event('offline'));
	});
	await expect(generated.getByRole('img', { name: 'Reading status: Reading. Change' })).toBeVisible();
	await expect(generated.getByRole('button', { name: 'Reading status: Reading. Change' })).toHaveCount(0);
});

test('reveals keyboard and hover actions, dispatches info, and resumes the saved file', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	const overlay = generated.locator('.cover-overlay');
	await expect(generated.locator('[data-generated-cover]')).toBeVisible();
	expect(await overlay.evaluate((node) => Number(getComputedStyle(node).opacity))).toBe(0);
	await generated.locator('div.cover-frame').hover();
	await expect.poll(() => overlay.evaluate((node) => Number(getComputedStyle(node).opacity))).toBe(1);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	expect(await overlay.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s');
	const info = generated.getByRole('button', { name: 'Quick view: Generated Book' });
	const read = generated.getByRole('button', { name: 'Read Generated Book' });
	await expect(info).toBeVisible();
	await expect(read).toBeVisible();
	const buttonSize = await info.boundingBox();
	expect(buttonSize?.width).toBeGreaterThanOrEqual(44);
	expect(buttonSize?.height).toBeGreaterThanOrEqual(44);
	await info.click();
	await expect(page.locator('html')).toHaveAttribute('data-quick-book', '2');
	await expect(page.locator('html')).toHaveAttribute('data-quick-book-provided', 'true');
	await expect(page.locator('html')).toHaveAttribute('data-quick-trigger', 'true');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);

	await generated.getByRole('link', { name: 'Open book details' }).focus();
	await expect(generated.getByRole('link', { name: 'Open book details' })).toHaveAccessibleDescription('Generated Book');
	await expect(generated.locator('.cover-progress-visibility')).toHaveCSS('opacity', '1');
	await page.keyboard.press('Tab');
	await expect(generated.getByRole('button', { name: 'Reading status: Reading. Change' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(info).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(read).toBeFocused();
	await read.click();
	await expect(page).toHaveURL(/\/read\/2\/201$/);
});

test('reveals the unread badge and lift on keyboard focus', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const unread = card(page, 'PDF Book');
	await expect(unread.locator('.cover-status')).toHaveCSS('opacity', '0');
	await unread.getByRole('link', { name: 'Open book details' }).focus();
	await expect(unread.locator('.cover-status')).toHaveCSS('opacity', '1');
	await expect.poll(() => unread.locator('.cover-frame').evaluate((node) =>
		getComputedStyle(node).transform)).toBe('matrix(1, 0, 0, 1, 0, -4)');
	await page.keyboard.press('Tab');
	await expect(unread.getByRole('button', { name: 'Reading status: Unread. Change' })).toBeFocused();
});

test('uses the first readable fallback and reports failures without navigation', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const failed = card(page, 'Read Failure');
	await failed.locator('div.cover-frame').hover();
	await failed.getByRole('button', { name: 'Read Read Failure' }).click();
	await expect(failed.getByRole('alert')).toContainText('Could not open the reader');
	await expect(page).toHaveURL(/\/books$/);
	await expect(card(page, 'Palette Four').getByRole('button', { name: 'Read Palette Four' })).toHaveCount(0);

	const pdf = card(page, 'PDF Book');
	await pdf.locator('div.cover-frame').hover();
	await pdf.getByRole('button', { name: 'Read PDF Book' }).click();
	await expect(page).toHaveURL(/\/read\/4\/401$/);
});

test('search results use generated covers and dispatch info without claiming a full book', async ({ page }) => {
	const state = mockState();
	await mockApi(page, state);
	await page.goto('/search?q=book');
	const result = card(page, 'Search Book');
	await expect(result.locator('[data-generated-cover]')).toContainText('Search Book');
	await expect(result.locator('[data-generated-cover]')).toContainText('Search Writer');
	await expect(result.locator('.cover-series')).toHaveText('Search Series');
	await expect(result.getByRole('img', { name: 'Cover of Search Book' })).toBeVisible();
	await expect(result.getByRole('img', { name: /^Formats:/ })).toHaveCount(0);
	await expect(result.getByRole('button', { name: 'Read Search Book' })).toHaveCount(0);
	await expect(result.locator('.cover-status, [role="progressbar"]')).toHaveCount(0);
	expect(state.stateRequests).toHaveLength(0);
	await result.locator('div.cover-frame').hover();
	await result.getByRole('button', { name: 'Quick view: Search Book' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-quick-book', '70');
	await expect(page.locator('html')).toHaveAttribute('data-quick-book-provided', 'false');
});

test('localizes cover actions and badges', async ({ page }) => {
	await mockApi(page, mockState('zh'));
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	await expect(generated.getByRole('img', { name: '格式：EPUB, PDF' })).toBeVisible();
	await generated.locator('div.cover-frame').hover();
	await expect(generated.getByRole('button', { name: '快速查看：Generated Book' })).toBeVisible();
	await expect(generated.getByRole('button', { name: '阅读 Generated Book' })).toBeVisible();
	await expect(generated.getByRole('button', { name: '阅读状态：阅读中。更改' })).toBeVisible();
	await expect(generated.getByRole('progressbar', { name: '已读 42%' })).toBeVisible();
	await mountKitFixture(page);
	await expect(page.locator('[data-test="duration"]')).toHaveText('2小时 56分钟');
	const status = page.locator('[data-test="reading-status"]');
	await status.getByRole('button', { name: '阅读状态：阅读中' }).click();
	await expect(status.getByRole('menuitemradio')).toHaveText(['阅读中', '暂搁', '已读', '已略读', '已放弃']);
	await expect(status.getByRole('menuitemradio', { name: '阅读中' })).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await expect(page.locator('[data-test="badge-reading-status"]').getByRole('button',
		{ name: '阅读状态：阅读中。更改' })).toBeVisible();
});

test('exercises interactive kit primitives, safe links, and optimistic status rollback', async ({ page }) => {
	const state = mockState();
	await mockApi(page, state);
	await page.goto('/books');
	await mountKitFixture(page);

	const rating = page.getByRole('radiogroup', { name: 'Rating' });
	await expect(rating.getByRole('radio')).toHaveCount(10);
	await rating.getByRole('radio', { name: '3.5 out of 5' }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(rating.getByRole('radio', { name: '4 out of 5' })).toBeFocused();
	await expect(rating.getByRole('radio', { name: '4 out of 5' })).toHaveAttribute('aria-checked', 'true');
	await page.getByRole('button', { name: 'Clear rating' }).click();
	await expect(rating.getByRole('radio', { name: '0.5 out of 5' })).toHaveAttribute('tabindex', '0');
	await expect(rating.getByRole('radio', { name: '0.5 out of 5' })).toBeFocused();
	await expect(page.getByRole('img', { name: '2.5 out of 5' })).toBeVisible();

	const long = page.locator('[data-test="long-description"]');
	const short = page.locator('[data-test="short-description"]');
	await expect(long.getByRole('button', { name: 'Show more' })).toBeVisible();
	await expect(short.getByRole('button')).toHaveCount(0);
	await expect(short).toContainText('Short & safe');
	await long.getByRole('button', { name: 'Show more' }).click();
	await expect(long.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
	await long.getByRole('button', { name: 'Show less' }).click();
	expect(await page.evaluate(() => '__bv3Xss' in window)).toBe(false);
	await expect(long.locator('script, img')).toHaveCount(0);

	const iconLinks = page.locator('[data-test="identifier-icons"]');
	await expect(iconLinks.locator('a')).toHaveCount(4);
	await expect(iconLinks.getByText('custom: <unsafe>')).toBeVisible();
	for (const anchor of await iconLinks.locator('a').all()) {
		await expect(anchor).toHaveAttribute('target', '_blank');
		await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
		expect(new URL(await anchor.getAttribute('href') ?? '').protocol).toBe('https:');
	}
	await expect(page.locator('[data-test="identifier-chips"]')).toContainText('Google Books: 9781234567890');

	const icons = page.locator('[data-test="icons"] svg');
	await expect(icons).toHaveCount(21);
	for (const icon of await icons.all()) {
		await expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
		await expect(icon).toHaveAttribute('aria-hidden', 'true');
		await expect(icon.locator('path, circle, rect').first()).toHaveCount(1);
	}

	const changing = page.locator('[data-test="changing-cover"]');
	await expect(changing.locator('[data-generated-cover]')).toBeVisible();
	await changing.getByRole('button', { name: 'Use working cover' }).click();
	await expect(changing.getByRole('img', { name: 'Changing cover' })).toHaveAttribute('src', '/cover-good.png');
	await expect.poll(() => changing.locator('img').evaluate((image) =>
		image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
	)).toBe(true);

	const status = page.locator('[data-test="reading-status"]');
	let trigger = status.getByRole('button', { name: 'Reading status: Reading' });
	await expect(trigger.locator('svg[data-status-icon="reading"]')).toHaveClass(/text-blue-600/);
	await trigger.click();
	await expect(status.getByRole('menuitemradio')).toHaveText([
		'Reading', 'On hold', 'Read', 'Skimmed', 'Abandoned'
	]);
	await expect(status.getByRole('menuitemradio', { name: 'Reading', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(status.getByRole('menuitemradio', { name: 'On hold' })).toBeFocused();
	await page.keyboard.press('Home');
	await expect(status.getByRole('menuitemradio', { name: 'Reading', exact: true })).toBeFocused();
	await page.keyboard.press('End');
	await expect(status.getByRole('menuitemradio', { name: 'Abandoned' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();

	state.holdPush = true;
	await trigger.click();
	await status.getByRole('menuitemradio', { name: 'Read', exact: true }).click();
	await expect.poll(() => state.pushes.length).toBe(1);
	trigger = status.getByRole('button', { name: 'Reading status: Read' });
	await expect(trigger).toBeDisabled();
	await expect(trigger.locator('svg[data-status-icon="finished"]')).toHaveClass(/text-green-600/);
	await expect(trigger).toBeFocused();
	expect(state.pushes[0].data).toMatchObject({
		book_id: 21, status: 'finished', rating: 7, started_at: Date.parse('2026-01-02T03:04:05Z'),
		finished_at: expect.any(Number)
	});
	state.releasePush?.();
	await expect(trigger).toBeEnabled();
	await expect(page.locator('html')).toHaveAttribute('data-state-book', '21');

	state.pushStatus = 'rejected';
	await trigger.click();
	await expect(status.getByRole('menuitemradio', { name: 'Want to read' })).toHaveCount(0);
	await status.getByRole('menuitemradio', { name: 'Skimmed' }).click();
	await expect(status.getByRole('alert')).toContainText('Could not update reading status');
	await expect(status.getByRole('button', { name: 'Reading status: Read' })).toBeEnabled();

	state.pushStatus = 'applied';
	const newStatus = page.locator('[data-test="new-reading-status"]');
	const iconTrigger = newStatus.getByRole('button', { name: 'Reading status', exact: true });
	await expect(iconTrigger.locator('svg[data-status-icon="unread"]')).toHaveClass(/text-slate-500/);
	await iconTrigger.click();
	await newStatus.getByRole('menuitemradio', { name: 'Reading', exact: true }).click();
	await expect.poll(() => state.pushes.length).toBe(3);
	await expect(iconTrigger.locator('svg[data-status-icon="reading"]')).toHaveClass(/text-blue-600/);
	expect(state.pushes[2].data).toMatchObject({
		book_id: 23, status: 'reading', rating: null, started_at: expect.any(Number), finished_at: null
	});
	await expect(page.locator('html')).toHaveAttribute('data-state-book', '23');
});

test('positions the status badge menu at viewport edges and supports keyboard selection', async ({ page }) => {
	const state = mockState();
	await mockApi(page, state);
	await page.setViewportSize({ width: 320, height: 480 });
	await page.goto('/books');
	await mountKitFixture(page);
	const section = page.locator('[data-test="badge-reading-status"]');
	await section.evaluate((element) => {
		Object.assign(element.style, { position: 'fixed', right: '4px', bottom: '4px', zIndex: '1000' });
	});
	let badge = section.getByRole('button', { name: 'Reading status: Reading. Change' });
	const badgeBox = await badge.boundingBox();
	expect(badgeBox?.width).toBe(28);
	expect(badgeBox?.height).toBe(28);
	await badge.click();
	const menu = section.getByRole('menu', { name: 'Reading status' });
	const box = await menu.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(8);
	expect(box!.x + box!.width).toBeLessThanOrEqual(312);
	expect(box!.y).toBeGreaterThanOrEqual(8);
	expect(box!.y + box!.height).toBeLessThanOrEqual(badgeBox!.y);

	const statuses = [
		['Reading', 'reading', 'text-blue-600'], ['On hold', 'on_hold', 'text-amber-500'],
		['Read', 'finished', 'text-green-600'],
		['Skimmed', 'skimmed', 'text-sky-500'], ['Abandoned', 'abandoned', 'text-rose-600']
	] as const;
	const colors: string[] = [];
	for (const [label, value, tone] of statuses) {
		const row = menu.getByRole('menuitemradio', { name: label, exact: true });
		const icon = row.locator(`svg[data-status-icon="${value}"]`);
		await expect(icon).toHaveClass(new RegExp(tone));
		await expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
		await expect(icon).toHaveAttribute('aria-hidden', 'true');
		await expect(icon.locator('path, rect')).not.toHaveCount(0);
		colors.push(await icon.evaluate((element) => getComputedStyle(element).color));
		await expect(row).toHaveAttribute('aria-checked', value === 'reading' ? 'true' : 'false');
		await expect(row.locator('svg:not([data-status-icon])')).toHaveCount(value === 'reading' ? 1 : 0);
	}
	expect(new Set(colors).size).toBe(statuses.length);
	await page.keyboard.press('End');
	const last = menu.getByRole('menuitemradio', { name: 'Abandoned' });
	await expect(last).toBeFocused();
	expect(await last.evaluate((element) => {
		const probe = document.createElement('span');
		probe.style.backgroundColor = 'var(--color-slate-100)';
		element.append(probe);
		const matches = getComputedStyle(element).backgroundColor === getComputedStyle(probe).backgroundColor;
		probe.remove();
		return matches;
	})).toBe(true);
	await page.keyboard.press('Home');
	await expect(menu.getByRole('menuitemradio', { name: 'Reading', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(badge).toBeFocused();

	await section.evaluate((element) => {
		Object.assign(element.style, { left: '4px', top: '4px', right: 'auto', bottom: 'auto' });
	});
	await badge.click();
	const topBox = await menu.boundingBox();
	const topBadge = await badge.boundingBox();
	expect(topBox!.x).toBeGreaterThanOrEqual(8);
	expect(topBox!.y).toBeGreaterThanOrEqual(topBadge!.y + topBadge!.height);
	expect(topBox!.y + topBox!.height).toBeLessThanOrEqual(472);
	await page.setViewportSize({ width: 200, height: 240 });
	await expect.poll(async () => {
		const resized = await menu.boundingBox();
		return resized !== null && resized.x >= 8 && resized.y >= 8 &&
			resized.x + resized.width <= 192 && resized.y + resized.height <= 232;
	}).toBe(true);
	await menu.getByRole('menuitemradio', { name: 'On hold' }).click();
	await expect.poll(() => state.pushes.length).toBe(1);
	expect(state.pushes[0].data).toMatchObject({ book_id: 24, status: 'on_hold', rating: 7 });
	badge = section.getByRole('button', { name: 'Reading status: On hold. Change' });
	await expect(badge.locator('svg[data-status-icon="on_hold"]')).toHaveClass(/text-amber-500/);

	await page.setViewportSize({ width: 320, height: 480 });
	for (const [label, value, tone] of statuses) {
		if (value === 'on_hold') continue;
		await badge.click();
		await menu.getByRole('menuitemradio', { name: label, exact: true }).click();
		await expect.poll(() => state.pushes.at(-1)?.data.status).toBe(value);
		badge = section.getByRole('button', { name: `Reading status: ${label}. Change` });
		await expect(badge).toBeEnabled();
		await expect(badge.locator(`svg[data-status-icon="${value}"]`)).toHaveClass(new RegExp(tone));
	}
	expect(state.pushes).toHaveLength(statuses.length);
});

test.describe('touch devices', () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test('keeps info available, hides read, and allows tapping through to details', async ({ page }) => {
		await mockApi(page, mockState());
		await page.goto('/books');
		const generated = card(page, 'Generated Book');
		await expect(generated.locator('[data-generated-cover]')).toBeVisible();
		expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
		await expect(generated.getByRole('button', { name: 'Quick view: Generated Book' })).toBeVisible();
		await expect(generated.getByRole('button', { name: 'Reading status: Reading. Change' })).toBeVisible();
		await expect(card(page, 'PDF Book').locator('.cover-status')).toHaveCSS('opacity', '1');
		const progress = generated.getByRole('progressbar', { name: '42% read' });
		await expect(progress).toBeVisible();
		await expect(generated.locator('.cover-progress-visibility')).toHaveCSS('opacity', '1');
		const infoBox = await generated.getByRole('button', { name: 'Quick view: Generated Book' }).boundingBox();
		const progressBox = await progress.boundingBox();
		expect(infoBox!.y + infoBox!.height).toBeLessThanOrEqual(progressBox!.y);
		await expect(generated.locator('.read-button')).toBeHidden();
		await generated.getByRole('button', { name: 'Quick view: Generated Book' }).tap();
		await expect(page.locator('html')).toHaveAttribute('data-quick-book', '2');
		const listWidths = await page.evaluate(() => ({
			viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth
		}));
		expect(listWidths.content).toBeLessThanOrEqual(listWidths.viewport);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await generated.getByRole('link', { name: 'Open book details' }).tap();
		await expect(page).toHaveURL(/\/books\/2$/);
		const widths = await page.evaluate(() => ({
			viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth
		}));
		expect(widths.content).toBeLessThanOrEqual(widths.viewport);
	});
});
