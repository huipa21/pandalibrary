import { expect, test, type Page } from '@playwright/test';
import type { Wordbook, WordbookEntry } from './api.js';

const stamp = '2026-11-01T00:00:00Z';
const makeBook = (id: number, name: string, is_default = false): Wordbook => ({
	id, name, is_default, description: id === 2 ? 'Study notes' : '', entry_count: id === 1 ? 3 : 0,
	book_count: id === 1 ? 1 : 0,
	archived: false, created_at: stamp, updated_at: stamp
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

async function mockAPI(page: Page, initialBooks?: Wordbook[]) {
	let books = initialBooks ?? [makeBook(1, 'Default', true), makeBook(2, 'Study'), { ...makeBook(3, 'Travel'), description: 'Journey notebook', entry_count: 1 }];
	const entries = new Map<number, WordbookEntry[]>([[1, [makeEntry(1, 'apple'), makeEntry(2, 'Zebra'), makeEntry(3, 'A sentence.', 'sentence')]], [2, []], [3, [{ ...makeEntry(4, 'Travel phrase', 'phrase'), wordbook_id: 3 }]]]);
	let failEdits = false;
	let failEntries = false;
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
				Object.assign(book, request.postDataJSON());
				books.push(book);
				entries.set(book.id, []);
				return route.fulfill({ json: book });
			}
			return route.fulfill({ json: { wordbooks: books.map((book) => ({ ...book, entry_count: entries.get(book.id)?.length ?? 0 })) } });
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
					book.updated_at = '2100-01-01T00:00:00Z';
					return route.fulfill({ json: { imported: imported.length } });
				} catch {
					return route.fulfill({ status: 400, contentType: 'application/problem+json', json: { title: 'Invalid wordbook JSON', detail: 'Choose a valid version 1 wordbook JSON export.' } });
				}
			}
			if (!match[3]) return failEntries && id === 3
				? route.fulfill({ status: 503, contentType: 'application/problem+json', json: { title: 'Service unavailable', detail: 'Travel entries could not be loaded.' } })
				: route.fulfill({ json: { entries: entries.get(id) } });
			const entryId = Number(match[3]);
			if (method === 'DELETE') {
				entries.set(id, entries.get(id)!.filter((item) => item.id !== entryId));
				book.updated_at = '2100-01-01T00:00:00Z';
				return route.fulfill({ status: 204 });
			}
			if (failEdits) return route.fulfill({ status: 503, contentType: 'application/problem+json', json: { title: 'Service unavailable', detail: 'Please try again later.' } });
			const entry = entries.get(id)!.find((item) => item.id === entryId)!;
			Object.assign(entry, request.postDataJSON());
			book.updated_at = '2100-01-01T00:00:00Z';
			return route.fulfill({ json: entry });
		}
		if (path.startsWith('/shelves/system/')) return route.fulfill({ json: { shelf: { id: 9, name: 'Favorites', mode: 'system', system_key: 'favorites', kind: 'private', owner_id: 1, visible_book_count: 0 } } });
		return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
	});
	return { failEdits: (value: boolean) => { failEdits = value; }, failEntries: (value: boolean) => { failEntries = value; } };
}

