import { expect, test, type Page } from '@playwright/test';
import type { WordbookEntry } from '#lib/wordbooks/api.js';

const stamp = '2026-11-01T00:00:00Z';
const books = [1, 2].map((id) => ({
	id, library_id: 1, owner_id: null, visibility: 'library', can_manage_visibility: false,
	title: `Words Book ${id}`, sort_title: `Words Book ${id}`, subtitle: null, description: null,
	language: null, publisher: null, published_date: null, page_count: null, cover_url: null,
	cover_source: null, authors: [], series: null, tags: [], identifiers: [], field_sources: [],
	files: [], created_at: stamp, updated_at: stamp
}));
const entries: WordbookEntry[] = ['word', 'phrase', 'sentence', 'passage'].map((kind, index) => ({
	id: index + 1, wordbook_id: index % 2 + 10, kind: kind as WordbookEntry['kind'],
	text: ['apple', 'in time', 'A saved sentence.', 'A saved passage.\nWith a second line.'][index],
	definition: index < 2 ? 'My saved meaning' : '', note: index >= 2 ? 'My personal note' : '',
	dictionary_entries: [], created_at: stamp, updated_at: stamp,
	source: {
		book_id: 1, book_file_id: index === 3 ? null : 21, book_title: 'Words Book 1',
		chapter: 'Chapter 3', locator: { type: 'pdf', page: 3 }, fraction: .4
	}
}));

async function mockAPI(page: Page) {
	const bookRequests = new Map<number, number>();
	const wordsRequests: number[] = [];
	let failure = false;
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/sync/pull') return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: [] } });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/books') return route.fulfill({ json: { items: books, next_cursor: null } });
		if (path === '/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Library' } } });
		if (/^\/me\/books\/\d+$/.test(path)) return route.fulfill({ json: { user_book: null, progress: null, highlights: [], bookmarks: [], notes: [] } });
		const words = /^\/books\/(\d+)\/words$/.exec(path);
		if (words) {
			const id = Number(words[1]);
			wordsRequests.push(id);
			if (failure) return route.fulfill({ status: 503, json: { title: 'Unavailable' } });
			return route.fulfill({ json: { entries: id === 1 ? entries : [] } });
		}
		const book = /^\/books\/(\d+)$/.exec(path);
		if (book) {
			const id = Number(book[1]);
			bookRequests.set(id, (bookRequests.get(id) ?? 0) + 1);
			return route.fulfill({ json: { book: books[id - 1] } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null, total: 0, mine: null } });
	});
	return { bookRequests, wordsRequests, fail: (value: boolean) => { failure = value; } };
}

const tabBar = (page: Page) => page.getByRole('navigation', { name: 'Book sections' });

test('Words shows every kind across wordbooks in a compact list with saved notes and context', async ({ page }) => {
	const api = await mockAPI(page);
	await page.goto('/books/1/words');
	await expect(page).toHaveTitle('Words Book 1 · Words');
	await expect(tabBar(page).getByRole('link', { name: 'Words', exact: true })).toHaveAttribute('aria-current', 'page');
	const list = page.locator('[data-book-words]');
	await expect(list.locator('li')).toHaveCount(4);
	for (const entry of entries) {
		const row = list.locator(`[data-entry-id="${entry.id}"]`);
		await expect(row.locator('[data-entry-text]')).toHaveText(entry.text);
		await expect(row).toContainText(entry.definition || entry.note);
		await expect(row).toContainText('Chapter 3');
		await expect(row.getByRole('link', { name: 'Open wordbook' })).toHaveAttribute('href', `/wordbooks?id=${entry.wordbook_id}`);
	}
	const context = list.locator('[data-entry-id="1"]').getByRole('link', { name: 'Read in context' });
	const href = new URL((await context.getAttribute('href'))!, 'https://library.invalid');
	expect(href.pathname).toBe('/read/1/21');
	expect(JSON.parse(href.searchParams.get('locator')!)).toEqual({ type: 'pdf', page: 3 });
	expect(href.searchParams.get('fraction')).toBe('0.4');
	await expect(list.locator('[data-entry-id="4"]')).toContainText('Original source is unavailable');
	await expect(list.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
	await tabBar(page).getByRole('link', { name: 'Files', exact: true }).click();
	await tabBar(page).getByRole('link', { name: 'Words', exact: true }).click();
	await expect(list.locator('li')).toHaveCount(4);
	expect(api.bookRequests.get(1)).toBe(1);
	expect(api.wordsRequests).toEqual([1, 1]);
});

test('Words failure is distinct from an empty book and can be retried', async ({ page }) => {
	const api = await mockAPI(page);
	api.fail(true);
	await page.goto('/books/2/words');
	await expect(page.getByRole('alert')).toContainText('Could not load saved words.');
	await expect(page.getByText('No saved words, phrases, sentences or passages for this book.')).toHaveCount(0);
	api.fail(false);
	await page.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(page.getByText('No saved words, phrases, sentences or passages for this book.')).toBeVisible();
	expect(api.wordsRequests).toEqual([2, 2]);
});

test('Words tab and neighbor navigation replace history and preserve the book-list origin', async ({ page }) => {
	const api = await mockAPI(page);
	await page.goto('/books');
	await page.getByTitle('Words Book 1', { exact: true }).first().click({ position: { x: 10, y: 40 } });
	await expect(page).toHaveURL('/books/1');
	const historyLength = await page.evaluate(() => history.length);
	await tabBar(page).getByRole('link', { name: 'Words', exact: true }).click();
	await expect(page.locator('[data-book-words] li')).toHaveCount(4);
	await page.getByRole('button', { name: 'Next book', exact: true }).click();
	await expect(page).toHaveURL('/books/2/words');
	await expect(page.getByText('No saved words, phrases, sentences or passages for this book.')).toBeVisible();
	await expect(page.locator('[data-book-words]')).toHaveCount(0);
	expect(await page.evaluate(() => history.length)).toBe(historyLength);
	await tabBar(page).getByRole('link', { name: /^Back/ }).click();
	await expect(page).toHaveURL('/books');
	expect(api.wordsRequests).toEqual([1, 2]);
});
