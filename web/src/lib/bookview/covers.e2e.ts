import { expect, test, type Page, type Route } from '@playwright/test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { build } from 'vite';

test.use({ serviceWorkers: 'block' });

const timestamp = '2026-11-04T00:00:00Z';
const longTitle = '星'.repeat(90);
const file = (id: number, format: string, bookId: number) => ({
	id, format, size_bytes: 4096,
	download_url: `/api/v1/books/${bookId}/files/${id}?v=${'a'.repeat(64)}`
});
const book = (id: number, title: string, coverUrl: string | null = null) => ({
	id, library_id: 1, title, sort_title: title, subtitle: null, description: null, language: null,
	publisher: null, published_date: null, page_count: null, cover_url: coverUrl, cover_source: null,
	authors: [{ id: 1, name: 'First Writer', role: 'author', position: 0 }],
	series: null, tags: [], identifiers: [], field_sources: [],
	files: [file(id * 100 + 1, 'pdf', id), file(id * 100 + 2, 'epub', id)],
	created_at: timestamp, updated_at: timestamp
});
const books = [
	book(2, 'Generated Book'),
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
const searchResult = { id: 70, title: 'Search Book', authors: ['Search Writer'], series: null, cover_url: null, rank: -1 };

interface MockState {
	locale: 'en' | 'zh';
	pushStatus: 'applied' | 'stale' | 'rejected';
	holdPush: boolean;
	releasePush: (() => void) | null;
	pushes: Array<{ entity: string; key?: string; data: Record<string, unknown> }>;
}

function mockState(locale: 'en' | 'zh' = 'en'): MockState {
	return { locale, pushStatus: 'applied', holdPush: false, releasePush: null, pushes: [] };
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
			return route.fulfill({ json: { results: body.mutations.map((mutation, index) => ({
				index, status: mutation.entity === 'user_books' ? state.pushStatus : 'applied'
			})) } });
		}
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (['/authors', '/series', '/tags', '/libraries', '/shelves'].includes(path)) {
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		if (path === '/books') return route.fulfill({ json: { items: books, next_cursor: null } });
		if (path === '/search') return route.fulfill({ json: { items: [searchResult], next_cursor: null } });
		const details = /^\/books\/(\d+)$/.exec(path);
		if (details) {
			const found = books.find((item) => item.id === Number(details[1]));
			return found ? route.fulfill({ json: { book: found } }) : problem(route, 404);
		}
		const progress = /^\/me\/books\/(\d+)$/.exec(path);
		if (progress) {
			const id = Number(progress[1]);
			if (id === 10) return problem(route, 503);
			return route.fulfill({ json: {
				user_book: null, highlights: [], bookmarks: [], notes: [],
				progress: id === 2 ? {
					book_file_id: 201, source: 'web', locator: null, percentage: 0.4,
					device: 'Web', device_id: 'device', updated_at: timestamp, rev: 1
				} : null
			} });
		}
		return problem(route, 404);
	});
}

function card(page: Page, title: string) {
	return page.locator('li').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();
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

test('generates accessible, contrast-checked covers and badges in grid and list modes', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	await expect(generated.locator('[data-generated-cover]')).toContainText('Generated Book');
	await expect(generated.locator('[data-generated-cover]')).toContainText('First Writer');
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
			if (!title) throw new Error('Generated cover title is missing.');
			const background = getComputedStyle(node).backgroundColor;
			const foreground = getComputedStyle(title).color;
			const first = luminance(rgb(background));
			const second = luminance(rgb(foreground));
			return { background, contrast: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) };
		});
	});
	expect(new Set(colors.map((color) => color.background)).size).toBe(8);
	for (const color of colors) expect(color.contrast).toBeGreaterThanOrEqual(4.5);

	await page.getByRole('button', { name: 'List', exact: true }).click();
	await expect(card(page, 'Generated Book').locator('[data-generated-cover]')).toBeVisible();
	await expect(card(page, 'Generated Book').getByRole('img', { name: 'Formats: EPUB, PDF' })).toBeVisible();
	await expect(page.getByText('Cover unavailable')).toHaveCount(0);
});