test('overview offers five global sort orders and persistent All, Active and Archived filters', async ({ page }) => {
	await mockAPI(page, [
		{ ...makeBook(1, 'Zebra', true), created_at: '2026-11-02', updated_at: '2026-11-02' },
		{ ...makeBook(2, 'apple'), created_at: '2026-11-01', updated_at: '2026-11-04' },
		{ ...makeBook(3, 'Middle'), created_at: '2026-11-03', updated_at: '2026-11-03', archived: true }
	]);
	await page.goto('/wordbooks');
	const sort = page.getByRole('combobox', { name: 'Sort', exact: true });
	const status = page.getByRole('combobox', { name: 'Status', exact: true });
	const links = page.locator('[data-wordbooks] a');
	const expectOrder = async (ids: number[]) => {
		await expect.poll(() => links.evaluateAll((items) => items.map((item) =>
			Number(new URL((item as HTMLAnchorElement).href).searchParams.get('id'))))).toEqual(ids);
	};
	await expect(sort.locator('option')).toHaveText(['Most Recent', 'Old - New', 'New - Old', 'A - Z', 'Z - A']);
	await expect(status.locator('option')).toHaveText(['All', 'Active', 'Archived']);
	await expect(sort).toHaveValue('recent');
	await expect(status).toHaveValue('active');
	const sortBounds = await sort.boundingBox();
	const statusBounds = await status.boundingBox();
	expect(statusBounds!.x).toBeGreaterThanOrEqual(sortBounds!.x + sortBounds!.width);
	expect(statusBounds!.y).toBeCloseTo(sortBounds!.y, 0);
	await expect(page.getByRole('checkbox', { name: 'Show archived wordbooks' })).toHaveCount(0);
	await expectOrder([2, 1]);
	await status.selectOption('all');
	for (const [value, ids] of [
		['recent', [2, 3, 1]],
		['created-asc', [2, 1, 3]],
		['created-desc', [3, 1, 2]],
		['name-asc', [2, 3, 1]],
		['name-desc', [1, 3, 2]]
	] as const) {
		await sort.selectOption(value);
		await expectOrder([...ids]);
	}
	await status.selectOption('archived');
	await expectOrder([3]);
	await page.reload();
	await expect(sort).toHaveValue('name-desc');
	await expect(status).toHaveValue('archived');
	await expectOrder([3]);
	await page.getByRole('searchbox', { name: 'Search wordbook names and descriptions', exact: true }).fill('Missing notebook');
	await expectOrder([]);
	await expect(page.getByText('No matches found.', { exact: true })).toBeVisible();
	await page.getByRole('searchbox', { name: 'Search wordbook names and descriptions', exact: true }).fill('');
	await links.first().click();
	await expect(sort.locator('option')).toHaveText(['Newest first', 'Alphabetical']);
	await expect(status).toHaveCount(0);
	await page.getByRole('link', { name: 'Back to wordbooks' }).click();
	await expect(sort).toHaveValue('name-desc');
	await expect(status).toHaveValue('archived');
});

for (const operation of ['edit', 'delete', 'import'] as const) {
	test(`Most Recent refreshes authoritative notebook modification time after entry ${operation}`, async ({ page }) => {
		await mockAPI(page, [
			{ ...makeBook(1, 'Default', true), updated_at: '2026-11-01T00:00:00Z' },
			{ ...makeBook(2, 'Study'), updated_at: '2099-01-01T00:00:00Z' }
		]);
		await page.goto('/wordbooks');
		const links = page.locator('[data-wordbooks] a');
		await expect(links.first()).toHaveAttribute('href', '/wordbooks?id=2');
		await page.locator('[data-wordbooks] a[href="/wordbooks?id=1"]').click();
		const apple = page.locator('[data-entry-id="1"]');
		if (operation === 'edit') {
			await apple.getByRole('button', { name: 'Edit', exact: true }).click();
			await apple.getByLabel('Definition (editable)', { exact: true }).fill('Updated definition');
			await apple.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(apple).toContainText('Updated definition');
		} else if (operation === 'delete') {
			page.once('dialog', (dialog) => dialog.accept());
			await apple.getByRole('button', { name: 'Delete', exact: true }).click();
			await expect(apple).toHaveCount(0);
		} else {
			await page.getByLabel('Import JSON', { exact: true }).setInputFiles({
				name: 'wordbook.json', mimeType: 'application/json',
				buffer: Buffer.from(JSON.stringify({ version: 1, entries: [makeEntry(4, 'Imported')] }))
			});
			await expect(page.getByRole('main').getByRole('status')).toHaveText('Imported 1 entries');
		}
		await expect(page.getByRole('link', { name: 'Back to wordbooks' })).toBeVisible();
		await expect(page.locator('section[aria-busy]')).toHaveAttribute('aria-busy', 'false');
		await page.getByRole('link', { name: 'Back to wordbooks' }).click();
		await expect(links.first()).toHaveAttribute('href', '/wordbooks?id=1');
		await page.reload();
		await expect(links.first()).toHaveAttribute('href', '/wordbooks?id=1');
	});
}

