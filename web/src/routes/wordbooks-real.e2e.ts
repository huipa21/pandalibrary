import { expect, test } from '@playwright/test';
import { signInRealAdmin } from '../lib/real-auth.js';
import { pdfFixture } from '../lib/reader/fixtures.js';
import {
	jumpToPdfPage, openedPdf, pdfPageBox, selectPdfText, selectionToolbar
} from '../lib/real-pdf.js';
import type { Wordbook, WordbookEntry, WordbookExport } from '../lib/wordbooks/api.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');

test('wordbook cover choices persist through API updates and page reloads', async ({ page }) => {
	await signInRealAdmin(page);
	const image = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 600;
		canvas.height = 900;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas is unavailable');
		context.fillStyle = '#24462a';
		context.fillRect(0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/jpeg', 0.8);
	});
	const response = await page.request.post('/api/v1/wordbooks', {
		data: { name: 'Persistent cover', description: 'Custom notebook', language: 'en', cover_color: 'forest', cover_image: image }
	});
	expect(response.status()).toBe(201);
	const created = await response.json() as Wordbook & { cover_color: string; cover_image: string };
	expect(created).toMatchObject({ language: 'en', cover_color: 'forest', cover_image: image });
	const updated = await page.request.patch(`/api/v1/wordbooks/${created.id}`, {
		data: { description: 'Updated without replacing cover' }
	});
	expect(updated.ok()).toBe(true);
	expect(await updated.json()).toMatchObject({ cover_color: 'forest', cover_image: image });

	await page.goto('/wordbooks');
	const cover = page.locator(`[data-wordbooks] a[href="/wordbooks?id=${created.id}"]`);
	await expect(cover).toBeVisible();
	await expect(cover.locator('img')).toHaveAttribute('src', image);
	await expect(cover).toContainText('Persistent cover');
	await page.reload();
	await expect(cover.locator('img')).toHaveAttribute('src', image);
	const listed = await page.request.get('/api/v1/wordbooks');
	expect(listed.ok()).toBe(true);
	const result = await listed.json() as { wordbooks: Wordbook[] };
	expect(result.wordbooks.find((book) => book.id === created.id)).toMatchObject({
		description: 'Updated without replacing cover', language: 'en', cover_color: 'forest', cover_image: image
	});
	await cover.click();
	await expect(page.locator('[data-wordbook-summary]')).toContainText('English');
	await page.reload();
	await expect(page.locator('[data-wordbook-summary]')).toContainText('English');
});