test('reveals keyboard and hover actions, dispatches info, and resumes the saved file', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	const overlay = generated.locator('.cover-overlay');
	await expect(generated.locator('[data-generated-cover]')).toBeVisible();
	expect(await overlay.evaluate((node) => Number(getComputedStyle(node).opacity))).toBe(0);
	await generated.locator('.cover-frame').hover();
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
	await page.keyboard.press('Tab');
	await expect(info).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(read).toBeFocused();
	await read.click();
	await expect(page).toHaveURL(/\/read\/2\/201$/);
});

test('uses the first readable fallback and reports failures without navigation', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/books');
	const failed = card(page, 'Read Failure');
	await failed.locator('.cover-frame').hover();
	await failed.getByRole('button', { name: 'Read Read Failure' }).click();
	await expect(failed.getByRole('alert')).toContainText('Could not open the reader');
	await expect(page).toHaveURL(/\/books$/);
	await expect(card(page, 'Palette Four').getByRole('button', { name: 'Read Palette Four' })).toHaveCount(0);

	const pdf = card(page, 'PDF Book');
	await pdf.locator('.cover-frame').hover();
	await pdf.getByRole('button', { name: 'Read PDF Book' }).click();
	await expect(page).toHaveURL(/\/read\/4\/401$/);
});

test('search results use generated covers and dispatch info without claiming a full book', async ({ page }) => {
	await mockApi(page, mockState());
	await page.goto('/search?q=book');
	const result = card(page, 'Search Book');
	await expect(result.locator('[data-generated-cover]')).toContainText('Search Book');
	await expect(result.locator('[data-generated-cover]')).toContainText('Search Writer');
	await expect(result.getByRole('img', { name: 'Cover of Search Book' })).toBeVisible();
	await expect(result.getByRole('img', { name: /^Formats:/ })).toHaveCount(0);
	await expect(result.getByRole('button', { name: 'Read Search Book' })).toHaveCount(0);
	await result.locator('.cover-frame').hover();
	await result.getByRole('button', { name: 'Quick view: Search Book' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-quick-book', '70');
	await expect(page.locator('html')).toHaveAttribute('data-quick-book-provided', 'false');
});

test('localizes cover actions and badges', async ({ page }) => {
	await mockApi(page, mockState('zh'));
	await page.goto('/books');
	const generated = card(page, 'Generated Book');
	await expect(generated.getByRole('img', { name: '格式：EPUB, PDF' })).toBeVisible();
	await generated.locator('.cover-frame').hover();
	await expect(generated.getByRole('button', { name: '快速查看：Generated Book' })).toBeVisible();
	await expect(generated.getByRole('button', { name: '阅读 Generated Book' })).toBeVisible();
	await mountKitFixture(page);
	await expect(page.locator('[data-test="duration"]')).toHaveText('2小时 56分钟');
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
	let trigger = status.getByRole('button', { name: 'Reading status: Re-reading' });
	await trigger.click();
	await expect(status.getByRole('menuitemradio', { name: 'Re-reading' })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(status.getByRole('menuitemradio', { name: 'Finished' })).toBeFocused();
	await page.keyboard.press('Home');
	await expect(status.getByRole('menuitemradio', { name: 'Unread' })).toBeFocused();
	await page.keyboard.press('End');
	await expect(status.getByRole('menuitemradio', { name: 'Abandoned' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();

	state.holdPush = true;
	await trigger.click();
	await status.getByRole('menuitemradio', { name: 'Finished' }).click();
	await expect.poll(() => state.pushes.length).toBe(1);
	trigger = status.getByRole('button', { name: 'Reading status: Finished' });
	await expect(trigger).toBeDisabled();
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
	await status.getByRole('menuitemradio', { name: 'Want to read' }).click();
	await expect(status.getByRole('alert')).toContainText('Could not update reading status');
	await expect(status.getByRole('button', { name: 'Reading status: Finished' })).toBeEnabled();

	state.pushStatus = 'applied';
	const newStatus = page.locator('[data-test="new-reading-status"]');
	await newStatus.getByRole('button', { name: 'Reading status', exact: true }).click();
	await newStatus.getByRole('menuitemradio', { name: 'Reading', exact: true }).click();
	await expect.poll(() => state.pushes.length).toBe(3);
	expect(state.pushes[2].data).toMatchObject({
		book_id: 23, status: 'reading', rating: null, started_at: expect.any(Number), finished_at: null
	});
	await expect(page.locator('html')).toHaveAttribute('data-state-book', '23');
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
