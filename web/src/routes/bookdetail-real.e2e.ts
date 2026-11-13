import { expect, request, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { spawn } from 'node:child_process';
import { argon2Sync, createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Book } from '../lib/catalog/types.js';
import { pdfFixture } from '../lib/reader/fixtures.js';
import { signInRealAdmin } from '../lib/real-auth.js';
import { openedPdf, pdfPageBox } from '../lib/real-pdf.js';
import { push, uuidv7 } from '../lib/real-fixtures.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled real server');
test.use({ serviceWorkers: 'block' });

async function checked(response: Awaited<ReturnType<APIRequestContext['get']>>, status = 200) {
	expect(response.status(), await response.text()).toBe(status);
	return response;
}

async function upload(api: APIRequestContext, libraryID: number, name: string): Promise<Book> {
	const bytes = Buffer.concat([pdfFixture(), Buffer.from(`%${randomUUID()}\n`)]);
	const response = await checked(await api.post('/api/v1/uploads', {
		multipart: { library_id: String(libraryID), file: { name: `${name}.pdf`, mimeType: 'application/pdf', buffer: bytes } }
	}), 202);
	const { job } = await response.json() as { job: { id: number } };
	let bookID = 0;
	await expect.poll(async () => {
		const response = await checked(await api.get('/api/v1/imports?limit=100'));
		const { items } = await response.json() as { items: Array<{ id: number; status: string; book_id: number | null }> };
		const item = items.find((item) => item.id === job.id);
		if (item?.status === 'failed') throw new Error(`BD8 import failed: ${JSON.stringify(item)}`);
		bookID = item?.book_id ?? 0;
		return item?.status;
	}, { timeout: 30_000 }).toBe('imported');
	const result = await checked(await api.get(`/api/v1/books/${bookID}`));
	return (await result.json() as { book: Book }).book;
}

async function seed(page: Page) {
	await signInRealAdmin(page);
	const suffix = randomUUID().slice(0, 8);
	const libraryResponse = await checked(await page.request.post('/api/v1/admin/libraries', {
		data: { name: `BD8 ${suffix}`, slug: `bd8-${suffix}` }
	}), 201);
	const { library } = await libraryResponse.json() as { library: { id: number } };
	const book = await upload(page.request, library.id, `BD8 The Emerald Library ${suffix}`);
	const other = await upload(page.request, library.id, `BD8 Another Journey ${suffix}`);
	const shelfResponse = await checked(await page.request.post('/api/v1/shelves', {
		data: { kind: 'shared', mode: 'manual', name: `BD8 Shared ${suffix}` }
	}), 201);
	const { shelf } = await shelfResponse.json() as { shelf: { id: number; name: string } };
	await checked(await page.request.put(`/api/v1/shelves/${shelf.id}/books/${book.id}`, { data: {} }));
	await push(page.request, [{
		entity: 'user_settings', key: 'dashboard.layout.v1', op: 'upsert', updated_at: Date.now(),
		data: { value: { version: 1, sections: [{ id: 'continue_reading' }, { id: 'recently_added' }] } }
	}]);
	return { book, other, library, shelf };
}

const back = (page: Page) => page.getByRole('navigation', { name: 'Book sections' }).locator('a').first();
const reviews = (page: Page) => page.getByRole('region', { name: 'Reviews', exact: true });
const heroStatus = (page: Page) => page.getByRole('main').locator('header').getByRole('button', { name: /^Reading status:/ });
const tile = (scope: Page | Locator, title: string) => scope.locator('li').filter({
	has: ('goto' in scope ? scope : scope.page()).getByTitle(title, { exact: true })
}).first();

async function progress(api: APIRequestContext, book: Book, percentage: number) {
	await push(api, [{
		entity: 'reading_progress', id: String(book.id), op: 'upsert', updated_at: Date.now(),
		data: { book_id: book.id, book_file_id: book.files[0].id, source: 'web', percentage,
			locator: { type: 'pdf', page: percentage > 0 ? 2 : 1 }, device: 'BD8 browser', device_id: 'bd8' }
	}]);
}

