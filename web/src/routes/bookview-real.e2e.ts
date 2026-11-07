import { expect, request as playwrightRequest, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { pdfFixture } from '../lib/reader/fixtures.js';
import { signInRealAdmin } from '../lib/real-auth.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');

const DAY = 86_400_000;

function zip(entries: Record<string, string | Buffer>): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [path, content] of Object.entries(entries)) {
		const name = Buffer.from(path);
		const data = typeof content === 'string' ? Buffer.from(content) : content;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x800, 6);
		header.writeUInt32LE(crc32(data), 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(name.length, 26);
		local.push(header, name, data);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(0x800, 8);
		directory.writeUInt32LE(crc32(data), 16);
		directory.writeUInt32LE(data.length, 20);
		directory.writeUInt32LE(data.length, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, name);
		offset += header.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

function png(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.writeUInt8(8, 8);
	header.writeUInt8(2, 9);
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([red, green, blue], 1 + x * 3);
	const pixels = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
	]);
}

function epub(title: string, author: string, cover = false): Buffer {
	const coverItem = cover ? '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>' : '';
	return zip({
		mimetype: 'application/epub+zip',
		'META-INF/container.xml': '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
		'OEBPS/book.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="id" opf:scheme="uuid">urn:uuid:${randomUUID()}</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>${coverItem}</manifest><spine><itemref idref="one"/></spine></package>`,
		'OEBPS/nav.xhtml': '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">One</a></li></ol></nav></body></html>',
		'OEBPS/one.xhtml': `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>${title}</h1><p>Book view fixture text.</p></body></html>`,
		...(cover ? { 'OEBPS/cover.png': png(60, 90, [32, 96, 160]) } : {})
	});
}

/** A unique trailer keeps each PDF's content hash distinct from other real-server specs. */
function uniquePdf(): Buffer {
	return Buffer.concat([pdfFixture(), Buffer.from(`%${randomUUID()}\n`)]);
}

function uuidv7(time = Date.now()): string {
	const bytes = randomBytes(16);
	bytes.writeUIntBE(time, 0, 6);
	bytes[6] = 0x70 | (bytes[6] & 0x0f);
	bytes[8] = 0x80 | (bytes[8] & 0x3f);
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface BookFile { id: number; format: string; original_filename: string }

async function waitForJob(api: APIRequestContext, jobID: number): Promise<number> {
	let bookID = 0;
	await expect.poll(async () => {
		const response = await api.get('/api/v1/imports?limit=100');
		const payload = await response.json() as { items: Array<{ id: number; status: string; book_id: number | null }> };
		const job = payload.items.find((item) => item.id === jobID);
		if (job?.status === 'failed') throw new Error(`Import failed: ${JSON.stringify(job)}`);
		bookID = job?.book_id ?? 0;
		return job?.status;
	}, { timeout: 30_000 }).toBe('imported');
	return bookID;
}

async function upload(api: APIRequestContext, path: string, name: string, bytes: Buffer, libraryID?: number) {
	const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
		file: { name, mimeType: 'application/octet-stream', buffer: bytes }
	};
	if (libraryID !== undefined) multipart.library_id = String(libraryID);
	const response = await api.post(path, { multipart });
	expect(response.status(), await response.text()).toBe(202);
	const { job } = await response.json() as { job: { id: number } };
	return waitForJob(api, job.id);
}

async function bookFiles(api: APIRequestContext, bookID: number) {
	const response = await api.get(`/api/v1/books/${bookID}`);
	expect(response.ok()).toBe(true);
	const { book } = await response.json() as { book: { title: string; files: BookFile[] } };
	return book;
}

async function push(api: APIRequestContext, mutations: Array<Record<string, unknown>>) {
	const response = await api.post('/api/v1/sync/push', { data: { mutations } });
	expect(response.ok(), await response.text()).toBe(true);
	const { results } = await response.json() as { results: Array<{ status: string; reason?: string }> };
	expect(results.map((result) => result.reason ?? result.status)).toEqual(mutations.map(() => 'applied'));
}

