import { expect, test, type Page } from '@playwright/test';
import type { Book } from '#lib/catalog/types.js';
import type { Review } from '../reviews-api.js';

const stamp = '2026-11-06T10:00:00Z';

function makeBook(id: number, title: string): Book {
	return {
		owner_id: null, visibility: 'library', can_manage_visibility: false,
		id, library_id: 1, title, sort_title: title, subtitle: null, description: `${title} description`,
		language: 'en', publisher: null, published_date: null, page_count: null, cover_url: null, cover_source: null,
		authors: [{ id: 4, name: 'A Writer', role: 'author', position: 0 }],
		series: null, tags: [], identifiers: [], field_sources: [],
		files: [{ id: id * 10, format: 'epub', size_bytes: 4096, download_url: `/api/v1/books/${id}/files/${id * 10}?v=${'a'.repeat(64)}`, original_filename: 'book.epub', created_at: stamp }],
		created_at: stamp, updated_at: stamp
	};
}

const books = new Map([[21, makeBook(21, 'The Emerald Library')], [22, makeBook(22, 'Another by the Author')]]);

function review(id: number, bookId: number, authorId: number, name: string, body: string, at: number): Review {
	const time = new Date(at).toISOString();
	return { id, book_id: bookId, author: { id: authorId, display_name: name }, body, created_at: time, updated_at: time, mine: false };
}

function seed(): Review[] {
	const base = Date.now() - 60 * 60 * 1000;
	return [
		...Array.from({ length: 25 }, (_, index) =>
			review(100 + index, 21, 10 + index, `Reader ${index + 1}`, `Review number ${index + 1}`, base + index * 1000)),
		review(200, 22, 50, 'Other Book Reader', 'Only on the second book', base)
	];
}

async function setup(page: Page, role: 'user' | 'admin' = 'user') {
	const viewer = { id: 1, username: role, display_name: role === 'admin' ? 'Admin' : 'Me', role, locale: 'en' };
	const state = {
		reviews: seed(),
		nextId: 1000,
		putStatus: 200,
		puts: [] as string[],
		deletes: [] as string[],
		hold: new Map<number, PromiseWithResolvers<void>>()
	};
	await page.route('**/api/v1/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: viewer } });
		if (path === '/sync/pull') return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: [] } });
		if (path === '/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Fiction', slug: 'fiction', created_at: stamp, updated_at: stamp } } });
		if (path === '/books') {
			const items = url.searchParams.has('author_id') ? [...books.values()] : [];
			return route.fulfill({ json: { items, next_cursor: null } });
		}
		if (path === '/shelves') return route.fulfill({ json: { items: [], next_cursor: null } });
		const bookMatch = /^\/(me\/)?books\/(\d+)(\/.*)?$/.exec(path);
		const bookId = Number(bookMatch?.[2]);
		const book = books.get(bookId);
		if (!bookMatch || !book) return route.fulfill({ status: 404, json: { title: 'Unknown fixture endpoint', status: 404 } });
		const [, me, , rest = ''] = bookMatch;
		if (me) return route.fulfill({ json: { user_book: null, progress: null, highlights: [], bookmarks: [], notes: [] } });
		if (rest === '') return route.fulfill({ json: { book } });
		if (rest === '/shelves') return route.fulfill({ json: { shelves: [] } });
		if (rest === '/reviews' && request.method() === 'GET') {
			await state.hold.get(bookId)?.promise;
			const all = state.reviews.filter((item) => item.book_id === bookId);
			const mine = all.find((item) => item.author.id === viewer.id) ?? null;
			const others = all.filter((item) => item !== mine).sort((a, b) =>
				b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
			const offset = Number(url.searchParams.get('cursor') ?? 0);
			const limit = Number(url.searchParams.get('limit') ?? 20);
			return route.fulfill({ json: {
				mine: mine && { ...mine, mine: true },
				items: others.slice(offset, offset + limit),
				next_cursor: offset + limit < others.length ? String(offset + limit) : null,
				total: all.length
			} });
		}
		if (rest === '/reviews/me' && request.method() === 'PUT') {
			const { body } = request.postDataJSON() as { body: string };
			state.puts.push(body);
			if (state.putStatus !== 200) return route.fulfill({ status: state.putStatus, json: { title: 'Invalid review', status: state.putStatus } });
			const now = new Date(Date.now() + state.puts.length * 1000).toISOString();
			const existing = state.reviews.find((item) => item.book_id === bookId && item.author.id === viewer.id);
			const saved: Review = existing
				? { ...existing, body, updated_at: now }
				: { id: state.nextId++, book_id: bookId, author: { id: viewer.id, display_name: viewer.display_name }, body, created_at: now, updated_at: now, mine: true };
			state.reviews = [...state.reviews.filter((item) => item !== existing), saved];
			return route.fulfill({ json: { review: { ...saved, mine: true } } });
		}
		if (rest === '/reviews/me' && request.method() === 'DELETE') {
			state.deletes.push(path);
			state.reviews = state.reviews.filter((item) => !(item.book_id === bookId && item.author.id === viewer.id));
			return route.fulfill({ status: 204 });
		}
		const byId = /^\/reviews\/(\d+)$/.exec(rest);
		if (byId && request.method() === 'DELETE') {
			state.deletes.push(path);
			if (role !== 'admin') return route.fulfill({ status: 403, json: { title: 'Forbidden', status: 403 } });
			state.reviews = state.reviews.filter((item) => item.id !== Number(byId[1]));
			return route.fulfill({ status: 204 });
		}
		return route.fulfill({ status: 404, json: { title: 'Unknown fixture endpoint', status: 404 } });
	});
	return state;
}

