import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, rmdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cbzFixture, epubFixture, pdfFixture } from '../lib/reader/fixtures.js';
import { signInRealAdmin } from '../lib/real-auth.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');
test.describe.configure({ mode: 'serial' });

const dataDir = process.env.PANDA_E2E_DATA_DIR ?? '';
const heapDir = join(dataDir, 'bookheap');
const batchSize = 50;
const batchTitle = (index: number) => `BH5 Batch ${String(index).padStart(2, '0')}`;
const assignedTitles = ['BH5 Batch 01', 'BH5 Scanned', 'BH5 Alpha', 'BH5 Beta'];
const assignedFiles = ['batch/BH5 Batch 01.epub', 'incoming/BH5 Scanned.epub', 'BH5 Alpha.epub', 'BH5 Beta.epub'];
const seededHeapFiles = new Set<string>();

const state = { libraryID: 0, librarySlug: 'bh5-library', shelfID: 0, existingBookID: 0, uploadDir: '' };

interface HeapItemDTO { id: number; title: string; status: string; rel_path: string; format: string | null }
interface ImportJobDTO { id: number; library_id: number; source: string; original_name: string; status: string; book_id: number | null; error: string | null }

/** Writes a file into the heap with an mtime old enough that a scan indexes it instead of waiting for writes to settle. */
async function seedHeapFile(relPath: string, bytes: Buffer) {
	const path = join(heapDir, ...relPath.split('/'));
	seededHeapFiles.add(relPath);
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, bytes);
	const settled = new Date(Date.now() - 60_000);
	await utimes(path, settled, settled);
}

async function listHeap(page: Page, query = ''): Promise<HeapItemDTO[]> {
	const items: HeapItemDTO[] = [];
	let cursor: string | null = null;
	do {
		const params = new URLSearchParams(query);
		params.set('limit', '100');
		if (cursor) params.set('cursor', cursor);
		const response = await page.request.get(`/api/v1/admin/bookheap/items?${params}`);
		expect(response.ok()).toBe(true);
		const payload = await response.json() as { items: HeapItemDTO[]; next_cursor: string | null };
		items.push(...payload.items);
		cursor = payload.next_cursor;
	} while (cursor);
	return items;
}

async function imports(page: Page): Promise<ImportJobDTO[]> {
	const response = await page.request.get('/api/v1/imports?limit=100');
	expect(response.ok()).toBe(true);
	return (await response.json() as { items: ImportJobDTO[] }).items;
}

async function runScan(page: Page) {
	await page.getByRole('main').getByRole('search').getByRole('button', { name: 'Scan', exact: true }).click();
	await expect(page.getByTestId('bh4-scan-status')).toContainText('Scan complete', { timeout: 60_000 });
	return page.getByTestId('bh4-scan-summary');
}

test.beforeAll(async ({ browser }) => {
	const page = await browser.newPage();
	try {
		await signInRealAdmin(page);
		const library = await page.request.post('/api/v1/admin/libraries', { data: { name: 'BH5 Library', slug: state.librarySlug } });
		expect(library.status()).toBe(201);
		state.libraryID = (await library.json() as { library: { id: number } }).library.id;
		const shelf = await page.request.post('/api/v1/shelves', { data: { kind: 'private', name: 'BH5 Shelf', description: null } });
		expect(shelf.status()).toBe(201);
		state.shelfID = (await shelf.json() as { shelf: { id: number } }).shelf.id;

		const uploaded = await page.request.post('/api/v1/uploads', { multipart: {
			library_id: String(state.libraryID),
			file: { name: 'BH5 Existing.epub', mimeType: 'application/epub+zip', buffer: epubFixture('BH5 Existing') }
		} });
		expect(uploaded.ok()).toBe(true);
		const { job } = await uploaded.json() as { job: { id: number } };
		await expect.poll(async () => {
			const found = (await imports(page)).find((item) => item.id === job.id);
			state.existingBookID = found?.book_id ?? 0;
			return found?.status;
		}, { timeout: 30_000 }).toBe('imported');

		state.uploadDir = await mkdtemp(join(tmpdir(), 'pandalibrary-bh5-'));
		for (const [name, title] of [['BH5 Upload One', 'BH5 Upload One'], ['BH5 Upload Two', 'BH5 Upload Two'], ['BH5 Extra', 'BH5 Extra'], ['BH5 Existing copy', 'BH5 Existing']]) {
			await writeFile(join(state.uploadDir, `${name}.epub`), epubFixture(title));
		}
		for (const title of ['BH5 Alpha', 'BH5 Beta']) {
			const staged = await page.request.post('/api/v1/admin/bookheap/files', { multipart: {
				file: { name: `${title}.epub`, mimeType: 'application/epub+zip', buffer: epubFixture(title) }
			} });
			expect(staged.status()).toBe(201);
		}
	} finally {
		await page.close();
	}
});