function session(bookID: number, startedAt: number, minutes: number, start: number, end: number) {
	return {
		entity: 'reading_sessions', id: uuidv7(startedAt), op: 'upsert', updated_at: startedAt + minutes * 60_000,
		data: {
			book_id: bookID, source: 'web', device: 'Seeded browser', started_at: startedAt,
			ended_at: startedAt + minutes * 60_000, active_seconds: minutes * 60,
			start_percentage: start, end_percentage: end
		}
	};
}

/** Two attempts: the first reaches 97%, the second restarts at 2%. */
function rereadSessions(bookID: number, now = Date.now()) {
	return [
		session(bookID, now - 12 * DAY, 40, 0, 0.5),
		session(bookID, now - 11 * DAY, 45, 0.5, 0.97),
		session(bookID, now - 4 * DAY, 20, 0.02, 0.2),
		session(bookID, now - 3 * DAY, 25, 0.2, 0.4)
	];
}

async function bookSessionCount(api: APIRequestContext, bookID: number) {
	const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
	const response = await api.get(`/api/v1/stats?from=${day(-60)}&to=${day(1)}&timezone=UTC`);
	expect(response.ok()).toBe(true);
	const stats = await response.json() as { time_per_book: Array<{ book_id: number; session_count: number; active_seconds: number }> };
	return stats.time_per_book.find((item) => item.book_id === bookID) ?? { session_count: 0, active_seconds: 0 };
}

const card = (scope: Page | Locator, title: string) => {
	const root = 'goto' in scope ? scope : scope.page();
	return scope.locator('li').filter({ has: root.getByRole('heading', { name: title, exact: true }) }).first();
};

interface Seed {
	libraryID: number;
	covered: { id: number; title: string; epub: BookFile };
	cjk: { id: number; title: string };
	pdf: { id: number; title: string; file: BookFile };
	multi: { id: number; title: string; epub: BookFile; pdf: BookFile };
	shelf: string;
}

async function seed(api: APIRequestContext, suffix: string): Promise<Seed> {
	const created = await api.post('/api/v1/admin/libraries', { data: { name: `Book View ${suffix}`, slug: `book-view-${suffix}` } });
	expect(created.status()).toBe(201);
	const { library } = await created.json() as { library: { id: number } };

	const coveredID = await upload(api, '/api/v1/uploads', 'BV Covered.epub', epub('BV Covered', 'Cover Writer', true), library.id);
	const cjkTitle = `熊猫图书馆的漫长旅程${'星光'.repeat(40)}`;
	const cjkID = await upload(api, '/api/v1/uploads', 'BV CJK.epub', epub(cjkTitle, '长标题作者'), library.id);
	const pdfID = await upload(api, '/api/v1/uploads', 'BV Plain PDF.pdf', uniquePdf(), library.id);
	const multiID = await upload(api, '/api/v1/uploads', 'BV Multi Format.epub', epub('BV Multi Format', 'Format Writer'), library.id);
	expect(await upload(api, `/api/v1/books/${multiID}/files`, 'BV Multi Format.pdf', uniquePdf())).toBe(multiID);

	const covered = await bookFiles(api, coveredID);
	const cjk = await bookFiles(api, cjkID);
	const pdf = await bookFiles(api, pdfID);
	const multi = await bookFiles(api, multiID);
	const byFormat = (files: BookFile[], format: string) => {
		const file = files.find((item) => item.format === format);
		if (!file) throw new Error(`Missing ${format} file`);
		return file;
	};

	const shelfName = `BV Collection ${suffix}`;
	const shelfResponse = await api.post('/api/v1/shelves', { data: { kind: 'private', mode: 'manual', name: shelfName } });
	expect(shelfResponse.status(), await shelfResponse.text()).toBe(201);
	const { shelf } = await shelfResponse.json() as { shelf: { id: number } };
	expect((await api.put(`/api/v1/shelves/${shelf.id}/books/${coveredID}`, { data: {} })).ok()).toBe(true);

	const now = Date.now();
	const coveredEpub = byFormat(covered.files, 'epub');
	const multiPdf = byFormat(multi.files, 'pdf');
	const pdfFile = byFormat(pdf.files, 'pdf');
	const firstHighlight = uuidv7(now - 3000);
	const secondHighlight = uuidv7(now - 2000);
	const thirdHighlight = uuidv7(now - 1000);
	const highlight = (id: string, page: number, position: number, text: string, chapter: string, color: string) => ({
		entity: 'highlights', id, op: 'upsert', updated_at: now,
		data: {
			book_id: pdfID, book_file_id: pdfFile.id, locator: { type: 'pdf', page }, position, text, color, chapter,
			created_at: now - 1000
		}
	});
	await push(api, [
		{ entity: 'user_books', id: String(coveredID), op: 'upsert', updated_at: now - 2 * DAY, data: { book_id: coveredID, status: 'reading', rating: 6 } },
		{
			entity: 'reading_progress', id: String(coveredID), op: 'upsert', updated_at: now - 3 * DAY,
			data: { book_id: coveredID, book_file_id: coveredEpub.id, source: 'web', locator: null, percentage: 0.4, device: 'Seeded browser', device_id: 'bookview-real' }
		},
		...rereadSessions(coveredID, now),
		{
			entity: 'reading_progress', id: String(multiID), op: 'upsert', updated_at: now - DAY,
			data: { book_id: multiID, book_file_id: multiPdf.id, source: 'web', locator: { type: 'pdf', page: 1 }, percentage: 0.33, device: 'Seeded browser', device_id: 'bookview-real' }
		},
		highlight(firstHighlight, 1, 0.1, 'First PDF page text', 'Opening chapter', 'yellow'),
		highlight(secondHighlight, 1, 0.2, 'PDF page opening words', 'Opening chapter', 'blue'),
		highlight(thirdHighlight, 2, 0.75, 'Second PDF page text', 'Closing chapter', 'red'),
		{ entity: 'notes', id: uuidv7(now), op: 'upsert', updated_at: now, data: { book_id: pdfID, highlight_id: thirdHighlight, body_md: 'A **seeded** note' } }
	]);

	return {
		libraryID: library.id,
		covered: { id: coveredID, title: covered.title, epub: coveredEpub },
		cjk: { id: cjkID, title: cjk.title },
		pdf: { id: pdfID, title: pdf.title, file: pdfFile },
		multi: { id: multiID, title: multi.title, epub: byFormat(multi.files, 'epub'), pdf: multiPdf },
		shelf: shelfName
	};
}