const reviewsCard = (page: Page) => page.getByRole('region', { name: 'Reviews', exact: true });

test('writes, edits and deletes my pinned review with the Plus button', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/books/21');
	const card = reviewsCard(page);
	await expect(page.getByRole('region', { name: 'Overview', exact: true })).toContainText('The Emerald Library description');
	await expect(card.locator('[data-review-total]')).toHaveText('25');
	const plus = card.getByRole('button', { name: 'Write a review', exact: true });
	await expect(plus).toHaveCSS('width', '32px');

	await plus.click();
	const field = card.getByRole('textbox', { name: 'Your review', exact: true });
	await expect(field).toBeFocused();
	await expect(plus).toHaveCount(0);
	await card.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(plus).toBeFocused();

	await plus.click();
	await field.fill('My first thoughts.\nSecond line.');
	await expect(card.getByText('31 / 10,000 characters')).toBeVisible();
	await card.getByRole('button', { name: 'Save', exact: true }).click();
	const mine = card.getByRole('article', { name: 'Your review', exact: true });
	await expect(mine).toContainText('My first thoughts.');
	await expect(mine.getByText('You', { exact: true })).toBeVisible();
	await expect(mine).not.toContainText('edited');
	await expect(card.getByRole('article').first()).toHaveAccessibleName('Your review');
	await expect(plus).toHaveCount(0);
	await expect(card.locator('[data-review-total]')).toHaveText('26');
	const created = await mine.locator('time').getAttribute('datetime');

	await mine.getByRole('button', { name: 'Edit your review', exact: true }).click();
	await expect(field).toHaveValue('My first thoughts.\nSecond line.');
	await field.fill('Changed my mind.');
	await card.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(mine).toContainText('Changed my mind.');
	await expect(mine).toContainText('· edited');
	await expect(mine.locator('time')).toHaveAttribute('datetime', created ?? '');
	await expect(card.locator('[data-review-total]')).toHaveText('26');
	expect(state.puts).toEqual(['My first thoughts.\nSecond line.', 'Changed my mind.']);

	page.once('dialog', (dialog) => dialog.dismiss());
	await mine.getByRole('button', { name: 'Delete your review', exact: true }).click();
	await expect(mine).toBeVisible();
	expect(state.deletes).toEqual([]);
	page.once('dialog', async (dialog) => {
		expect(dialog.message()).toBe('Delete this review? This cannot be undone.');
		await dialog.accept();
	});
	await mine.getByRole('button', { name: 'Delete your review', exact: true }).click();
	await expect(mine).toHaveCount(0);
	await expect(plus).toBeFocused();
	await expect(card.locator('[data-review-total]')).toHaveText('25');
	expect(state.deletes).toEqual(['/books/21/reviews/me']);
});

