import { expect, test, type Page } from '@playwright/test';
import type { Wordbook, WordbookEntry } from './api.js';

const stamp = '2026-11-01T00:00:00Z';
const makeBook = (id: number, name: string, extra: Partial<Wordbook> = {}): Wordbook => ({
	id, name, description: '', language: 'en', meaning_language: '', is_default: id === 1,
	archived: false, entry_count: 0, book_count: 0, created_at: stamp, updated_at: stamp, ...extra
});
const sourceEntry: WordbookEntry = {
	id: 1, wordbook_id: 1, kind: 'word', text: 'apple', definition: 'A fruit', note: '',
	dictionary_entries: [], source: { book_id: null, book_file_id: null, book_title: '', locator: null, fraction: 0 },
	created_at: stamp, updated_at: stamp
};

async function mockAPI(page: Page, initialBooks = [
	makeBook(1, 'Default'), makeBook(2, 'Study'), makeBook(3, 'Archived', { archived: true })
]) {
	let books = initialBooks;
	const entries = new Map<number, WordbookEntry[]>(books.map((book) => [book.id, book.id === 1 ? [sourceEntry] : []]));
	const deletes: { id: number; body: unknown }[] = [];
	const patches: Record<string, unknown>[] = [];
	const entryReads: number[] = [];
	let failDelete = false;
	let failSave = false;
	await page.route('**/api/v1/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname.replace('/api/v1', '');
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'test', display_name: 'Test', role: 'user', locale: 'en' } } });
		if (path === '/sync/pull') return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: [] } });
		if (path === '/wordbooks') return route.fulfill({ json: { wordbooks: books.map((book) => ({ ...book, entry_count: entries.get(book.id)?.length ?? 0 })) } });
		const match = /^\/wordbooks\/(\d+)(\/entries)?$/.exec(path);
		if (match) {
			const id = Number(match[1]);
			if (match[2]) {
				entryReads.push(id);
				return route.fulfill({ json: { entries: entries.get(id) ?? [] } });
			}
			if (request.method() === 'DELETE') {
				const body = request.postData() ? request.postDataJSON() as { merge_into_id: number } : null;
				deletes.push({ id, body });
				if (failDelete) return route.fulfill({ status: 503, contentType: 'application/problem+json', json: { title: 'Unavailable', detail: 'Deletion failed. Try again.' } });
				if (body) entries.set(body.merge_into_id, [...entries.get(body.merge_into_id)!, ...entries.get(id)!.map((entry) => ({ ...entry, wordbook_id: body.merge_into_id }))]);
				const wasDefault = books.find((book) => book.id === id)?.is_default;
				books = books.filter((book) => book.id !== id);
				if (wasDefault) {
					const next = books.find((book) => book.id === body?.merge_into_id) ?? books[0];
					next.is_default = true;
					next.archived = false;
				}
				entries.delete(id);
				return route.fulfill({ status: 204 });
			}
			const patch = request.postDataJSON() as Record<string, unknown>;
			patches.push(patch);
			if (failSave) return route.fulfill({ status: 503, contentType: 'application/problem+json', json: { title: 'Unavailable', detail: 'Settings could not be saved.' } });
			const book = books.find((item) => item.id === id)!;
			Object.assign(book, patch);
			return route.fulfill({ json: book });
		}
		if (path.startsWith('/shelves/system/')) return route.fulfill({ json: { shelf: { id: 9, name: 'Favorites', mode: 'system', system_key: 'favorites', kind: 'private', owner_id: 1, visible_book_count: 0 } } });
		return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
	});
	return { deletes, patches, entryReads, failDelete: (value: boolean) => { failDelete = value; }, failSave: (value: boolean) => { failSave = value; } };
}