test('book view works end to end against the real server', async ({ page, browser }) => {
	test.setTimeout(240_000);
	await signInRealAdmin(page);
	const data = await seed(page.request, Date.now().toString(36));
	expect(data.covered.title).toBe('BV Covered');
	expect(data.multi.title).toBe('BV Multi Format');

	// Other real-server specs may have emptied the dashboard; restore the defaults for this account.
	await push(page.request, [{
		entity: 'user_settings', key: 'dashboard.layout.v1', op: 'upsert', updated_at: Date.now(),
		data: { value: { version: 1, sections: [{ id: 'continue_reading' }, { id: 'recently_added' }] } }
	}]);

	await test.step('covers and format badges on the dashboard', async () => {
		await page.goto('/');
		const recent = page.locator('[data-dashboard-section]').filter({ has: page.getByRole('heading', { name: 'Recently Added' }) });
		await expect(card(recent, data.multi.title).getByRole('img', { name: 'Formats: EPUB, PDF' })).toContainText('EPUB +1');
		const continuing = page.locator('[data-dashboard-section]').filter({ has: page.getByRole('heading', { name: 'Continue Reading' }) });
		await expect(card(continuing, data.covered.title).getByRole('img', { name: data.covered.title })).toBeVisible();
	});

	await test.step('covers and format badges on All Books', async () => {
		await page.goto('/books');
		const covered = card(page, data.covered.title);
		await expect(covered.getByRole('img', { name: data.covered.title })).toBeVisible();
		await expect.poll(() => covered.locator('img').first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await expect(covered.locator('[data-generated-cover]')).toHaveCount(0);
		await expect(covered.getByRole('img', { name: 'Formats: EPUB' })).toContainText('EPUB');
		const cjk = card(page, data.cjk.title);
		await expect(cjk.locator('[data-generated-cover]')).toBeVisible();
		await expect(cjk.locator('[data-generated-cover]')).toContainText('熊猫图书馆的漫长旅程');
		await expect(cjk.locator('[data-generated-cover]')).toContainText('长标题作者');
		const box = await cjk.boundingBox();
		const coverBox = await cjk.locator('[data-generated-cover]').boundingBox();
		expect(box && coverBox && coverBox.width <= box.width + 1).toBe(true);
		await expect(card(page, data.pdf.title).getByRole('img', { name: 'Formats: PDF' })).toContainText('PDF');
		await expect(card(page, data.multi.title).getByRole('img', { name: 'Formats: EPUB, PDF' })).toContainText('EPUB +1');
	});

	await test.step('quick view drawer shows real data and links to Details', async () => {
		const covered = card(page, data.covered.title);
		await covered.locator('.cover-frame').hover();
		await covered.getByRole('button', { name: `Quick view: ${data.covered.title}` }).click();
		const drawer = page.getByRole('dialog', { name: data.covered.title });
		await expect(drawer).toBeVisible();
		await expect(drawer.getByRole('region', { name: 'Collections' }).getByRole('link', { name: data.shelf })).toBeVisible();
		await expect(drawer.getByRole('region', { name: 'Primary file' })).toContainText(data.covered.epub.original_filename);
		await expect(drawer.getByRole('link', { name: 'Edit metadata' })).toBeVisible();
		await drawer.getByRole('link', { name: 'Details' }).click();
		await expect(page).toHaveURL(`/books/${data.covered.id}`);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('navigation', { name: 'Book sections' })).toBeVisible();
	});

	await test.step('Details tab saves rating and status', async () => {
		const rating = page.getByRole('radio', { name: '4 out of 5', exact: true });
		await rating.click();
		await expect(rating).toHaveAttribute('aria-checked', 'true');
		await page.getByRole('button', { name: /^Reading status:/ }).first().click();
		await page.getByRole('menuitemradio', { name: 'Finished' }).click();
		await expect(page.getByRole('button', { name: 'Reading status: Finished' }).first()).toBeVisible();
		await expect.poll(async () => {
			const response = await page.request.get(`/api/v1/me/books/${data.covered.id}`);
			const state = await response.json() as { user_book: { status: string; rating: number | null } | null };
			return state.user_book;
		}).toMatchObject({ status: 'finished', rating: 8 });
		await page.reload();
		await expect(page.getByRole('radio', { name: '4 out of 5', exact: true })).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByRole('button', { name: 'Reading status: Finished' }).first()).toBeVisible();
	});

	await test.step('Files tab groups formats and puts progress on the right file', async () => {
		await page.goto(`/books/${data.multi.id}/files`);
		const group = (name: string) => page.getByRole('region', { name, exact: true });
		await expect(page.locator('[aria-labelledby^="file-group-"] h3')).toHaveText(['Ebook', 'Document']);
		await expect(group('Document').getByText('33% read')).toBeVisible();
		await expect(group('Ebook').getByText('33% read')).toHaveCount(0);
		await expect(group('Ebook')).toContainText(data.multi.epub.original_filename);
		await expect(group('Document')).toContainText(data.multi.pdf.original_filename);
	});

	await test.step('Reading Log shows attempts, deletes and adds sessions', async () => {
		const before = await bookSessionCount(page.request, data.covered.id);
		expect(before.session_count).toBe(4);
		await page.goto(`/books/${data.covered.id}/reading-log?range=all`);
		await expect(page.getByRole('heading', { name: 'Reading summary' })).toBeVisible();
		await expect(page.getByText('Attempts 2', { exact: true })).toBeVisible();
		await expect(page.getByText(/Attempt 2 began/)).toBeVisible();
		await expect(page.getByText('Showing 4 of 4')).toBeVisible();
		page.once('dialog', (dialog) => void dialog.accept());
		await page.getByRole('button', { name: /Delete session from/ }).first().click();
		await expect(page.getByText('Showing 3 of 3')).toBeVisible();
		await expect.poll(async () => (await bookSessionCount(page.request, data.covered.id)).session_count).toBe(3);
		expect((await bookSessionCount(page.request, data.covered.id)).active_seconds).toBeLessThan(before.active_seconds);

		await page.getByRole('button', { name: 'Add session' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add session' });
		const yesterday = await page.evaluate(() => {
			const date = new Date(Date.now() - 86_400_000);
			return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
		});
		await dialog.getByLabel('Date', { exact: true }).fill(yesterday);
		await dialog.getByLabel('Start time').fill('09:00');
		await dialog.getByLabel('Duration (minutes)').fill('15');
		await dialog.getByRole('button', { name: 'Save session' }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByText('Showing 4 of 4')).toBeVisible();
		await expect.poll(async () => (await bookSessionCount(page.request, data.covered.id)).session_count).toBe(4);
	});

	await test.step('Highlights tab groups by chapter and opens the reader', async () => {
		await page.goto(`/books/${data.pdf.id}/highlights`);
		const list = page.getByRole('region', { name: 'Highlights by chapter' });
		await expect(list.getByRole('heading', { level: 2 })).toHaveText([/^Opening chapter/, /^Closing chapter/]);
		await expect(list.getByRole('listitem')).toHaveCount(3);
		await expect(list.locator('.reader-markdown strong')).toHaveText('seeded');
		const closing = list.getByRole('listitem').filter({ hasText: 'Second PDF page text' });
		await closing.getByRole('link', { name: 'Open' }).click();
		await expect(page).toHaveURL(new RegExp(`/read/${data.pdf.id}/${data.pdf.file.id}\\?highlight=`));
		await expect(page.locator('.reader-pdf-text')).toContainText('Second PDF page text');
	});

	await test.step('previous and next walk the All Books list', async () => {
		await page.goto('/books');
		await expect(card(page, data.covered.title)).toBeVisible();
		const ids = await page.getByRole('link', { name: 'Open book details' }).evaluateAll((links) =>
			links.map((link) => Number(new URL((link as HTMLAnchorElement).href).pathname.split('/')[2])));
		const index = ids.indexOf(data.covered.id);
		expect(index).toBeGreaterThan(-1);
		await card(page, data.covered.title).getByRole('link', { name: 'Open book details' }).click();
		await expect(page).toHaveURL(`/books/${data.covered.id}`);
		if (index < ids.length - 1) {
			await page.getByRole('button', { name: 'Next book' }).click();
			await expect(page).toHaveURL(`/books/${ids[index + 1]}`);
			await page.getByRole('button', { name: 'Previous book' }).click();
			await expect(page).toHaveURL(`/books/${data.covered.id}`);
		} else {
			await page.getByRole('button', { name: 'Previous book' }).click();
			await expect(page).toHaveURL(`/books/${ids[index - 1]}`);
		}
	});

	await test.step('admins can still open the metadata editor', async () => {
		await page.goto(`/books/${data.covered.id}`);
		await page.getByRole('link', { name: 'Edit metadata' }).click();
		await expect(page).toHaveURL(`/books/${data.covered.id}/edit`);
		await expect(page.getByRole('heading', { name: `Edit metadata: ${data.covered.title}` })).toBeVisible();
	});

	await test.step('non-admins see no edit controls and cannot probe hidden books', async () => {
		const username = `bv-reader-${Date.now().toString(36)}`;
		const created = await page.request.post('/api/v1/admin/users', { data: { username, password: 'bv-reader-password', role: 'user', locale: 'en' } });
		expect(created.status(), await created.text()).toBe(201);
		const { user } = await created.json() as { user: { id: number } };
		expect((await page.request.put(`/api/v1/admin/libraries/${data.libraryID}/access/${user.id}`, { data: {} })).ok()).toBe(true);
		expect((await page.request.put(`/api/v1/admin/users/${user.id}/hidden-books/${data.cjk.id}`, { data: {} })).ok()).toBe(true);
		const context = await browser.newContext();
		try {
			const reader = await context.newPage();
			await reader.goto('/login');
			await reader.getByLabel('Username', { exact: true }).fill(username);
			await reader.getByLabel('Password', { exact: true }).fill('bv-reader-password');
			await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
			await expect(reader).toHaveURL('/');
			await reader.goto(`/books/${data.covered.id}`);
			await expect(reader.getByRole('heading', { name: data.covered.title, level: 1 })).toBeVisible();
			await expect(reader.getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
			expect((await reader.request.get(`/api/v1/books/${data.covered.id}/shelves`)).status()).toBe(200);
			expect((await reader.request.get(`/api/v1/books/${data.cjk.id}/shelves`)).status()).toBe(404);
			await reader.goto('/books');
			await expect(card(reader, data.covered.title)).toBeVisible();
			await expect(card(reader, data.cjk.title)).toHaveCount(0);
			const covered = card(reader, data.covered.title);
			await covered.locator('.cover-frame').hover();
			await covered.getByRole('button', { name: `Quick view: ${data.covered.title}` }).click();
			const drawer = reader.getByRole('dialog', { name: data.covered.title });
			await expect(drawer.getByRole('region', { name: 'Primary file' })).toBeVisible();
			await expect(drawer.getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
		} finally {
			await context.close();
		}
	});
});

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('No port');
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return address.port;
}

interface RunningServer { child: ChildProcess; origin: string; setupToken?: string }

async function startServer(dataDir: string): Promise<RunningServer> {
	const port = await unusedPort();
	const origin = `http://127.0.0.1:${port}`;
	const child = spawn(process.env.PANDA_E2E_BINARY!, ['serve'], {
		env: {
			...process.env, PANDA_DATA_DIR: dataDir, PANDA_LISTEN: `127.0.0.1:${port}`, PANDA_BASE_URL: origin,
			PANDA_DROP_DIR: join(dataDir, 'drop'), PANDA_DROP_POLL: '0', PANDA_AUTO_MIGRATE: 'true',
			PANDA_LOG_LEVEL: 'info', PANDA_TRUSTED_PROXIES: ''
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const server: RunningServer = { child, origin };
	let buffer = '';
	const append = (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? '';
		for (const line of lines) server.setupToken ??= line.match(/"setup_token"\s*:\s*"([^"]+)"/)?.[1];
	};
	child.stdout?.on('data', append);
	child.stderr?.on('data', append);
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error('Server exited before readiness');
		try {
			if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return server;
		} catch {
			// The server is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	child.kill();
	throw new Error('Server did not become healthy');
}

async function stopServer(server: RunningServer) {
	if (server.child.exitCode !== null) return;
	const exited = new Promise((resolve) => server.child.once('exit', resolve));
	server.child.kill();
	await exited;
}

async function signedInApi(server: RunningServer): Promise<APIRequestContext> {
	const api = await playwrightRequest.newContext({ baseURL: server.origin, extraHTTPHeaders: { Origin: server.origin } });
	const credentials = { username: 'restart-admin', password: 'restart-test-password' };
	const response = server.setupToken
		? await api.post('/api/v1/setup', { data: { token: server.setupToken, display_name: 'Restart Admin', locale: 'en', ...credentials } })
		: await api.post('/api/v1/auth/login', { data: credentials });
	expect(response.ok(), await response.text()).toBe(true);
	return api;
}

test('reading summary and sessions survive a server restart', async () => {
	test.setTimeout(150_000);
	const dataDir = await mkdtemp(join(tmpdir(), 'pandalibrary-bookview-restart-'));
	let server: RunningServer | undefined;
	try {
		server = await startServer(dataDir);
		let api = await signedInApi(server);
		const created = await api.post('/api/v1/admin/libraries', { data: { name: 'Restart', slug: 'restart' } });
		expect(created.status()).toBe(201);
		const { library } = await created.json() as { library: { id: number } };
		const bookID = await upload(api, '/api/v1/uploads', 'Restart.epub', epub('Restart Book', 'Restart Writer'), library.id);
		await push(api, rereadSessions(bookID));
		const snapshot = async (client: APIRequestContext) => {
			const summary = await client.get(`/api/v1/me/books/${bookID}/reading-summary?timezone=UTC`);
			const sessions = await client.get(`/api/v1/me/books/${bookID}/sessions?range=all&timezone=UTC&limit=100`);
			expect(summary.ok()).toBe(true);
			expect(sessions.ok()).toBe(true);
			return { summary: await summary.json(), sessions: await sessions.json() };
		};
		const before = await snapshot(api);
		expect(before.summary.summary.attempts).toHaveLength(2);
		expect(before.sessions.total).toBe(4);
		await api.dispose();
		await stopServer(server);

		server = await startServer(dataDir);
		api = await signedInApi(server);
		expect(await snapshot(api)).toEqual(before);
		await api.dispose();
	} finally {
		if (server) await stopServer(server);
		await rm(dataDir, { recursive: true, force: true });
	}
});