test.afterAll(async ({ browser }) => {
	test.setTimeout(90_000);
	if (state.uploadDir) await rm(state.uploadDir, { recursive: true, force: true });
	const page = await browser.newPage();
	try {
		await signInRealAdmin(page);
		if (state.libraryID) {
			await expect.poll(async () => (await imports(page)).filter((job) =>
				job.library_id === state.libraryID && (job.status === 'pending' || job.status === 'processing')
			).length, { timeout: 60_000 }).toBe(0);
		}
		const isFixture = (item: HeapItemDTO) => item.rel_path.startsWith('BH5 ') ||
			item.rel_path.startsWith('batch/BH5 Batch ') || item.rel_path.startsWith('incoming/BH5 ');
		const fixtures = (await listHeap(page)).filter(isFixture);
		expect(fixtures.every((item) => item.status !== 'queued' && item.status !== 'importing')).toBe(true);
		const ids = fixtures.map((item) => item.id);
		for (let start = 0; start < ids.length; start += 500) {
			const batch = ids.slice(start, start + 500);
			const response = await page.request.post('/api/v1/admin/bookheap/items/delete', { data: { ids: batch } });
			expect(response.ok()).toBe(true);
			const { results } = await response.json() as { results: { ok: boolean }[] };
			expect(results).toHaveLength(batch.length);
			expect(results.every((result) => result.ok)).toBe(true);
		}
		expect((await listHeap(page)).filter(isFixture)).toHaveLength(0);

		if (state.libraryID) {
			const response = await page.request.get(`/api/v1/books?library_id=${state.libraryID}&limit=100`);
			expect(response.ok()).toBe(true);
			const { items, next_cursor } = await response.json() as { items: { id: number }[]; next_cursor: string | null };
			expect(next_cursor).toBeNull();
			for (const item of items) {
				expect((await page.request.delete(`/api/v1/books/${item.id}`)).ok()).toBe(true);
			}
		}
		if (state.shelfID) {
			expect((await page.request.delete(`/api/v1/shelves/${state.shelfID}`)).ok()).toBe(true);
			expect((await page.request.get(`/api/v1/shelves/${state.shelfID}`)).status()).toBe(404);
		}
		if (state.libraryID) {
			expect((await page.request.delete(`/api/v1/admin/libraries/${state.libraryID}`)).ok()).toBe(true);
			expect((await page.request.get(`/api/v1/libraries/${state.libraryID}`)).status()).toBe(404);
			expect((await imports(page)).filter((job) => job.library_id === state.libraryID)).toHaveLength(0);
			await rm(join(dataDir, 'drop', state.librarySlug), { recursive: true, force: true });
		}
		for (const relPath of seededHeapFiles) {
			await rm(join(heapDir, ...relPath.split('/')), { force: true });
		}
		for (const name of ['batch', 'incoming']) {
			const path = join(heapDir, name);
			if (existsSync(path) && (await readdir(path)).length === 0) await rmdir(path);
		}
	} finally {
		await page.close();
	}
});