test('wordbooks default to lists; cards, sorting, edit, archive, import/export and preferences work', async ({ page }) => {
	await mockAPI(page);
	await page.goto('/wordbooks');
	await expect(page.locator('[data-wordbooks]')).toHaveAttribute('data-view', 'cards');
	await page.locator('[data-wordbooks] a[href="/wordbooks?id=1"]').click();
	const list = page.locator('ol[data-view]');
	await expect(list).toHaveAttribute('data-view', 'list');
	await expect(list.locator('[data-entry-text]').first()).toHaveText('A sentence.');
	await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
	await page.locator('button[data-view="list"]').click();
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
	await page.getByRole('link', { name: 'Back to wordbooks' }).click();
	await expect(page.locator('[data-wordbooks] a[href="/wordbooks?id=1"] [data-entry-count]')).toHaveText('6');
	await page.locator('[data-wordbooks] a[href="/wordbooks?id=2"]').click();
	await page.getByRole('button', { name: 'Archive', exact: true }).click();
	await expect(page.locator('[data-wordbooks] a[href="/wordbooks?id=2"]')).toHaveCount(0);
	await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('all');
	await page.locator('[data-wordbooks] a[href="/wordbooks?id=2"]').click();
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
	await expect(page.locator('button[data-view]')).toHaveAttribute('data-view', 'list');
});

