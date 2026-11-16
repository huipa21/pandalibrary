import { expect, test } from '@playwright/test';

test('entry summaries open accessible details and preserve the exact reader locator', async ({ page }) => {
	const locator = { type: 'pdf', page: 3, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }] };
	const entry = {
		id: 1, wordbook_id: 1, kind: 'word', text: 'apple', definition: 'Personal meaning', note: '',
		dictionary_entries: [{ source: 'fixture', sourceName: 'Example dictionary', headword: 'apple',
			partOfSpeech: 'noun', definitions: ['A fruit'], match: 'exact' }],
		source: { book_id: 21, book_file_id: 31, book_title: 'Source book', chapter: 'Chapter 2', locator, fraction: 0.4 },
		created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
	};
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/setup')) return route.fulfill({ json: { required: false } });
		if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 1, username: 'test', display_name: 'Test', role: 'user', locale: 'en' } } });
		if (path.endsWith('/sync/pull')) return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: [] } });
		if (path.endsWith('/wordbooks')) return route.fulfill({ json: { wordbooks: [{
			id: 1, name: 'Vocabulary', description: '', is_default: true, archived: false,
			entry_count: 1, book_count: 1, created_at: entry.created_at, updated_at: entry.updated_at
		}] } });
		if (path.endsWith('/wordbooks/1/entries')) return route.fulfill({ json: { entries: [entry] } });
		return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
	});

	await page.goto('/wordbooks?id=1');
	const card = page.locator('[data-entry-id="1"]');
	const button = card.getByRole('button', { name: 'apple', exact: true });
	await expect(button).toContainText('Personal meaning');
	await expect(button).toContainText('noun');
	await expect(button).not.toContainText('A fruit');
	await expect(button).not.toContainText('Example dictionary');
	await expect(button).not.toContainText('Source book');
	await button.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Word details' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Personal meaning');
	await expect(dialog).toContainText('A fruit');
	await expect(dialog).toContainText('Example dictionary');
	await expect(dialog).toContainText('Source book');
	await expect(dialog).toContainText('Chapter 2');
	await expect(dialog).toContainText('Page 3');
	await expect(dialog.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
	const href = await dialog.getByRole('link', { name: 'Read in context' }).getAttribute('href');
	const url = new URL(href!, 'https://reader.invalid');
	expect(url.pathname).toBe('/read/21/31');
	expect(JSON.parse(url.searchParams.get('locator')!)).toEqual(locator);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(button).toBeFocused();
	await button.click();
	await expect(dialog).toBeVisible();
	await page.mouse.click(5, 5);
	await expect(dialog).toHaveCount(0);
	await expect(button).toBeFocused();
});

test('dictionary meanings can be updated, removed, restored, and shown on multiple preview rows', async ({ page }) => {
	const entry = {
		id: 1, wordbook_id: 1, kind: 'word', text: 'apple', definition: '', note: '',
		dictionary_entries: [{
			from: 'en', to: 'zh', source: 'ecdict', sourceName: 'ECDICT', headword: 'apple',
			partOfSpeech: 'noun', reading: 'ˈæpəl', definitions: ['A fruit', 'A tree', 'A unit of weight'], match: 'exact'
		}],
		source: { book_id: null, book_file_id: null, book_title: 'Source book', locator: null, fraction: 0 },
		created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
	};
	await page.route('**/api/v1/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path.endsWith('/setup')) return route.fulfill({ json: { required: false } });
		if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 1, username: 'test', display_name: 'Test', role: 'user', locale: 'en' } } });
		if (path.endsWith('/sync/pull')) return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: [] } });
		if (path.endsWith('/wordbooks')) return route.fulfill({ json: { wordbooks: [{
			id: 1, name: 'Vocabulary', description: '', is_default: true, archived: false,
			entry_count: 1, book_count: 0, created_at: entry.created_at, updated_at: entry.updated_at
		}] } });
		if (path.endsWith('/wordbooks/1/entries') && request.method() === 'GET') return route.fulfill({ json: { entries: [entry] } });
		if (path.endsWith('/wordbooks/1/entries/1') && request.method() === 'PATCH') {
			Object.assign(entry, request.postDataJSON());
			return route.fulfill({ json: entry });
		}
		return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
	});

	await page.goto('/wordbooks?id=1');
	const card = page.locator('[data-entry-id="1"]');
	await expect(card.locator('[data-entry-meaning] li')).toHaveText(['A fruit', 'A tree', 'A unit of weight']);
	await expect(card.locator('[data-entry-metadata]')).toHaveText('noun · ˈæpəl');
	await card.getByRole('button', { name: 'apple', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Word details' });
	await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
	await dialog.getByLabel('apple Definition (editable) 1').fill('A tasty fruit');
	await dialog.getByRole('button', { name: 'Remove meaning: A tree' }).click();
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog).toContainText('A tasty fruit');
	await expect(dialog).not.toContainText('A tree');
	await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
	await dialog.getByRole('button', { name: 'Restore meaning: A tree' }).click();
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog).toContainText('A tree');
});
