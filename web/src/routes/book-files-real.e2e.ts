import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Book } from '../lib/catalog/types.js';
import { epubFixture, pdfFixture } from '../lib/reader/fixtures.js';
import { signInRealAdmin } from '../lib/real-auth.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled real server');
test.use({ serviceWorkers: 'block' });

async function checked(response: Awaited<ReturnType<APIRequestContext['get']>>, status = 200) {
	expect(response.status(), await response.text()).toBe(status);
	return response;
}

async function getBook(api: APIRequestContext, id: number): Promise<Book> {
	return (await (await checked(await api.get(`/api/v1/books/${id}`))).json() as { book: Book }).book;
}

test('admins attach another format from the details cover and choose the default file', async ({ page }) => {
	test.setTimeout(120_000);
	await signInRealAdmin(page);
	const suffix = randomUUID().slice(0, 8);
	const created = await checked(await page.request.post('/api/v1/admin/libraries', {
		data: { name: `Files ${suffix}`, slug: `files-${suffix}` }
	}), 201);
	const { library } = await created.json() as { library: { id: number } };
	const uploaded = await checked(await page.request.post('/api/v1/uploads', {
		multipart: {
			library_id: String(library.id),
			file: { name: `Files ${suffix}.pdf`, mimeType: 'application/pdf', buffer: Buffer.concat([pdfFixture(), Buffer.from(`%${suffix}\n`)]) }
		}
	}), 202);
	const { job } = await uploaded.json() as { job: { id: number } };
	let bookID = 0;
	await expect.poll(async () => {
		const { items } = await (await checked(await page.request.get('/api/v1/imports?limit=100'))).json() as {
			items: Array<{ id: number; status: string; book_id: number | null }>;
		};
		const item = items.find((entry) => entry.id === job.id);
		bookID = item?.book_id ?? 0;
		return item?.status;
	}, { timeout: 30_000 }).toBe('imported');

	await page.goto(`/books/${bookID}`);
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Add file', exact: true }).click();
	await (await chooser).setFiles({
		name: `Files ${suffix} second edition.epub`, mimeType: 'application/epub+zip',
		buffer: epubFixture(`Files ${suffix} 2nd`)
	});
	await expect(page.getByText('Added 1 file(s) to this book.')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText('Files on disk: 2')).toBeVisible();
	const attached = await getBook(page.request, bookID);
	expect(attached.files.map((file) => file.format).sort()).toEqual(['epub', 'pdf']);
	expect(attached.files.every((file) => !file.is_default)).toBe(true);

	const pdf = attached.files.find((file) => file.format === 'pdf')!;
	await page.goto(`/books/${bookID}/files`);
	await page.getByRole('button', { name: `Select ${pdf.original_filename}` }).click();
	await page.getByRole('button', { name: 'Set as default', exact: true }).click();
	await expect(page.getByText(`${pdf.original_filename} is now the default file.`)).toBeVisible();
	expect((await getBook(page.request, bookID)).files.find((file) => file.is_default)?.id).toBe(pdf.id);

	await page.getByRole('button', { name: 'Clear default', exact: true }).click();
	await expect(page.getByText('The default file was cleared.')).toBeVisible();
	expect((await getBook(page.request, bookID)).files.some((file) => file.is_default)).toBe(false);
});