test('collection searches notebook descriptions and entry categories, preserving direct navigation and display settings', async ({ page }) => {
	await mockAPI(page);
	await page.goto('/wordbooks');
	const collection = page.locator('[data-wordbooks]');
	await page.getByRole('searchbox', { name: 'Search wordbook names and descriptions' }).fill('Study notes');
	await expect(collection.locator('a')).toHaveCount(1);
	await expect(collection).toContainText('Study');
	await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('lexical');
	await page.getByRole('searchbox', { name: 'Search entries' }).fill('travel phrase');
	await expect(collection.locator('a')).toHaveCount(1);
	await collection.locator('a').click();
	await expect(page).toHaveURL(/wordbooks\?id=3$/);
	await expect(page.getByText('Travel phrase', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Export JSON', exact: true })).toBeVisible();
	await expect(page.getByLabel('Import JSON', { exact: true })).toBeEnabled();
	await page.reload();
	await expect(page.getByText('Travel phrase', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Display settings', exact: true }).click();
	await page.getByLabel('Show source information', { exact: true }).uncheck();
	await expect(page.getByText('Stored book title · Chapter 2', { exact: false })).toHaveCount(0);
	await page.getByRole('link', { name: 'Back to wordbooks' }).click();
	await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('passages');
	await page.getByRole('searchbox', { name: 'Search entries' }).fill('sentence');
	await expect(collection.locator('a')).toHaveCount(1);
	await collection.locator('a').click();
	await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('lexical');
	await page.getByRole('searchbox', { name: 'Search entries' }).fill('apple');
	await expect(page.locator('[data-entry-id]')).toHaveCount(1);
});

test('new notebooks use a modal and persist their name, description and cover preset', async ({ page }) => {
	await mockAPI(page);
	await page.goto('/wordbooks');
	await page.getByRole('button', { name: 'New wordbook', exact: true }).click();
	const form = page.getByRole('form', { name: 'New wordbook', exact: true });
	const dialog = page.getByRole('dialog', { name: 'New wordbook', exact: true });
	await expect(dialog).toBeVisible();
	await expect(form.getByLabel('Wordbook name', { exact: true })).toBeFocused();
	await expect(form.getByRole('checkbox')).toHaveCount(0);
	await form.getByLabel('Wordbook name', { exact: true }).fill('New study');
	await form.getByLabel('Description (optional)', { exact: true }).fill('Optional description');
	await expect(form.getByRole('radio', { checked: true })).toHaveCount(1);
	await form.getByRole('radio', { name: 'Forest', exact: true }).check();
	const created = page.waitForRequest((request) => request.url().endsWith('/api/v1/wordbooks') && request.method() === 'POST');
	await form.getByRole('button', { name: 'Create', exact: true }).click();
	expect((await created).postDataJSON()).toEqual({ name: 'New study', description: 'Optional description', cover_color: 'forest', cover_image: '' });
	await expect(page.getByRole('heading', { name: 'New study', exact: true })).toBeVisible();
	await expect(page.getByText('Optional description', { exact: true })).toBeVisible();
	await page.reload();
	await page.getByRole('button', { name: 'Rename', exact: true }).click();
	const rename = page.getByRole('form', { name: 'Rename', exact: true });
	await expect(rename.getByRole('radio', { name: 'Forest', exact: true })).toBeChecked();
	await rename.getByLabel('Description (optional)', { exact: true }).fill('Edited description');
	await rename.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Edited description', { exact: true })).toBeVisible();
});

test('wordbook covers use book proportions, numeric badges and persistent display sizing', async ({ page }) => {
	await mockAPI(page);
	await page.goto('/wordbooks');
	const collection = page.locator('[data-wordbooks]');
	const defaultBook = collection.locator('a[href="/wordbooks?id=1"]');
	const cover = collection.locator('.book-cover').first();
	await expect(collection).toHaveClass(/book-grid-configurable/);
	await expect(defaultBook.locator('[data-entry-count]')).toHaveText('3');
	await expect(defaultBook.locator('[data-book-count]')).toHaveText('1');
	await expect(defaultBook.locator('[data-book-count] svg[data-icon="books"]')).toBeVisible();
	await expect(collection.getByRole('heading')).toHaveCount(0);
	const defaultCover = await defaultBook.locator('.book-cover').boundingBox();
	const title = await defaultBook.locator('.cover-plate').boundingBox();
	expect(defaultCover).not.toBeNull();
	expect(title).not.toBeNull();
	expect(Math.abs(title!.y + title!.height / 2 - defaultCover!.y - defaultCover!.height / 2)).toBeLessThan(1);
	let bounds = await cover.boundingBox();
	expect(bounds?.width).toBeCloseTo(208, 0);
	expect(bounds!.height / bounds!.width).toBeCloseTo(1.5, 2);
	await page.getByRole('button', { name: 'Display settings', exact: true }).click();
	await expect(page.getByLabel('Show descriptions')).toHaveCount(0);
	const size = page.getByRole('slider', { name: /Cover size/ });
	await expect(size).toHaveValue('208');
	await expect(page.getByRole('slider', { name: /Spacing/ })).toHaveValue('20');
	await size.fill('180');
	await page.getByRole('slider', { name: /Spacing/ }).fill('32');
	await page.keyboard.press('Escape');
	await page.reload();
	await expect(collection).toHaveCSS('gap', '32px');
	bounds = await cover.boundingBox();
	expect(bounds?.width).toBeCloseTo(180, 0);
	await page.getByRole('button', { name: 'Display settings', exact: true }).click();
	await expect(page.getByRole('slider', { name: /Cover size/ })).toHaveValue('180');
	await expect(page.getByRole('slider', { name: /Spacing/ })).toHaveValue('32');
});

test('wordbook modal traps focus, cancels without saving, restores focus and shows save failures in place', async ({ page }) => {
	await mockAPI(page);
	await page.goto('/wordbooks');
	const trigger = page.getByRole('button', { name: 'New wordbook', exact: true });
	const dialog = page.getByRole('dialog', { name: 'New wordbook', exact: true });
	let creates = 0;
	await page.route('**/api/v1/wordbooks', async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		creates++;
		return route.fulfill({ status: 503, contentType: 'application/problem+json', json: { title: 'Unavailable', detail: 'Please try again later.' } });
	});
	await trigger.click();
	const name = dialog.getByLabel('Wordbook name', { exact: true });
	await expect(name).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(name).toBeFocused();
	await name.fill('Discard me');
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	expect(creates).toBe(0);
	await trigger.click();
	await expect(name).toHaveValue('');
	await name.fill('Keep this draft');
	await dialog.getByRole('button', { name: 'Create', exact: true }).click();
	await expect(dialog.getByRole('alert')).toContainText('Please try again later.');
	await expect(name).toHaveValue('Keep this draft');
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(trigger).toBeFocused();
	expect(creates).toBe(1);
});

test('wordbook upload crops an image into a persistent 600 by 900 JPEG', async ({ page }) => {
	await mockAPI(page);
	await page.goto('/wordbooks');
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 1200;
		canvas.height = 900;
		const context = canvas.getContext('2d')!;
		const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
		gradient.addColorStop(0, '#ff0000');
		gradient.addColorStop(.5, '#00ff00');
		gradient.addColorStop(1, '#0000ff');
		context.fillStyle = gradient;
		context.fillRect(0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/png').split(',')[1];
	});
	await page.getByRole('button', { name: 'New wordbook', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'New wordbook', exact: true });
	await dialog.getByLabel('Wordbook name', { exact: true }).fill('Cropped cover');
	await dialog.getByLabel('Upload image', { exact: true }).setInputFiles({
		name: 'landscape.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64')
	});
	const preview = dialog.locator('.preview .book-cover img');
	await expect(preview).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
	const originalCrop = await preview.getAttribute('src');
	await dialog.getByRole('slider', { name: 'Zoom', exact: true }).fill('2');
	await dialog.getByRole('slider', { name: 'Horizontal position', exact: true }).fill('100');
	await expect(preview).not.toHaveAttribute('src', originalCrop!);
	const create = dialog.getByRole('button', { name: 'Create', exact: true });
	await expect(create).toBeEnabled();
	const cropped = await preview.getAttribute('src');
	const created = page.waitForRequest((request) => request.url().endsWith('/api/v1/wordbooks') && request.method() === 'POST');
	await create.click();
	const payload = (await created).postDataJSON();
	expect(payload.cover_image).toBe(cropped);
	expect(['navy', 'forest', 'ochre', 'khaki', 'rust', 'taupe', 'burgundy', 'slate-teal']).toContain(payload.cover_color);
	expect(Buffer.from(payload.cover_image.split(',')[1], 'base64').length).toBeLessThan(600 * 1024);
	const dimensions = await page.evaluate(async (src: string) => {
		const image = new Image();
		image.src = src;
		await image.decode();
		return { width: image.naturalWidth, height: image.naturalHeight };
	}, payload.cover_image);
	expect(dimensions).toEqual({ width: 600, height: 900 });
	await expect(page.getByRole('heading', { name: 'Cropped cover', exact: true })).toBeVisible();
	await page.reload();
	await page.getByRole('button', { name: 'Rename', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Rename', exact: true }).locator('.preview .book-cover img')).toHaveAttribute('src', payload.cover_image);
	await page.getByRole('dialog', { name: 'Rename', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.getByRole('link', { name: 'Back to wordbooks' }).click();
	await expect(page.getByRole('link', { name: 'Cropped cover', exact: true }).locator('.book-cover img')).toHaveAttribute('src', payload.cover_image);
});

test('failed crop encoding blocks saving but permits reverting and cancelling the modal', async ({ page }) => {
	await mockAPI(page);
	await page.goto('/wordbooks');
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 20;
		canvas.height = 30;
		const image = canvas.toDataURL('image/png').split(',')[1];
		HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null); };
		return image;
	});
	const trigger = page.getByRole('button', { name: 'New wordbook', exact: true });
	await trigger.click();
	const dialog = page.getByRole('dialog', { name: 'New wordbook', exact: true });
	await dialog.getByLabel('Wordbook name', { exact: true }).fill('Encoding failure');
	const upload = () => dialog.getByLabel('Upload image', { exact: true }).setInputFiles({
		name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64')
	});
	await upload();
	await expect(dialog.getByRole('alert')).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
	await dialog.getByRole('button', { name: 'Use generated cover', exact: true }).click();
	await expect(dialog.getByRole('alert')).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
	await upload();
	await expect(dialog.getByRole('alert')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test('failed entry searches report an error rather than silently omitting the notebook', async ({ page }) => {
	const api = await mockAPI(page);
	api.failEntries(true);
	await page.goto('/wordbooks');
	await expect(page.getByRole('alert')).toContainText('Travel entries could not be loaded.');
	await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('lexical');
	await page.getByRole('searchbox', { name: 'Search entries' }).fill('travel');
	await expect(page.getByRole('alert')).toContainText('Travel entries could not be loaded.');
});

test('failed edits/imports are visible, unsaved input survives, deletion requires confirmation, and mobile fits', async ({ page }) => {
	const api = await mockAPI(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/wordbooks?id=1');
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