test('reader collection persists without dictionaries and wordbook context reopens the source page', async ({ page }) => {
	test.setTimeout(120_000);
	await signInRealAdmin(page);
	const created = await page.request.post('/api/v1/admin/libraries', {
		data: { name: 'Wordbook integration', slug: 'wordbook-integration' }
	});
	expect(created.status()).toBe(201);
	const { library } = await created.json() as { library: { id: number } };
	const uploaded = await page.request.post('/api/v1/uploads', {
		multipart: {
			library_id: String(library.id),
			file: { name: 'wordbook-source.pdf', mimeType: 'application/pdf', buffer: pdfFixture(5) }
		}
	});
	expect(uploaded.ok()).toBe(true);
	const { job } = await uploaded.json() as { job: { id: number } };
	let bookId = 0;
	await expect.poll(async () => {
		const response = await page.request.get('/api/v1/imports?limit=100');
		expect(response.ok()).toBe(true);
		const { items } = await response.json() as {
			items: Array<{ id: number; status: string; book_id: number | null }>
		};
		const item = items.find((candidate) => candidate.id === job.id);
		bookId = item?.book_id ?? 0;
		return item?.status;
	}, { timeout: 30_000 }).toBe('imported');
	const details = await page.request.get(`/api/v1/books/${bookId}`);
	expect(details.ok()).toBe(true);
	const { book } = await details.json() as {
		book: { title: string; files: Array<{ id: number }> }
	};
	const fileId = book.files[0].id;
	await page.goto(`/read/${bookId}/${fileId}`);
	await openedPdf(page);
	await jumpToPdfPage(page, 3);
	const selected = await page.locator('.reader-pdf-page[data-page="3"] .textLayer span')
		.filter({ hasText: /\S/ }).first().innerText();
	expect(selected.trim()).not.toBe('');
	await selectPdfText(page, selected);
	await selectionToolbar(page).getByRole('combobox', { name: 'Entry type', exact: true })
		.selectOption('phrase');
	await selectionToolbar(page).getByRole('button', { name: 'Add to wordbook', exact: true }).click();
	await expect(page.getByText('Added to wordbook', { exact: true })).toBeVisible();

	const list = await page.request.get('/api/v1/wordbooks');
	expect(list.ok()).toBe(true);
	const { wordbooks } = await list.json() as { wordbooks: Wordbook[] };
	const defaultBook = wordbooks.find((item) => item.is_default);
	expect(defaultBook).toBeDefined();
	const entriesResponse = await page.request.get(`/api/v1/wordbooks/${defaultBook!.id}/entries`);
	expect(entriesResponse.ok()).toBe(true);
	const { entries } = await entriesResponse.json() as { entries: WordbookEntry[] };
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		text: selected,
		note: '',
		dictionary_entries: [],
		source: {
			book_id: bookId,
			book_file_id: fileId,
			book_title: book.title,
			locator: { type: 'pdf', page: 3 }
		}
	});

	const edit = await page.request.patch(
		`/api/v1/wordbooks/${defaultBook!.id}/entries/${entries[0].id}`,
		{ data: { definition: 'My own interpretation' } }
	);
	expect(edit.ok()).toBe(true);
	const exported = await page.request.get(`/api/v1/wordbooks/${defaultBook!.id}/export`);
	expect(exported.ok()).toBe(true);
	const document = await exported.json() as WordbookExport;
	expect(document.version).toBe(1);
	expect(document.entries[0].definition).toBe('My own interpretation');
	const newBook = await page.request.post('/api/v1/wordbooks', { data: { name: 'Imported vocabulary' } });
	expect(newBook.ok()).toBe(true);
	const target = await newBook.json() as Wordbook;
	const imported = await page.request.post(`/api/v1/wordbooks/${target.id}/import`, { data: document });
	expect(imported.ok()).toBe(true);
	expect(await imported.json()).toEqual({ imported: 1 });
	const restored = await page.request.get(`/api/v1/wordbooks/${target.id}/entries`);
	expect(restored.ok()).toBe(true);
	const restoredEntries = await restored.json() as { entries: WordbookEntry[] };
	expect(restoredEntries.entries[0]).toMatchObject({
		created_at: document.entries[0].created_at,
		updated_at: document.entries[0].updated_at,
		source: document.entries[0].source,
		definition: 'My own interpretation'
	});
	expect(restoredEntries.entries[0].id).not.toBe(document.entries[0].id);
	const archive = await page.request.patch(`/api/v1/wordbooks/${target.id}`, { data: { archived: true } });
	expect(archive.ok()).toBe(true);

	await jumpToPdfPage(page, 1);
	await page.goto('/wordbooks');
	await page.locator(`[data-wordbooks] a[href="/wordbooks?id=${defaultBook!.id}"]`).click();
	await expect(page.getByText('My own interpretation', { exact: true })).toBeVisible();
	await expect(page.locator(`[data-wordbooks] a[href="/wordbooks?id=${target.id}"]`)).toHaveCount(0);
	await page.reload();
	await expect(page.getByText('My own interpretation', { exact: true })).toBeVisible();
	await page.locator(`[data-entry-id="${entries[0].id}"]`).getByRole('button', { name: selected, exact: true }).click();
	await page.getByRole('dialog', { name: 'Word details', exact: true }).getByRole('link', { name: 'Read in context', exact: true }).click();
	await expect(pdfPageBox(page)).toHaveValue('3', { timeout: 30_000 });
});
