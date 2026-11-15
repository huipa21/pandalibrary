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
	await expect(button).toContainText('A fruit');
	await expect(button).toContainText('Example dictionary');
	await expect(button).toContainText('Source book');
	await button.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Word details' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Chapter 2');
	await expect(dialog).toContainText('Page 3');
	const href = await dialog.getByRole('link', { name: 'Read in context' }).getAttribute('href');
	const url = new URL(href!, 'https://reader.invalid');
	expect(url.pathname).toBe('/read/21/31');
	expect(JSON.parse(url.searchParams.get('locator')!)).toEqual(locator);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(button).toBeFocused();
});