test('settings gear follows view toggle only inside a book; edits persist and unspecified meaning is preserved', async ({ page }) => {
	const api = await mockAPI(page);
	await page.goto('/wordbooks');
	await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
	await page.locator('[data-wordbooks] a[href="/wordbooks?id=1"]').click();
	const gear = page.getByRole('button', { name: 'Settings', exact: true });
	await expect(gear).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
	expect(await gear.evaluate((element) => (
		element === element.parentElement?.firstElementChild
		&& element.parentElement.previousElementSibling?.matches('button[data-view]')
	))).toBe(true);
	await gear.click();
	const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
	await expect(dialog.getByLabel('Wordbook name', { exact: true })).toBeFocused();
	await expect(dialog.getByLabel('Language', { exact: true })).toHaveValue('en');
	const meanings = dialog.getByRole('group', { name: 'Meaning language', exact: true });
	await expect(meanings.getByRole('checkbox')).toHaveCount(3);
	await expect(meanings.getByRole('checkbox', { checked: true })).toHaveCount(0);
	await expect(meanings).toContainText('Not specified');
	await expect(dialog.getByRole('button', { name: 'Delete wordbook', exact: true })).toHaveCount(0);
	await dialog.getByLabel('Wordbook name', { exact: true }).fill('My words');
	await dialog.getByLabel('Description (optional)', { exact: true }).fill('Personal notes');
	await dialog.getByRole('radio', { name: 'Forest', exact: true }).check();
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog).not.toBeVisible();
	expect(api.patches.at(-1)).toMatchObject({ name: 'My words', description: 'Personal notes', language: 'en', meaning_languages: [], cover_color: 'forest' });
	expect(api.patches.at(-1)).not.toHaveProperty('meaning_language');
	await gear.click();
	await dialog.getByLabel('Language', { exact: true }).selectOption('ja');
	await meanings.getByRole('checkbox', { name: 'Japanese–Chinese (Simplified)' }).check();
	await meanings.getByRole('checkbox', { name: 'Japanese–English' }).check();
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	expect(api.patches.at(-1)?.meaning_languages).toEqual(expect.arrayContaining(['en', 'zh']));
	expect(api.patches.at(-1)?.meaning_languages).toHaveLength(2);
	await page.reload();
	await gear.click();
	await expect(dialog.getByLabel('Language', { exact: true })).toHaveValue('ja');
	await expect(meanings.getByRole('checkbox', { name: 'Japanese–Chinese (Simplified)' })).toBeChecked();
	await expect(meanings.getByRole('checkbox', { name: 'Japanese–English' })).toBeChecked();
	await expect(meanings.getByRole('checkbox', { name: 'Japanese–Japanese' })).not.toBeChecked();
	await expect(dialog.getByRole('radio', { name: 'Forest', exact: true })).toBeChecked();
	await page.keyboard.press('Escape');
	await expect(dialog).not.toBeVisible();
	await expect(gear).toBeFocused();
});

test('settings preserves regional language tags and reports failed saves without closing', async ({ page }) => {
	const api = await mockAPI(page, [makeBook(1, 'Regional', { language: 'en-GB', meaning_language: 'zh-Hant' }), makeBook(2, 'Study')]);
	await page.goto('/wordbooks?id=1');
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
	await expect(dialog.getByLabel('Language', { exact: true })).toHaveValue('en-GB');
	const regional = dialog.getByRole('checkbox', { name: 'English–zh-Hant' });
	await expect(regional).toBeChecked();
	await regional.uncheck();
	await regional.check();
	api.failSave(true);
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog.getByRole('alert')).toContainText('Settings could not be saved.');
	api.failSave(false);
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog).not.toBeVisible();
	expect(api.patches.at(-1)).toMatchObject({ language: 'en-GB', meaning_languages: ['zh-Hant'] });
});

test('new meaning language array takes precedence over legacy preference and preserves custom languages', async ({ page }) => {
	const api = await mockAPI(page, [makeBook(1, 'Custom', { meaning_language: 'ja', meaning_languages: ['fr', 'zh-Hant'] })]);
	await page.goto('/wordbooks?id=1');
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
	const meanings = dialog.getByRole('group', { name: 'Meaning language', exact: true });
	await expect(meanings.getByRole('checkbox', { name: 'English–fr' })).toBeChecked();
	await expect(meanings.getByRole('checkbox', { name: 'English–zh-Hant' })).toBeChecked();
	await expect(meanings.getByRole('checkbox', { name: 'English–Japanese' })).not.toBeChecked();
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	expect(api.patches.at(-1)?.meaning_languages).toEqual(expect.arrayContaining(['fr', 'zh-Hant']));
	expect(api.patches.at(-1)?.meaning_languages).toHaveLength(2);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await meanings.getByRole('checkbox', { name: 'English–fr' }).uncheck();
	await meanings.getByRole('checkbox', { name: 'English–zh-Hant' }).uncheck();
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	expect(api.patches.at(-1)?.meaning_languages).toEqual([]);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(meanings.getByRole('checkbox', { checked: true })).toHaveCount(0);
});

