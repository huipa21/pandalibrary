import { expect, test } from '@playwright/test';
import { signInRealAdmin } from '../lib/real-auth.js';
import type { Wordbook, WordbookEntry } from '../lib/wordbooks/api.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');

test('meaning preferences persist and merge deletion preserves entries on the real server', async ({ page }) => {
	await signInRealAdmin(page);
	const initial = await page.request.get('/api/v1/wordbooks');
	expect(initial.ok()).toBe(true);
	const initialBooks = await initial.json() as { wordbooks: Wordbook[] };
	const originalDefault = initialBooks.wordbooks.find((book) => book.is_default)!;
	const created = await page.request.post('/api/v1/wordbooks', {
		data: { name: 'Language preview', language: 'en', meaning_language: 'zh', description: 'Bilingual vocabulary' }
	});
	expect(created.status()).toBe(201);
	const source = await created.json() as Wordbook;
	expect(source).toMatchObject({ language: 'en', meaning_language: 'zh' });
	const captured = await page.request.post('/api/v1/wordbooks/entries', {
		data: {
			wordbook_id: source.id, kind: 'word', text: 'apple', definition: '', note: '',
			source: { book_id: null, book_file_id: null, book_title: '', locator: {}, fraction: 0 },
			dictionary_entries: [
				{ source: 'en-fixture', sourceName: 'English fixture', headword: 'apple', from: 'en', to: 'en',
					partOfSpeech: 'noun', definitions: ['A round fruit'], match: 'exact' },
				{ source: 'zh-fixture', sourceName: 'Chinese fixture', headword: 'apple', from: 'en', to: 'zh',
					partOfSpeech: 'noun', definitions: ['苹果'], match: 'exact' },
				{ source: 'ja-fixture', sourceName: 'Japanese fixture', headword: 'apple', from: 'en', to: 'ja',
					definitions: ['りんご'], match: 'exact' }
			]
		}
	});
	expect(captured.status()).toBe(201);
	const entry = await captured.json() as WordbookEntry;
	await page.goto(`/wordbooks?id=${source.id}`);
	const preview = page.locator(`[data-entry-id="${entry.id}"]`);
	await expect(preview).toContainText('苹果');
	await expect(preview).not.toContainText('A round fruit');
	await expect(preview).not.toContainText('りんご');
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
	const meanings = dialog.getByRole('group', { name: 'Meaning language', exact: true });
	await expect(meanings.getByRole('checkbox', { name: 'English–Chinese (Simplified)' })).toBeChecked();
	await meanings.getByRole('checkbox', { name: 'English–Japanese' }).check();
	await dialog.getByRole('radio', { name: 'Charcoal', exact: true }).check();
	const image = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 600;
		canvas.height = 900;
		const context = canvas.getContext('2d')!;
		const pixels = context.createImageData(600, 900);
		let state = 1;
		for (let i = 0; i < pixels.data.length; i += 4) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			pixels.data[i] = state & 255;
			pixels.data[i + 1] = (state >>> 8) & 255;
			pixels.data[i + 2] = (state >>> 16) & 255;
			pixels.data[i + 3] = 255;
		}
		context.putImageData(pixels, 0, 0);
		return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
	});
	await dialog.locator('input[type="file"]').setInputFiles({
		name: 'realistic-cover.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64')
	});
	await expect(dialog.locator('img[src^="data:image/jpeg;base64,"]')).toBeVisible();
	await dialog.getByLabel('Description (optional)', { exact: true }).fill('Saved from the actual settings dialog');
	const saveResponse = page.waitForResponse((response) =>
		response.request().method() === 'PATCH' && response.url().endsWith(`/api/v1/wordbooks/${source.id}`));
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	const saved = await saveResponse;
	expect(saved.status(), await saved.text()).toBe(200);
	expect(await saved.json()).toMatchObject({
		meaning_language: 'zh', meaning_languages: ['zh', 'ja'], cover_color: 'charcoal',
		description: 'Saved from the actual settings dialog',
		cover_image: expect.stringMatching(/^data:image\/jpeg;base64,/)
	});
	await expect(dialog).not.toBeVisible();
	await expect(preview).toContainText('苹果');
	await expect(preview).toContainText('りんご');
	await page.reload();
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(meanings.getByRole('checkbox', { name: 'English–Chinese (Simplified)' })).toBeChecked();
	await expect(meanings.getByRole('checkbox', { name: 'English–Japanese' })).toBeChecked();
	await expect(dialog.getByRole('radio', { name: 'Charcoal', exact: true })).toBeChecked();
	await expect(dialog.locator('img[src^="data:image/jpeg;base64,"]')).toBeVisible();
	await page.keyboard.press('Escape');
	const changed = await page.request.patch(`/api/v1/wordbooks/${source.id}`, {
		data: { name: 'English preview', meaning_language: 'en' }
	});
	expect(changed.ok()).toBe(true);
	await page.reload();
	await expect(preview).toContainText('A round fruit');
	await expect(preview).not.toContainText('苹果');
	const listed = await page.request.get('/api/v1/wordbooks');
	expect(listed.ok()).toBe(true);
	const { wordbooks } = await listed.json() as { wordbooks: Wordbook[] };
	expect(wordbooks.find((book) => book.id === source.id)).toMatchObject({
		name: 'English preview', language: 'en', meaning_language: 'en', meaning_languages: ['en'], cover_color: 'charcoal'
	});

	const merged = await page.request.delete(`/api/v1/wordbooks/${source.id}`, {
		data: { merge_into_id: originalDefault.id }
	});
	expect(merged.status()).toBe(204);
	const destination = await page.request.get(`/api/v1/wordbooks/${originalDefault.id}/entries`);
	expect(destination.ok()).toBe(true);
	const destinationEntries = await destination.json() as { entries: WordbookEntry[] };
	expect(destinationEntries.entries.find((item) => item.id === entry.id)).toMatchObject({
		wordbook_id: originalDefault.id, text: entry.text, source: entry.source,
		dictionary_entries: entry.dictionary_entries
	});
	const deleted = await page.request.get(`/api/v1/wordbooks/${source.id}/entries`);
	expect(deleted.status()).toBe(404);
	await page.goto(`/wordbooks?id=${originalDefault.id}`);
	await expect(page.locator(`[data-entry-id="${entry.id}"]`)).toBeVisible();
});
