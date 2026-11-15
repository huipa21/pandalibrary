import { expect, test, type Page } from '@playwright/test';
import type { Wordbook, WordbookEntry } from './api.js';

const stamp = '2026-11-01T00:00:00Z';
const makeBook = (id: number, name: string, is_default = false): Wordbook => ({
	id, name, is_default, archived: false, created_at: stamp, updated_at: stamp
});
const makeEntry = (id: number, text: string, kind: WordbookEntry['kind'] = 'word'): WordbookEntry => ({
	id, wordbook_id: 1, text, kind, definition: kind === 'word' ? 'Stored definition' : '', note: '',
	created_at: `2026-11-${String(id).padStart(2, '0')}T00:00:00Z`, updated_at: stamp,
	dictionary_entries: kind === 'word' ? [{
		source: 'fixture', sourceName: 'Snapshot dictionary', headword: text,
		definitions: ['Dictionary meaning'], match: 'exact'
	}] : [],
	source: {
		book_id: kind === 'sentence' ? null : 21, book_file_id: kind === 'sentence' ? null : 31,
		book_title: 'Stored book title', chapter: 'Chapter 2',
		locator: { type: 'pdf', page: 3, rects: [{ x: .1, y: .2, width: .3, height: .04 }] }, fraction: .4
	}
});

async function mockAPI(page: Page) {
	let books = [makeBook(1, 'Default', true), makeBook(2, 'Study')];
	const entries = new Map<number, WordbookEntry[]>([[1, [makeEntry(1, 'apple'), makeEntry(2, 'Zebra'), makeEntry(3, 'A sentence.', 'sentence')]], [2, []]]);
	let failEdits = false;
	await page.route('**/api/v1/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname.replace('/api/v1', '');
		const method = request.method();
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'test', display_name: 'Test', role: 'user', locale: 'en' } } });
		if (path === '/sync/pull') return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: [] } });
		if (path === '/wordbooks') {
			if (method === 'POST') {
				const book = makeBook(books.length + 1, request.postDataJSON().name);
				books.push(book);
				entries.set(book.id, []);
				return route.fulfill({ json: book });
			}
			return route.fulfill({ json: { wordbooks: books } });
		}
		const match = /^\/wordbooks\/(\d+)(?:\/(entries|export|import)(?:\/(\d+))?)?$/.exec(path);
		if (match) {
			const id = Number(match[1]);
			const book = books.find((item) => item.id === id)!;
			if (!match[2]) {
				Object.assign(book, request.postDataJSON());
				return route.fulfill({ json: book });
			}
			if (match[2] === 'export') return route.fulfill({ json: { version: 1, wordbook: { name: book.name }, entries: entries.get(id) } });
			if (match[2] === 'import') {
				try {
					const data = JSON.parse(request.postData() ?? '');
					if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('invalid');
					const imported = data.entries.map((item: WordbookEntry, index: number) => ({ ...item, id: 100 + index, wordbook_id: id }));
					entries.set(id, [...entries.get(id)!, ...imported]);
					return route.fulfill({ json: { imported: imported.length } });
				} catch {
					return route.fulfill({ status: 400, contentType: 'application/problem+json', json: { title: 'Invalid wordbook JSON', detail: 'Choose a valid version 1 wordbook JSON export.' } });
				}
			}
			if (!match[3]) return route.fulfill({ json: { entries: entries.get(id) } });
			const entryId = Number(match[3]);
			if (method === 'DELETE') {
				entries.set(id, entries.get(id)!.filter((item) => item.id !== entryId));
				return route.fulfill({ status: 204 });
			}
			if (failEdits) return route.fulfill({ status: 503, contentType: 'application/problem+json', json: { title: 'Service unavailable', detail: 'Please try again later.' } });
			const entry = entries.get(id)!.find((item) => item.id === entryId)!;
			Object.assign(entry, request.postDataJSON());
			return route.fulfill({ json: entry });
		}
		if (path.startsWith('/shelves/system/')) return route.fulfill({ json: { shelf: { id: 9, name: 'Favorites', mode: 'system', system_key: 'favorites', kind: 'private', owner_id: 1, visible_book_count: 0 } } });
		return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
	});
	return { failEdits: (value: boolean) => { failEdits = value; } };
}