test('header Upload assigns books to the required library and optional shelf with public visibility', async ({ page }) => {
	test.setTimeout(90_000);
	await signInRealAdmin(page);
	const trigger = page.getByRole('banner').getByRole('button', { name: 'Upload', exact: true });
	await trigger.click();
	const dialog = page.getByRole('dialog', { name: 'Upload books' });
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('#bh3-library')).toHaveAttribute('required', '');
	await dialog.locator('#bh3-library').selectOption(String(state.libraryID));
	await dialog.locator('#bh3-shelf').selectOption(String(state.shelfID));
	await expect(dialog.locator('#bh-upload-visibility')).toHaveValue('public');

	const file = (name: string) => join(state.uploadDir, `${name}.epub`);
	const chooser = page.waitForEvent('filechooser');
	await dialog.getByRole('button', { name: 'Select files' }).click();
	await (await chooser).setFiles([file('BH5 Upload One'), file('BH5 Upload Two'), file('BH5 Extra'), file('BH5 Existing copy')]);
	const list = dialog.getByRole('list', { name: 'Files to upload' });
	await expect(list.getByRole('listitem')).toHaveCount(4);
	await dialog.getByRole('button', { name: 'Remove BH5 Extra.epub' }).click();
	await expect(list.getByRole('listitem')).toHaveCount(3);
	// Selecting the same file again is ignored (same name, size and modification time).
	await dialog.getByTestId('bh3-file-input').setInputFiles([file('BH5 Upload One')]);
	await expect(list.getByRole('listitem')).toHaveCount(3);

	await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(dialog.getByTestId('bh3-result')).toHaveText('2 uploaded, 1 duplicate, 0 failed', { timeout: 30_000 });
	const first = list.getByRole('listitem').filter({ hasText: 'BH5 Upload One.epub' });
	await expect(first.getByTestId('bh3-row-status')).toHaveText('Uploaded “BH5 Upload One” — queued for library import');
	const duplicate = list.getByRole('listitem').filter({ hasText: 'BH5 Existing copy.epub' });
	await expect(duplicate.getByRole('link', { name: 'Already in your library' }))
		.toHaveAttribute('href', `/books/${state.existingBookID}`);

	for (const title of ['BH5 Upload One', 'BH5 Upload Two']) {
		let bookID = 0;
		await expect.poll(async () => {
			const job = (await imports(page)).find((item) => item.original_name === `${title}.epub`);
			bookID = job?.book_id ?? 0;
			return job?.status;
		}, { timeout: 30_000 }).toBe('imported');
		const response = await page.request.get(`/api/v1/books/${bookID}`);
		expect(response.ok()).toBe(true);
		const { book } = await response.json() as { book: { library_id: number; visibility: string } };
		expect(book.library_id).toBe(state.libraryID);
		expect(book.visibility).toBe('public');
		const shelves = await page.request.get(`/api/v1/books/${bookID}/shelves`);
		expect(shelves.ok()).toBe(true);
		const memberships = await shelves.json() as { shelves: { id: number }[] };
		expect(memberships.shelves.some((shelf) => shelf.id === state.shelfID)).toBe(true);
	}
	expect(existsSync(join(heapDir, 'BH5 Existing copy.epub'))).toBe(false);
	expect(existsSync(join(heapDir, 'BH5 Extra.epub'))).toBe(false);
	const items = await listHeap(page);
	expect(items.map((item) => item.title).sort()).toEqual(['BH5 Alpha', 'BH5 Beta']);

	await dialog.getByRole('link', { name: 'View Bookheap' }).click();
	await expect(page).toHaveURL('/bookheap');
	await expect(page.getByTestId('bh4-row')).toHaveCount(2);
});