async function state(api: APIRequestContext, bookID: number) {
	const response = await checked(await api.get(`/api/v1/me/books/${bookID}`));
	return await response.json() as {
		user_book: { status: string; started_at: string | null };
		progress: { percentage: number; locator: unknown };
		notes: Array<{ body_md: string }>;
	};
}

async function setStatus(page: Page, label: string) {
	await heroStatus(page).click();
	await page.getByRole('menuitemradio', { name: label, exact: true }).click();
	await expect(heroStatus(page)).toHaveAccessibleName(`Reading status: ${label}`);
}

async function writeReview(page: Page, body: string) {
	await reviews(page).getByRole('button', { name: 'Write a review', exact: true }).click();
	await reviews(page).getByRole('textbox', { name: 'Your review', exact: true }).fill(body);
	await reviews(page).getByRole('button', { name: 'Save', exact: true }).click();
	await expect(reviews(page).getByText(body, { exact: true })).toBeVisible();
}

test('BD8 R1-R13: origins, memberships, lifecycle, public reviews and private notes', async ({ page, browser }) => {
	test.setTimeout(240_000);
	const data = await seed(page);
	const bookPath = `/books/${data.book.id}`;
	await progress(page.request, data.book, 0.07);

	await test.step('R4: reader and metadata child flows preserve each entry list', async () => {
		for (const origin of ['/', '/books?sort=added', `/shelves/${data.shelf.id}`]) {
			await page.goto(origin);
			const scope = origin === '/' ? page.locator('[data-dashboard-section="recently_added"]') : page;
			await tile(scope, data.book.title).getByTitle(data.book.title, { exact: true }).click();
			await expect(page).toHaveURL(bookPath);
			const context = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pandalibrary.browse-context') ?? 'null')) as { href: string; ids: number[] };
			await expect(back(page)).toHaveAttribute('href', origin);
			expect(context.href).toBe(origin);
			expect(context.ids).toContain(data.book.id);
			await page.getByRole('button', { name: 'Resume', exact: true }).click();
			await expect(page).toHaveURL(`/read/${data.book.id}/${data.book.files[0].id}`);
			await openedPdf(page);
			await page.getByRole('button', { name: 'Close reader', exact: true }).click();
			await expect(page).toHaveURL(bookPath);
			await expect(back(page)).toHaveAttribute('href', origin);
			await page.getByRole('region', { name: 'Details', exact: true }).getByRole('link', { name: 'Edit metadata' }).click();
			await expect(page).toHaveURL(`${bookPath}/edit`);
			await page.getByRole('link', { name: 'Back to book', exact: true }).click();
			await expect(back(page)).toHaveAttribute('href', origin);
			if (origin.startsWith('/shelves/')) {
				await expect(page.getByRole('button', { name: 'Next book' })).toBeDisabled();
				await expect(page.getByRole('button', { name: 'Previous book' })).toBeDisabled();
			} else {
				const index = context.ids.indexOf(data.book.id);
				const next = context.ids[index + 1] ?? context.ids[index - 1];
				if (next !== undefined) {
					await page.getByRole('button', { name: context.ids[index + 1] === next ? 'Next book' : 'Previous book' }).click();
					await expect(page).toHaveURL(`/books/${next}`);
					await expect(back(page)).toHaveAttribute('href', origin);
				}
			}
			await back(page).click();
			await expect(page).toHaveURL(origin);
		}
	});

	const username = `bd8-reader-${randomUUID().slice(0, 8)}`;
	const password = 'bd8-reader-test-password';
	const userResponse = await checked(await page.request.post('/api/v1/admin/users', {
		data: { username, display_name: 'BD8 Reader', password, role: 'user', locale: 'en' }
	}), 201);
	const { user } = await userResponse.json() as { user: { id: number } };
	await checked(await page.request.put(`/api/v1/admin/libraries/${data.library.id}/access/${user.id}`, { data: {} }));
	const context = await browser.newContext({ baseURL: new URL(page.url()).origin, serviceWorkers: 'block' });
	try {
		const reader = await context.newPage();
		await reader.goto('/login');
		await reader.getByLabel('Username', { exact: true }).fill(username);
		await reader.getByLabel('Password', { exact: true }).fill(password);
		await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(reader).toHaveURL('/');

		await test.step('R1/R2: private and Favorites membership deletion persists; shared is read-only', async () => {
			const response = await checked(await reader.request.post('/api/v1/shelves', {
				data: { kind: 'private', mode: 'manual', name: 'BD8 Private' }
			}), 201);
			const { shelf } = await response.json() as { shelf: { id: number } };
			await reader.goto(bookPath);
			await expect(reader.locator(`[data-shelf-id="${data.shelf.id}"]`)).toBeVisible();
			await expect(reader.locator(`[data-shelf-id="${data.shelf.id}"] button`)).toHaveCount(0);
			for (const name of ['BD8 Private', 'Favorites']) {
				await reader.getByRole('button', { name: 'Add to collection', exact: true }).click();
				await reader.getByRole('dialog', { name: 'Add to collection' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
				const tag = reader.locator('.shelf-chip').filter({ has: reader.getByRole('link', { name, exact: true }) });
				await expect(tag).toBeVisible();
				await reader.reload();
				await expect(tag).toBeVisible();
				await tag.hover();
				reader.once('dialog', (dialog) => dialog.accept());
				await tag.getByRole('button', { name: `Remove from ${name}`, exact: true }).click();
				await expect(tag).toHaveCount(0);
				await reader.reload();
				await expect(tag).toHaveCount(0);
			}
			const responseAfter = await checked(await reader.request.get(`/api/v1/books/${data.book.id}/shelves`));
			const { shelves } = await responseAfter.json() as { shelves: Array<{ id: number }> };
			expect(shelves.some((item) => item.id === shelf.id)).toBe(false);
		});

		await test.step('R3/R5-R9/R11/R13: assembled Details layout and permission gate', async () => {
			await page.goto(bookPath);
			const details = page.getByRole('region', { name: 'Details', exact: true });
			await expect(details.getByRole('link', { name: 'Edit metadata' })).toHaveAttribute('href', `${bookPath}/edit`);
			await expect(details.getByText('Metadata source', { exact: true })).toBeVisible();
			expect(data.book.field_sources.length).toBeGreaterThan(0);
			await details.getByText('Show fields', { exact: true }).click();
			for (const source of data.book.field_sources) {
				await expect(details.getByText(`${source.field}: ${source.source}`, { exact: false })).toBeVisible();
			}
			for (const name of ['Metadata sources', 'Your reading', 'Synopsis']) {
				await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
			}
			await expect(page.getByRole('link', { name: 'Back to library', exact: true })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Edit metadata', exact: true })).toHaveCount(0);
			await expect(page.getByRole('link', { name: 'Personal review', exact: true })).toHaveCount(0);
			await expect(page.getByRole('main').locator('header [aria-label^="Formats:"]')).toHaveCount(0);
			await expect(heroStatus(page)).toHaveCSS('border-top-width', '0px');
			await expect(heroStatus(page)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
			await expect(page.getByRole('link', { name: 'Activities', exact: true })).toBeVisible();
			await expect(reader.getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
		});

		await test.step('R10: automatic status, manual hold, re-read reset and new attempt', async () => {
			await progress(reader.request, data.book, 0.07);
			await reader.reload();
			await expect(heroStatus(reader)).toHaveAccessibleName('Reading status: Reading');
			await reader.goto('/');
			await expect(tile(reader.locator('[data-dashboard-section="continue_reading"]'), data.book.title)
				.getByRole('button', { name: 'Reading status: Reading. Change' })).toBeVisible();
			await progress(reader.request, data.book, 0.995);
			await reader.goto(bookPath);
			await expect(heroStatus(reader)).toHaveAccessibleName('Reading status: Read');
			await setStatus(reader, 'On hold');
			await expect.poll(async () => (await state(reader.request, data.book.id)).user_book.status).toBe('on_hold');
			await progress(reader.request, data.book, 0.5);
			await reader.reload();
			await expect(heroStatus(reader)).toHaveAccessibleName('Reading status: On hold');
			await setStatus(reader, 'Read');
			await expect.poll(async () => (await state(reader.request, data.book.id)).user_book.status).toBe('finished');
			const old = Date.now() - 86_400_000;
			const session = (start: number, from: number, to: number) => ({
				entity: 'reading_sessions', id: uuidv7(start), op: 'upsert', updated_at: start + 60_000,
				data: { book_id: data.book.id, source: 'web', device: 'BD8', started_at: start,
					ended_at: start + 60_000, active_seconds: 60, start_percentage: from, end_percentage: to }
			});
			await push(reader.request, [session(old, 0, 0.995)]);
			await setStatus(reader, 'Re-reading');
			await expect.poll(async () => (await state(reader.request, data.book.id)).progress).toMatchObject({ percentage: 0, locator: null });
			await reader.reload();
			await expect(heroStatus(reader)).toHaveAccessibleName('Reading status: Re-reading');
			const editions = reader.getByRole('region', { name: 'Editions', exact: true });
			await expect(editions.getByText('0%', { exact: true })).toBeVisible();
			await expect(editions.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
			await reader.getByRole('button', { name: 'Read', exact: true }).click();
			await expect(reader).toHaveURL(`/read/${data.book.id}/${data.book.files[0].id}`);
			await openedPdf(reader);
			await expect(pdfPageBox(reader)).toHaveValue('1');
			await expect(reader.getByLabel('Progress 0.00%', { exact: true })).toBeVisible();
			await reader.getByRole('button', { name: 'Close reader', exact: true }).click();
			await expect(reader).toHaveURL(bookPath);
			await push(reader.request, [session(Date.now() - 1000, 0, 0.1)]);
			await reader.getByRole('link', { name: 'Activities', exact: true }).click();
			await expect(reader.getByText('Attempt 2', { exact: false }).first()).toBeVisible();
			const summary = await checked(await reader.request.get(`/api/v1/me/books/${data.book.id}/reading-summary?timezone=UTC`));
			expect((await summary.json() as { summary: { attempts: unknown[] } }).summary.attempts).toHaveLength(2);

			const appResponse = await checked(await reader.request.post('/api/v1/me/app-passwords', {
				data: { kind: 'kosync', label: 'BD8 KOReader' }
			}), 201);
			const { app_password } = await appResponse.json() as { app_password: { secret: string } };
			const file = await checked(await reader.request.get(data.other.files[0].download_url));
			const document = createHash('md5').update(await file.body()).digest('hex');
			const key = createHash('md5').update(app_password.secret.replaceAll('-', '')).digest('hex');
			await checked(await reader.request.put('/kosync/syncs/progress', {
				headers: { 'X-Auth-User': username, 'X-Auth-Key': key },
				data: { document, percentage: 0.07, progress: '1', device: 'BD8 KOReader', device_id: 'bd8-ko' }
			}));
			await reader.goto(`/books/${data.other.id}`);
			await expect(heroStatus(reader)).toHaveAccessibleName('Reading status: Reading');
		});

		await test.step('R12: reviews shared and pinned, admin moderation; notes remain private', async () => {
			await page.goto(bookPath);
			await writeReview(page, 'BD8 public administrator review');
			await reader.goto(bookPath);
			await expect(reviews(reader).getByText('BD8 public administrator review', { exact: true })).toBeVisible();
			await writeReview(reader, 'BD8 public reader review');
			await expect(reviews(reader).locator('article').first()).toHaveAccessibleName('Your review');
			await push(reader.request, [{
				entity: 'notes', id: uuidv7(), op: 'upsert', updated_at: Date.now(),
				data: { book_id: data.book.id, highlight_id: null, body_md: 'BD8 STRICTLY PRIVATE BOOK NOTE' }
			}]);
			expect((await state(reader.request, data.book.id)).notes.map((note) => note.body_md)).toContain('BD8 STRICTLY PRIVATE BOOK NOTE');
			expect((await state(page.request, data.book.id)).notes.map((note) => note.body_md)).not.toContain('BD8 STRICTLY PRIVATE BOOK NOTE');
			await page.reload();
			await expect(page.getByText('BD8 STRICTLY PRIVATE BOOK NOTE', { exact: true })).toHaveCount(0);
			const readerReview = reviews(page).locator('article').filter({ hasText: 'BD8 public reader review' });
			await expect(readerReview).toBeVisible();
			page.once('dialog', (dialog) => dialog.accept());
			await readerReview.getByRole('button', { name: /^Delete review by / }).click();
			await expect(readerReview).toHaveCount(0);
			await reader.reload();
			await expect(reviews(reader).getByText('BD8 public reader review', { exact: true })).toHaveCount(0);
			await expect(reviews(reader).getByRole('button', { name: 'Write a review' })).toBeVisible();
		});
	} finally {
		await context.close();
	}
});

async function screenshot(page: Page, info: TestInfo, name: string) {
	const path = info.outputPath(`${name}.png`);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({ path, fullPage: true });
	await info.attach(name, { path, contentType: 'image/png' });
	if (process.env.PANDA_BD8_SCREENSHOTS) {
		await mkdir(process.env.PANDA_BD8_SCREENSHOTS, { recursive: true });
		await copyFile(path, join(process.env.PANDA_BD8_SCREENSHOTS, `${name}.png`));
	}
}

async function keyboardFocus(page: Page, target: Locator) {
	for (let i = 0; i < 150; i++) {
		if (await target.evaluate((node) => node === document.activeElement)) break;
		await page.keyboard.press('Tab');
	}
	await expect(target).toBeFocused();
}

async function setTheme(page: Page, theme: string) {
	await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
	if (await page.locator('html').getAttribute('data-theme') === theme) return;
	const narrow = page.viewportSize()!.width < 640;
	if (narrow) await page.getByRole('button', { name: 'Open navigation menu', exact: true }).click();
	await page.getByRole('button', { name: `Switch to ${theme} mode`, exact: true }).click();
	if (narrow) await page.keyboard.press('Escape');
	await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function contrast(control: Locator) {
	return control.evaluate((node) => {
		const color = (value: string) => {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 1;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('No canvas context');
			context.fillStyle = value;
			context.fillRect(0, 0, 1, 1);
			return [...context.getImageData(0, 0, 1, 1).data];
		};
		const luminance = (rgb: number[]) => rgb.slice(0, 3).map((v) => {
			const s = v / 255;
			return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
		}).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
		let background = [255, 255, 255, 255];
		const ancestors: Element[] = [];
		for (let element: Element | null = node; element; element = element.parentElement) ancestors.unshift(element);
		for (const element of ancestors) {
			const next = color(getComputedStyle(element).backgroundColor);
			background = next.map((v, i) => i === 3 ? 255 : v * next[3] / 255 + background[i] * (1 - next[3] / 255));
		}
		const foreground = color(getComputedStyle(node).color);
		const a = luminance(foreground), b = luminance(background);
		return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	});
}

test('BD8 visual matrix: light/dark 360/768/1440, keyboard and reduced motion', async ({ page, browser }, info) => {
	test.setTimeout(240_000);
	const data = await seed(page);
	const bookPath = `/books/${data.book.id}`;
	// Twenty-one real authors exercise the public API's twenty-item pagination.
	for (let i = 0; i < 21; i++) {
		const name = `bd8-reviewer-${randomUUID().slice(0, 8)}`;
		const created = await checked(await page.request.post('/api/v1/admin/users', {
			data: { username: name, display_name: `Reader ${i + 1}`, password: 'bd8-visual-password', role: 'user', locale: 'en' }
		}), 201);
		const { user } = await created.json() as { user: { id: number } };
		await checked(await page.request.put(`/api/v1/admin/libraries/${data.library.id}/access/${user.id}`, { data: {} }));
		const api = await request.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { Origin: new URL(page.url()).origin } });
		try {
			await checked(await api.post('/api/v1/auth/login', { data: { username: name, password: 'bd8-visual-password' } }));
			await checked(await api.put(`/api/v1/books/${data.book.id}/reviews/me`, {
				data: { body: `A thoughtful journey through a library of possibilities. Reader ${i + 1} recommends this book.` }
			}));
		} finally {
			await api.dispose();
		}
	}
	await page.goto(bookPath);
	for (const width of [360, 768, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		for (const theme of ['light', 'dark']) {
			await setTheme(page, theme);
			await page.reload();
			await expect(reviews(page).getByRole('button', { name: 'Show more reviews' })).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
			await page.evaluate(() => window.scrollTo(0, 0));
			const prefix = `bd8-${width}-${theme}`;
			await screenshot(page, info, `${prefix}-rest`);
			await keyboardFocus(page, heroStatus(page));
			expect(await contrast(heroStatus(page))).toBeGreaterThanOrEqual(3);
			await page.keyboard.press('Enter');
			await expect(page.getByRole('menuitemradio', { name: 'Unread', exact: true })).toBeFocused();
			await screenshot(page, info, `${prefix}-status`);
			await page.keyboard.press('Escape');
			await expect(heroStatus(page)).toBeFocused();
			const add = page.getByRole('button', { name: 'Add to collection', exact: true });
			await keyboardFocus(page, add);
			await page.keyboard.press('Enter');
			await expect(page.getByRole('dialog', { name: 'Add to collection' })).toBeVisible();
			await screenshot(page, info, `${prefix}-shelf`);
			await page.keyboard.press('Escape');
			await expect(add).toBeFocused();
			const tag = page.locator(`[data-shelf-id="${data.shelf.id}"]`);
			await tag.hover();
			const remove = tag.getByRole('button');
			await expect(remove).toHaveCSS('opacity', '1');
			expect(await contrast(remove)).toBeGreaterThanOrEqual(3);
			await screenshot(page, info, `${prefix}-hover`);
			await keyboardFocus(page, remove);
			page.once('dialog', (dialog) => dialog.dismiss());
			await page.keyboard.press('Enter');
			await expect(tag).toBeVisible();
			const plus = reviews(page).getByRole('button', { name: 'Write a review' });
			await keyboardFocus(page, plus);
			await page.keyboard.press('Enter');
			await expect(reviews(page).getByRole('textbox')).toBeFocused();
			await screenshot(page, info, `${prefix}-editor`);
			await reviews(page).getByRole('button', { name: 'Cancel', exact: true }).click();
			await expect(plus).toBeFocused();
			await screenshot(page, info, `${prefix}-reviews`);
			await reviews(page).getByRole('button', { name: 'Show more reviews' }).click();
			await expect(reviews(page).locator('article')).toHaveCount(21);
		}
	}
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await heroStatus(page).click();
	await expect(heroStatus(page).locator('svg').last()).toHaveCSS('transition-property', 'none');
	await page.keyboard.press('Escape');
	await keyboardFocus(page, reviews(page).getByRole('button', { name: 'Write a review' }));
	await page.keyboard.press('Enter');
	await reviews(page).getByRole('textbox').fill('BD8 keyboard review');
	await keyboardFocus(page, reviews(page).getByRole('button', { name: 'Save', exact: true }));
	await page.keyboard.press('Enter');
	const edit = reviews(page).getByRole('button', { name: 'Edit your review', exact: true });
	await expect(edit).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(reviews(page).getByRole('textbox')).toHaveValue('BD8 keyboard review');
	await keyboardFocus(page, reviews(page).getByRole('button', { name: 'Cancel', exact: true }));
	await page.keyboard.press('Enter');
	await keyboardFocus(page, reviews(page).getByRole('button', { name: 'Delete your review', exact: true }));
	page.once('dialog', (dialog) => dialog.accept());
	await page.keyboard.press('Enter');
	await expect(reviews(page).getByRole('button', { name: 'Write a review' })).toBeFocused();
	await keyboardFocus(page, back(page));
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL('/');
	const touch = await browser.newContext({
		baseURL: new URL(page.url()).origin, storageState: await page.context().storageState(),
		viewport: { width: 360, height: 900 }, hasTouch: true, isMobile: true, serviceWorkers: 'block'
	});
	try {
		const mobile = await touch.newPage();
		await mobile.goto(bookPath);
		expect(await mobile.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
		for (const theme of ['light', 'dark']) {
			await setTheme(mobile, theme);
			await expect(mobile.locator('.shelf-remove')).toHaveCSS('opacity', '1');
			await screenshot(mobile, info, `bd8-360-${theme}-touch`);
		}
	} finally {
		await touch.close();
	}
});

test('BD8 migration: copied pre-BD database backfills Reading and exposes the new revision to an old cursor', async () => {
	test.setTimeout(90_000);
	const directory = await mkdtemp(join(tmpdir(), 'pandalibrary-bd8-migration-'));
	let child: ReturnType<typeof spawn> | undefined;
	let api: APIRequestContext | undefined;
	try {
		const baseline = join(directory, 'pre-bd.db');
		const database = new DatabaseSync(baseline);
		try {
			for (const name of ['00001_init', '00002_shelf_modes', '00003_bookmarks', '00004_bookheap', '00005_reading_statuses']) {
				const text = await readFile(resolve('..', 'internal', 'db', 'migrations', `${name}.sql`), 'utf8');
				database.exec(text.split('-- +goose Up')[1].split('-- +goose Down')[0].replaceAll('-- +goose StatementBegin', '').replaceAll('-- +goose StatementEnd', ''));
			}
			const salt = Buffer.from('bd8-migration-salt');
			const hash = argon2Sync('argon2id', { message: 'bd8-migration-password', nonce: salt, parallelism: 4, tagLength: 32, memory: 65536, passes: 3 });
			const encoded = `$argon2id$v=19$m=65536,t=3,p=4$${salt.toString('base64').replaceAll('=', '')}$${hash.toString('base64').replaceAll('=', '')}`;
			database.prepare(`INSERT INTO users (id, username, password_hash, role, locale, created_at, updated_at)
				VALUES (1, 'bd8-migration', ?, 'admin', 'en', 1, 1)`).run(encoded);
			database.exec(`
				CREATE TABLE goose_db_version (id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL, is_applied INTEGER NOT NULL, tstamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
				INSERT INTO goose_db_version (version_id, is_applied) VALUES (0,1),(1,1),(2,1),(3,1),(4,1),(5,1);
				INSERT INTO libraries (id,name,slug,created_at,updated_at) VALUES (1,'BD8','bd8',1,1);
				INSERT INTO books (id,library_id,title,sort_title,created_at,updated_at) VALUES (1,1,'BD8 Migration','bd8 migration',1,1);
				INSERT INTO user_books (user_id,book_id,status,updated_at,rev) VALUES (1,1,'unread',1000,1);
				INSERT INTO reading_progress (user_id,book_id,source,percentage,updated_at,rev) VALUES (1,1,'web',0.3,2000,2);
				UPDATE sync_counter SET value=2;
			`);
		} finally {
			database.close();
		}
		const dataDir = join(directory, 'server');
		await mkdir(dataDir);
		await copyFile(baseline, join(dataDir, 'pandalibrary.db'));
		const listener = createServer();
		await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
		const address = listener.address();
		if (!address || typeof address === 'string') throw new Error('Cannot allocate migration port');
		const port = address.port;
		await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
		const origin = `http://127.0.0.1:${port}`;
		child = spawn(process.env.PANDA_E2E_BINARY!, ['serve'], {
			env: { ...process.env, PANDA_DATA_DIR: dataDir, PANDA_LISTEN: `127.0.0.1:${port}`,
				PANDA_BASE_URL: origin, PANDA_DROP_DIR: join(dataDir, 'drop'), PANDA_DROP_POLL: '0',
				PANDA_AUTO_MIGRATE: 'true', PANDA_TRUSTED_PROXIES: '' }, stdio: ['ignore', 'pipe', 'pipe']
		});
		let logs = '';
		child.stdout?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
		child.stderr?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
		await expect.poll(async () => {
			if (child?.exitCode !== null) throw new Error(`Migration server exited: ${logs}`);
			try { return (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; }
			catch (cause) {
				if (!(cause instanceof TypeError || cause instanceof DOMException)) throw cause;
				return false;
			}
		}, { timeout: 60_000 }).toBe(true);
		api = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
		await checked(await api.post('/api/v1/auth/login', { data: { username: 'bd8-migration', password: 'bd8-migration-password' } }));
		expect((await state(api, 1)).user_book.status).toBe('reading');
		const pull = await checked(await api.get('/api/v1/sync/pull?cursor=2'));
		const payload = await pull.json() as { cursor: number; user_books: Array<{ book_id: number; status: string; rev: number }> };
		expect(payload.user_books).toEqual([expect.objectContaining({ book_id: 1, status: 'reading', rev: 3 })]);
		expect(payload.cursor).toBe(3);
	} finally {
		await api?.dispose();
		if (child && child.exitCode === null && child.signalCode === null) {
			const closed = new Promise((resolve) => child!.once('close', resolve));
			child.kill();
			await closed;
		}
		await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}
});