test('wordbooks default to lists; cards, sorting, edit, archive, import/export and preferences work', async ({ page }) => {
	await mockAPI(page);
	await page.goto('/wordbooks');
	const list = page.locator('ol[data-view]');
	await expect(list).toHaveAttribute('data-view', 'list');
	await expect(list.locator('[data-entry-text]').first()).toHaveText('A sentence.');
	await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Cards', exact: true }).click();
	await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('alphabetical');
	await expect(list).toHaveAttribute('data-view', 'cards');
	await expect(list.locator('[data-entry-text]').first()).toHaveText('A sentence.');
	await expect(list.locator('[data-entry-text]').nth(1)).toHaveText('apple');
	const apple = page.locator('[data-entry-id="1"]');
	await expect(apple).toContainText('Snapshot dictionary');
	const url = new URL(await apple.getByRole('link', { name: 'Read in context' }).getAttribute('href') ?? '', 'https://reader.invalid');
	expect(JSON.parse(url.searchParams.get('locator')!)).toMatchObject({ type: 'pdf', page: 3 });
	await apple.getByRole('button', { name: 'Edit', exact: true }).click();
	await apple.getByLabel('Definition (editable)', { exact: true }).fill('My definition');
	await apple.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(apple).toContainText('My definition');
	const sentence = page.locator('[data-entry-id="3"]');
	await expect(sentence).toContainText('Original source is unavailable');
	await expect(sentence).toContainText('Stored book title · Chapter 2');
	await sentence.getByRole('button', { name: 'Edit', exact: true }).click();
	await expect(sentence.getByLabel('Personal note', { exact: true })).toHaveValue('');
	await sentence.getByLabel('Personal note', { exact: true }).fill('Manual note');
	await sentence.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(sentence).toContainText('Manual note');
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('Default.json');
	const stream = await download.createReadStream();
	if (!stream) throw new Error('Export stream unavailable');
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	const exported = Buffer.concat(chunks);
	expect(JSON.parse(exported.toString()).entries[0].definition).toBe('My definition');
	await page.getByLabel('Import JSON', { exact: true }).setInputFiles({ name: 'wordbook.json', mimeType: 'application/json', buffer: exported });
	await expect(list.locator(':scope > li')).toHaveCount(6);
	await expect(page.getByRole('main').getByRole('status')).toHaveText('Imported 3 entries');
	await page.reload();
	await expect(list).toHaveAttribute('data-view', 'cards');
	await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toHaveValue('alphabetical');
	await page.getByRole('combobox', { name: 'Wordbook name', exact: true }).selectOption('2');
	await expect(list).toHaveCount(0);
	await page.getByRole('button', { name: 'Archive', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Default', exact: true })).toBeVisible();
	await expect(page.getByRole('option', { name: 'Study', exact: true })).toHaveCount(0);
	await page.getByLabel('Show archived wordbooks').check();
	await page.getByRole('combobox', { name: 'Wordbook name', exact: true }).selectOption('2');
	await expect(page.getByLabel('Import JSON', { exact: true })).toBeDisabled();
	await page.getByRole('button', { name: 'Restore from archive', exact: true }).click();
	await expect(page.getByLabel('Import JSON', { exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Rename', exact: true }).click();
	const rename = page.getByRole('form', { name: 'Rename', exact: true });
	await rename.getByLabel('Wordbook name', { exact: true }).fill('Renamed study');
	await rename.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Renamed study', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'New wordbook', exact: true }).click();
	const create = page.getByRole('form', { name: 'New wordbook', exact: true });
	await create.getByLabel('Wordbook name', { exact: true }).fill('New study');
	await create.getByRole('button', { name: 'Create', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'New study', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('failed edits/imports are visible, unsaved input survives, deletion requires confirmation, and mobile fits', async ({ page }) => {
	const api = await mockAPI(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/wordbooks');
	const apple = page.locator('[data-entry-id="1"]');
	await apple.getByRole('button', { name: 'Edit', exact: true }).click();
	await apple.getByLabel('Definition (editable)', { exact: true }).fill('Unsaved draft');
	api.failEdits(true);
	await apple.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Please try again later.');
	await expect(apple.getByLabel('Definition (editable)', { exact: true })).toHaveValue('Unsaved draft');
	api.failEdits(false);
	await apple.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(apple).toContainText('Unsaved draft');
	await page.getByLabel('Import JSON', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{') });
	await expect(page.getByRole('alert')).toContainText('Choose a valid version 1 wordbook JSON export.');
	page.once('dialog', (dialog) => dialog.dismiss());
	await apple.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(apple).toBeVisible();
	page.once('dialog', (dialog) => dialog.accept());
	await apple.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(apple).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