test('Scan indexes files copied into the heap folder and reports counts', async ({ page }) => {
	test.setTimeout(90_000);
	await seedHeapFile('incoming/BH5 Scanned.epub', epubFixture('BH5 Scanned'));
	await seedHeapFile('incoming/BH5 Document.pdf', Buffer.concat([pdfFixture(), Buffer.from('\n%BH5 scan fixture\n')]));
	await seedHeapFile('incoming/BH5 Comic.cbz', cbzFixture());
	await seedHeapFile('incoming/readme.txt', Buffer.from('not a book'));
	await seedHeapFile('incoming/BH5 Broken.epub', Buffer.from('this is not a zip archive'));
	await signInRealAdmin(page);
	await page.goto('/bookheap');
	const summary = await runScan(page);
	await expect(summary).toContainText('Added: 4');
	await expect(summary).toContainText('Invalid: 1');
	await expect(summary).toContainText('Skipped: 1');
	await expect(summary).toContainText('Duplicates: 0');

	const rows = page.getByTestId('bh4-row');
	await expect(rows).toHaveCount(6);
	await expect(page.getByTestId('bh4-total')).toContainText('Files: 6');
	await expect(rows.filter({ hasText: 'BH5 Scanned' }).getByTestId('bh4-row-status')).toHaveText('Ready');
	await expect(rows.filter({ hasText: 'BH5 Broken' }).getByTestId('bh4-row-status')).toHaveText('Invalid');
	const formats = (await listHeap(page)).filter((item) =>
		item.rel_path === 'incoming/BH5 Document.pdf' || item.rel_path === 'incoming/BH5 Comic.cbz'
	);
	expect(formats).toHaveLength(2);
	expect(formats).toEqual(expect.arrayContaining([
		expect.objectContaining({ rel_path: 'incoming/BH5 Document.pdf', format: 'pdf', status: 'ready' }),
		expect.objectContaining({ rel_path: 'incoming/BH5 Comic.cbz', format: 'cbz', status: 'ready' })
	]));

	// All indexed formats remain unchanged on a second scan.
	const again = await runScan(page);
	await expect(again).toContainText('Added: 0');
	const latest = await page.request.get('/api/v1/admin/bookheap/scan');
	expect(latest.ok()).toBe(true);
	expect((await latest.json() as { scan: { unchanged: number } }).scan.unchanged).toBe(6);
	await expect(rows).toHaveCount(6);

	const deleted = await page.request.post('/api/v1/admin/bookheap/items/delete', {
		data: { ids: formats.map((item) => item.id) }
	});
	expect(deleted.status()).toBe(200);
	const { results } = await deleted.json() as { results: { ok: boolean }[] };
	expect(results).toHaveLength(2);
	expect(results.every((result) => result.ok)).toBe(true);
	await page.reload();
	await expect(rows).toHaveCount(4);
});

test('items selected across pages are assigned to a library and shelf and leave the heap', async ({ page }) => {
	test.setTimeout(240_000);
	for (let index = 1; index <= batchSize; index += 1) {
		await seedHeapFile(`batch/${batchTitle(index)}.epub`, epubFixture(batchTitle(index)));
	}
	await signInRealAdmin(page);
	await page.goto('/bookheap?status=ready');
	const summary = await runScan(page);
	await expect(summary).toContainText(`Added: ${batchSize}`);

	const main = page.getByRole('main');
	const rows = page.getByTestId('bh4-row');
	await expect(page.getByTestId('bh4-total')).toContainText(`Files: ${batchSize + 3}`);
	await expect(rows).toHaveCount(50);
	await main.getByRole('checkbox', { name: `Select ${batchTitle(1)}`, exact: true }).check();
	await main.getByRole('button', { name: 'Load more files' }).click();
	await expect(rows).toHaveCount(batchSize + 3);
	for (const title of ['BH5 Scanned', 'BH5 Alpha', 'BH5 Beta']) {
		await main.getByRole('checkbox', { name: `Select ${title}`, exact: true }).check();
	}
	await expect(page.getByTestId('bh4-selected-count')).toHaveText('Selected: 4');

	await page.getByTestId('bh4-bulk-bar').getByRole('button', { name: 'Assign…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Assign to a library' });
	await expect(dialog.getByTestId('bh4-assign-count')).toHaveText('Files to assign: 4');
	await dialog.getByLabel('Library').selectOption({ label: 'BH5 Library' });
	await dialog.getByLabel(/BH5 Shelf/).check();
	await dialog.getByRole('button', { name: 'Assign (4)' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId('bh4-notice')).toContainText('Queued for import: 4');

	await page.goto('/bookheap');
	for (const title of assignedTitles) {
		await expect(rows.filter({ hasText: title })).toHaveCount(0, { timeout: 60_000 });
	}
	await expect(page.getByTestId('bh4-total')).toContainText(`Files: ${batchSize}`);

	const jobs = (await imports(page)).filter((job) => job.source === 'bookheap' && job.library_id === state.libraryID &&
		assignedTitles.some((title) => job.original_name === `${title}.epub`));
	expect(jobs).toHaveLength(4);
	for (const job of jobs) expect(job, job.error ?? '').toMatchObject({ status: 'imported' });
	for (const file of assignedFiles) expect(existsSync(join(heapDir, ...file.split('/'))), file).toBe(false);
	expect(existsSync(join(heapDir, 'batch', `${batchTitle(2)}.epub`))).toBe(true);

	await page.goto(`/library/${state.libraryID}`);
	await expect(page.getByRole('heading', { name: 'BH5 Library' })).toBeVisible();
	for (const title of assignedTitles) await expect(page.getByTitle(title, { exact: true }).first()).toBeVisible();
	await page.goto(`/shelves/${state.shelfID}`);
	await expect(page.getByRole('heading', { name: 'BH5 Shelf' })).toBeVisible();
	for (const title of assignedTitles) await expect(page.getByTitle(title, { exact: true }).first()).toBeVisible();
	await page.goto('/books');
	for (const title of assignedTitles) await expect(page.getByTitle(title, { exact: true }).first()).toBeVisible();
	await page.goto('/search?q=BH5%20Alpha');
	await expect(page.getByRole('link', { name: 'BH5 Alpha', exact: true }).first()).toBeVisible();
	await page.goto('/admin/imports');
	const history = page.getByRole('listitem').filter({
		has: page.getByRole('heading', { name: 'BH5 Alpha.epub' })
	});
	await expect(history).toContainText('Bookheap');
	await expect(history).toContainText('BH5 Library');
});

test('bulk Delete removes an invalid item and its file', async ({ page }) => {
	await signInRealAdmin(page);
	await page.goto('/bookheap?status=invalid');
	const rows = page.getByTestId('bh4-row');
	await expect(rows).toHaveCount(1);
	await page.getByRole('main').getByRole('checkbox', { name: 'Select BH5 Broken', exact: true }).check();
	await page.getByTestId('bh4-bulk-bar').getByRole('button', { name: 'Delete…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Delete from the Bookheap' });
	await dialog.getByRole('button', { name: 'Delete (1)' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: 'Deleted from the Bookheap: 1.' })).toBeVisible();
	await expect(rows).toHaveCount(0);
	expect(existsSync(join(heapDir, 'incoming', 'BH5 Broken.epub'))).toBe(false);
	expect(existsSync(join(heapDir, 'incoming', 'readme.txt'))).toBe(true);
});