test('lists other reviews newest first and pages with Show more reviews', async ({ page }) => {
	await setup(page);
	await page.goto('/books/21');
	const card = reviewsCard(page);
	const articles = card.getByRole('article');
	await expect(articles).toHaveCount(20);
	await expect(articles.first()).toHaveAccessibleName('Reader 25');
	await expect(articles.nth(19)).toHaveAccessibleName('Reader 6');
	await expect(card.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await card.getByRole('button', { name: 'Show more reviews', exact: true }).click();
	await expect(articles).toHaveCount(25);
	await expect(articles.last()).toHaveAccessibleName('Reader 1');
	await expect(card.getByRole('button', { name: 'Show more reviews' })).toHaveCount(0);
	const names = await articles.evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
	expect(new Set(names).size).toBe(25);
});

test('lets an administrator delete another user\'s review', async ({ page }) => {
	const state = await setup(page, 'admin');
	await page.goto('/books/21');
	const card = reviewsCard(page);
	const target = card.getByRole('article', { name: 'Reader 25', exact: true });
	page.once('dialog', (dialog) => dialog.accept());
	await target.getByRole('button', { name: 'Delete review by Reader 25', exact: true }).click();
	await expect(target).toHaveCount(0);
	await expect(card.getByRole('heading', { name: 'Reviews' })).toBeFocused();
	await expect(card.locator('[data-review-total]')).toHaveText('24');
	expect(state.deletes).toEqual(['/books/21/reviews/124']);
});

test('shows a validation message when the server rejects a review', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/books/21');
	const card = reviewsCard(page);
	state.putStatus = 400;
	await card.getByRole('button', { name: 'Write a review', exact: true }).click();
	const field = card.getByRole('textbox', { name: 'Your review', exact: true });
	await field.fill('Rejected review');
	await card.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(card.getByRole('alert')).toHaveText('A review must contain 1 to 10,000 characters.');
	await expect(field).toHaveValue('Rejected review');
	await expect(field).toBeFocused();

	state.putStatus = 500;
	await card.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(card.getByRole('alert')).toHaveText('Could not save your review. Please try again.');
});

test('aborts a stale list when switching books and never mixes reviews', async ({ page }) => {
	const state = await setup(page);
	const held = Promise.withResolvers<void>();
	state.hold.set(21, held);
	await page.goto('/books/21');
	const card = reviewsCard(page);
	await expect(card.getByRole('status')).toHaveText('Loading reviews…');
	await page.getByRole('region', { name: 'Related books' }).getByTitle('Another by the Author', { exact: true }).click();
	await expect(page).toHaveURL('/books/22');
	await expect(card.getByRole('article')).toHaveCount(1);
	await expect(card.getByRole('article').first()).toHaveAccessibleName('Other Book Reader');
	await expect(card.locator('[data-review-total]')).toHaveText('1');

	held.resolve();
	await page.waitForTimeout(300);
	await expect(card.getByRole('article')).toHaveCount(1);
	await expect(card.getByRole('article').first()).toHaveAccessibleName('Other Book Reader');
	await expect(card.locator('[data-review-total]')).toHaveText('1');
});

test('keeps long reviews inside the card without horizontal scroll at 360 px', async ({ page }) => {
	const state = await setup(page);
	state.reviews.push(review(300, 21, 99, 'Long'.repeat(20), 'x'.repeat(2000), Date.now()));
	await page.setViewportSize({ width: 360, height: 800 });
	await page.goto('/books/21');
	const long = reviewsCard(page).getByRole('article').first();
	await expect(long).toContainText('xxxx');
	const dimensions = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		content: document.documentElement.scrollWidth
	}));
	expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
	await expect(long.getByRole('button', { name: 'Show more', exact: true })).toBeVisible();
});

test('localizes the reviews card in Chinese', async ({ page }) => {
	await setup(page);
	await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { user: { id: 1, username: 'user', display_name: '我', role: 'user', locale: 'zh' } } }));
	await page.goto('/books/21');
	await expect(page.getByRole('heading', { name: '简介', exact: true })).toBeVisible();
	const card = page.getByRole('region', { name: '书评', exact: true });
	await expect(card.getByRole('button', { name: '撰写书评', exact: true })).toBeVisible();
	await expect(card.getByRole('button', { name: '显示更多书评', exact: true })).toBeVisible();
});
