import { expect, test } from '@playwright/test';
import { v7 as uuidv7 } from 'uuid';
import { signInRealAdmin } from '../lib/real-auth.js';
import { pdfFixture } from '../lib/reader/fixtures.js';
import { jumpToPdfPage, pdfPageBox } from '../lib/real-pdf.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');

test('real Notes API lists every annotation type and searches Chinese reviews and inserted text', async ({ page }) => {
	test.setTimeout(90_000);
	await signInRealAdmin(page);
	const created = await page.request.post('/api/v1/admin/libraries', {
		data: { name: 'Notes regression', slug: 'notes-regression' }
	});
	expect(created.status()).toBe(201);
	const { library } = await created.json() as { library: { id: number } };
	const uploaded = await page.request.post('/api/v1/uploads', { multipart: {
		library_id: String(library.id),
		file: { name: 'notes.pdf', mimeType: 'application/pdf', buffer: pdfFixture(5) }
	} });
	expect(uploaded.ok()).toBe(true);
	const { job } = await uploaded.json() as { job: { id: number } };
	let bookID = 0;
	await expect.poll(async () => {
		const response = await page.request.get('/api/v1/imports?limit=100');
		expect(response.ok()).toBe(true);
		const { items } = await response.json() as { items: Array<{ id: number; status: string; book_id: number | null }> };
		const imported = items.find((item) => item.id === job.id);
		bookID = imported?.book_id ?? 0;
		return imported?.status;
	}, { timeout: 30_000 }).toBe('imported');
	const details = await page.request.get(`/api/v1/books/${bookID}`);
	expect(details.ok()).toBe(true);
	const { book } = await details.json() as { book: { files: Array<{ id: number }> } };
	const fileID = book.files[0].id;
	const review = await page.request.put(`/api/v1/books/${bookID}/reviews/me`, { data: { body: '这是一个扣子的大纲' } });
	expect(review.ok()).toBe(true);
	const highlightID = uuidv7();
	const locator = { type: 'pdf', page: 5, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
	const updatedAt = Date.now();
	const mutations = [
		{ entity: 'highlights', id: highlightID, op: 'upsert', updated_at: updatedAt, data: {
			book_id: bookID, book_file_id: fileID, locator: { type: 'pdf', page: 5 },
			position: 0.8, text: 'Coze 平台实战', color: 'yellow'
		} },
		{ entity: 'notes', id: uuidv7(), op: 'upsert', updated_at: updatedAt, data: {
			book_id: bookID, highlight_id: highlightID, body_md: 'AI实战使用扣子'
		} },
		{ entity: 'page_annotations', id: uuidv7(), op: 'upsert', updated_at: updatedAt, data: {
			book_id: bookID, book_file_id: fileID, kind: 'text', locator, position: 0.8,
			data: { text: '扣子已经关闭了', color: '#000000', size: 0.02 }
		} },
		{ entity: 'page_annotations', id: uuidv7(), op: 'upsert', updated_at: updatedAt, data: {
			book_id: bookID, book_file_id: fileID, kind: 'ink', locator, position: 0.8,
			data: { color: '#000000', width: 0.01, strokes: [[0.1, 0.2, 0.3, 0.4]] }
		} }
	];
	const pushed = await page.request.post('/api/v1/sync/push', { data: { mutations } });
	expect(pushed.ok()).toBe(true);
	const { results } = await pushed.json() as { results: Array<{ status: string }> };
	expect(results.map((result) => result.status)).toEqual(mutations.map(() => 'applied'));
	await page.goto('/notes');
	const feed = page.getByRole('list', { name: 'Your annotations, newest first' });
	await expect(feed.getByRole('listitem')).toHaveCount(5);
	await expect(feed.getByRole('img', { name: 'Drawing' })).toBeVisible();
	for (const text of ['AI实战使用扣子', '扣子已经关闭了']) {
		await feed.getByRole('listitem').filter({ hasText: text }).getByRole('link').click();
		await expect(pdfPageBox(page)).toHaveValue('5', { timeout: 30_000 });
		await jumpToPdfPage(page, 1);
		await page.goto('/notes');
	}
	await feed.getByRole('link').filter({ has: page.getByRole('img', { name: 'Drawing', exact: true }) }).click();
	await expect(pdfPageBox(page)).toHaveValue('5', { timeout: 30_000 });
	await jumpToPdfPage(page, 1);
	await page.goto('/notes');
	const search = page.getByRole('search', { name: 'Annotations search' });
	await search.getByRole('searchbox').fill('扣子');
	await search.getByRole('button', { name: 'Search', exact: true }).click();
	const matches = page.getByRole('list', { name: 'Matching annotations, newest first' });
	await expect(matches.getByRole('listitem')).toHaveCount(3);
	for (const text of ['这是一个扣子的大纲', '扣子已经关闭了', 'AI实战使用扣子']) {
		await expect(matches.getByText(text, { exact: true })).toBeVisible();
	}
	for (const text of ['扣子已经关闭了', 'AI实战使用扣子']) {
		await matches.getByRole('listitem').filter({ hasText: text }).getByRole('link').click();
		await expect(pdfPageBox(page)).toHaveValue('5', { timeout: 30_000 });
		await jumpToPdfPage(page, 1);
		await page.goto('/notes?q=' + encodeURIComponent('扣子'));
	}
	await matches.getByRole('listitem').filter({ hasText: '这是一个扣子的大纲' }).getByRole('link').click();
	await expect(page).toHaveURL(new RegExp(`/books/${bookID}#book-reviews-heading$`));
	await expect(page.getByRole('heading', { name: 'Reviews', exact: true })).toBeVisible();
	await page.goto('/notes?q=' + encodeURIComponent('扣子'));
	await search.getByRole('button', { name: 'Clear search' }).click();
	await expect(feed.getByRole('img', { name: 'Drawing' })).toBeVisible();
});