test('readers see neither Upload nor Bookheap and the heap API refuses them', async ({ page, browser }) => {
	await signInRealAdmin(page);
	const created = await page.request.post('/api/v1/admin/users', { data: {
		username: 'bh5-reader', password: 'bh5-reader-password', role: 'user', locale: 'en'
	} });
	expect(created.status()).toBe(201);
	const { user } = await created.json() as { user: { id: number } };
	const context = await browser.newContext();
	try {
		const reader = await context.newPage();
		await reader.goto('/login');
		await reader.getByLabel('Username', { exact: true }).fill('bh5-reader');
		await reader.getByLabel('Password', { exact: true }).fill('bh5-reader-password');
		await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(reader).toHaveURL('/');
		await expect(reader.getByRole('heading', { name: 'Dashboard', level: 1 })).toHaveClass('sr-only');
		await expect(reader.getByRole('banner').getByRole('button', { name: 'Upload' })).toHaveCount(0);
		await expect(reader.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Bookheap/ })).toHaveCount(0);
		for (const path of ['/api/v1/admin/bookheap/items', '/api/v1/admin/bookheap/scan']) {
			expect((await reader.request.get(path)).status(), path).toBe(403);
		}
		const origin = new URL(reader.url()).origin;
		for (const [path, data] of [
			['/api/v1/admin/bookheap/scan', {}],
			['/api/v1/admin/bookheap/items/delete', { ids: [1] }],
			['/api/v1/admin/bookheap/assign', { ids: [1], library_id: state.libraryID, shelf_ids: [] }]
		] as const) {
			expect((await reader.request.post(path, { data, headers: { Origin: origin } })).status(), path).toBe(403);
		}
		await reader.goto('/bookheap');
		await expect(reader.getByRole('alert')).toContainText(/administrator/i);
	} finally {
		await context.close();
		expect((await page.request.delete(`/api/v1/admin/users/${user.id}`)).ok()).toBe(true);
	}
});

test('the drop folder still imports into the library named by its subfolder', async ({ page }) => {
	test.setTimeout(60_000);
	await signInRealAdmin(page);
	const folder = join(dataDir, 'drop', state.librarySlug);
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, 'BH5 Dropped.epub'), epubFixture('BH5 Dropped'));
	await expect.poll(async () => {
		const job = (await imports(page)).find((item) => item.original_name === 'BH5 Dropped.epub');
		return job && `${job.source}:${job.status}`;
	}, { timeout: 45_000 }).toBe('drop_folder:imported');
	expect((await listHeap(page)).some((item) => item.title === 'BH5 Dropped')).toBe(false);
});
