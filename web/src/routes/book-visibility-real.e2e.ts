import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Book } from '../lib/catalog/types.js';
import { pdfFixture } from '../lib/reader/fixtures.js';
import { signInRealAdmin } from '../lib/real-auth.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled real server');
test.use({ serviceWorkers: 'block' });

async function checked(response: Awaited<ReturnType<APIRequestContext['get']>>, status = 200) {
	expect(response.status(), await response.text()).toBe(status);
	return response;
}

async function imported(api: APIRequestContext, jobID: number): Promise<Book> {
	let bookID = 0;
	await expect.poll(async () => {
		const response = await checked(await api.get('/api/v1/imports?limit=100'));
		const { items } = await response.json() as {
			items: Array<{ id: number; status: string; book_id: number | null; error: string | null }>;
		};
		const item = items.find((entry) => entry.id === jobID);
		if (item?.status === 'failed') throw new Error(`Visibility import failed: ${JSON.stringify(item)}`);
		bookID = item?.book_id ?? 0;
		return item?.status;
	}, { timeout: 30_000 }).toBe('imported');
	const response = await checked(await api.get(`/api/v1/books/${bookID}`));
	return (await response.json() as { book: Book }).book;
}

function file(name: string) {
	return {
		name: `${name}.pdf`, mimeType: 'application/pdf',
		buffer: Buffer.concat([pdfFixture(), Buffer.from(`%${randomUUID()}\n`)])
	};
}

test('upload visibility persists and confirmed owner toggles control authenticated access', async ({ page, browser }) => {
	test.setTimeout(120_000);
	await signInRealAdmin(page);
	const suffix = randomUUID().slice(0, 8);
	const created = await checked(await page.request.post('/api/v1/admin/libraries', {
		data: { name: `Visibility ${suffix}`, slug: `visibility-${suffix}` }
	}), 201);
	const { library } = await created.json() as { library: { id: number } };
	const uploaded = await checked(await page.request.post('/api/v1/uploads', {
		multipart: { library_id: String(library.id), visibility: 'private', file: file(`Private ${suffix}`) }
	}), 202);
	const { job } = await uploaded.json() as { job: { id: number } };
	const book = await imported(page.request, job.id);
	expect(book.visibility).toBe('private');
	expect(book.owner_id).toBeGreaterThan(0);
	expect(book.can_manage_visibility).toBe(true);

	const username = `visibility-${suffix}`;
	const password = 'visibility-integration-password';
	await checked(await page.request.post('/api/v1/admin/users', {
		data: { username, display_name: 'Visibility reader', password, role: 'user', locale: 'en' }
	}), 201);
	const origin = new URL(page.url()).origin;
	const readerContext = await browser.newContext({ baseURL: origin, serviceWorkers: 'block' });
	const anonymous = await request.newContext({ baseURL: origin });
	try {
		const reader = await readerContext.newPage();
		await reader.goto('/login');
		await reader.getByLabel('Username', { exact: true }).fill(username);
		await reader.getByLabel('Password', { exact: true }).fill(password);
		await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(reader).toHaveURL('/');
		expect((await reader.request.get(`/api/v1/books/${book.id}`)).status()).toBe(404);
		expect((await anonymous.get(`/api/v1/books/${book.id}`)).status()).toBe(401);

		await page.goto(`/books/${book.id}`);
		const makePublic = page.getByRole('button', { name: 'Make public', exact: true });
		await expect(makePublic).toBeVisible();
		page.once('dialog', (dialog) => dialog.dismiss());
		await makePublic.click();
		await expect(makePublic).toBeVisible();
		expect((await reader.request.get(`/api/v1/books/${book.id}`)).status()).toBe(404);
		page.once('dialog', (dialog) => dialog.accept());
		await makePublic.click();
		const makePrivate = page.getByRole('button', { name: 'Make private', exact: true });
		await expect(makePrivate).toBeVisible();
		await page.reload();
		await expect(makePrivate).toBeVisible();

		const visible = await checked(await reader.request.get(`/api/v1/books/${book.id}`));
		const { book: publicBook } = await visible.json() as { book: Book };
		expect(publicBook.visibility).toBe('public');
		expect(publicBook.can_manage_visibility).toBe(false);
		await checked(await reader.request.get(book.files[0].download_url));
		expect((await anonymous.get(book.files[0].download_url)).status()).toBe(401);
		const denied = await reader.request.put(`/api/v1/books/${book.id}/visibility`, {
			data: { visibility: 'private' }, headers: { Origin: origin }
		});
		expect(denied.status()).toBe(403);
		await reader.goto(`/books/${book.id}`);
		await expect(reader.getByRole('heading', { name: book.title, exact: true })).toBeVisible();
		await expect(reader.getByRole('button', { name: /^Make (private|public)$/ })).toHaveCount(0);

		page.once('dialog', (dialog) => dialog.accept());
		await makePrivate.click();
		await expect(makePublic).toBeVisible();
		expect((await reader.request.get(book.files[0].download_url)).status()).toBe(404);
		expect((await reader.request.get(`/api/v1/books/${book.id}`)).status()).toBe(404);

		const heapResponse = await checked(await page.request.post('/api/v1/admin/bookheap/files', {
			multipart: { visibility: 'private', file: file(`Staged private ${suffix}`) }
		}), 201);
		const { item } = await heapResponse.json() as { item: { id: number } };
		const assignment = await checked(await page.request.post('/api/v1/admin/bookheap/assign', {
			data: { ids: [item.id], library_id: library.id, shelf_ids: [] }
		}), 202);
		const { results } = await assignment.json() as { results: Array<{ import_job_id: number }> };
		const staged = await imported(page.request, results[0].import_job_id);
		expect(staged.visibility).toBe('private');
		expect(staged.owner_id).toBe(book.owner_id);
		expect((await reader.request.get(`/api/v1/books/${staged.id}`)).status()).toBe(404);
	} finally {
		await anonymous.dispose();
		await readerContext.close();
	}
});