test('empty meaning language array overrides a legacy value', async ({ page }) => {
	await mockAPI(page, [makeBook(1, 'Unspecified', { meaning_language: 'ja', meaning_languages: [] })]);
	await page.goto('/wordbooks?id=1');
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const meanings = page.getByRole('group', { name: 'Meaning language', exact: true });
	await expect(meanings.getByRole('checkbox', { checked: true })).toHaveCount(0);
	await expect(meanings).toContainText('Not specified');
});

for (const choice of ['trash', 'merge'] as const) {
	test(`delete ${choice} requires explicit confirmation, excludes archived targets, refreshes and notifies`, async ({ page }) => {
		const api = await mockAPI(page);
		await page.goto('/wordbooks?id=1');
		await page.evaluate(() => {
			document.documentElement.dataset.wordbookChanges = '0';
			window.addEventListener('pandalibrary-wordbooks-changed', () => {
				const count = Number(document.documentElement.dataset.wordbookChanges);
				document.documentElement.dataset.wordbookChanges = String(count + 1);
			});
		});
		await page.getByRole('button', { name: 'Delete wordbook', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Delete wordbook', exact: true });
		await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
		await expect(dialog).toContainText('Trash');
		await expect(dialog).toContainText('default wordbook');
		const remove = dialog.getByRole('button', { name: 'Delete wordbook', exact: true });
		await expect(remove).toBeDisabled();
		if (choice === 'merge') {
			await dialog.getByRole('radio', { name: 'Merge entries into another wordbook', exact: true }).check();
			await expect(dialog.getByLabel('Merge into', { exact: true }).locator('option')).toHaveText(['Study']);
		}
		await dialog.getByRole('checkbox').check();
		api.failDelete(true);
		await remove.click();
		await expect(dialog.getByRole('alert')).toContainText('Deletion failed.');
		api.failDelete(false);
		api.entryReads.length = 0;
		await remove.click();
		await expect(dialog).not.toBeVisible();
		expect(api.deletes.at(-1)).toEqual({ id: 1, body: choice === 'merge' ? { merge_into_id: 2 } : null });
		await expect.poll(() => page.evaluate(() => Number(document.documentElement.dataset.wordbookChanges))).toBe(1);
		if (choice === 'merge') {
			await expect(page).toHaveURL(/wordbooks\?id=2$/);
			await expect(page.locator('[data-entry-id="1"]')).toContainText('apple');
			expect(api.entryReads).toContain(2);
		} else {
			await expect(page).toHaveURL(/\/wordbooks$/);
			await expect(page.locator('[data-wordbooks] a')).toHaveCount(1);
			await expect(page.locator('[data-wordbooks] a')).toHaveAttribute('href', '/wordbooks?id=2');
		}
	});
}

test('last book deletion is disabled and deletion cancellation returns focus to the toolbar', async ({ page }) => {
	await mockAPI(page, [makeBook(1, 'Only book')]);
	await page.goto('/wordbooks?id=1');
	const remove = page.getByRole('button', { name: 'Delete wordbook', exact: true });
	await expect(remove).toBeDisabled();
	await expect(page.getByText('Your last wordbook cannot be deleted.')).toHaveCount(0);
	await page.unroute('**/api/v1/**');
	const api = await mockAPI(page, [makeBook(1, 'Only active'), makeBook(2, 'Archived', { archived: true })]);
	await page.reload();
	await remove.click();
	const deletion = page.getByRole('dialog', { name: 'Delete wordbook', exact: true });
	await expect(deletion.getByRole('radio', { name: 'Merge entries into another wordbook', exact: true })).toBeDisabled();
	await expect(deletion).toContainText('No other active wordbook is available.');
	await page.keyboard.press('Escape');
	await expect(deletion).not.toBeVisible();
	await expect(remove).toBeFocused();
	expect(api.deletes).toEqual([]);
});
