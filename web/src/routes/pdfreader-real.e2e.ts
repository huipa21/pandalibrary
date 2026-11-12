import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { argon2Sync, createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { Book } from '../lib/catalog/types.js';
import type { BookState, Setting } from '../lib/reader/types.js';
import {
	cbzFixture, epubFixture, mixedPdfFixture, pdfFixture, pngFixture, scannedFixtureImage, scannedPdfFixture
} from '../lib/reader/fixtures.js';
import { signInRealAdmin } from '../lib/real-auth.js';
import { push, uuidv7 } from '../lib/real-fixtures.js';
import {
	jumpToPdfPage, openAnnotationsPanel, openedPdf, pdfPageBox, pdfPageText,
	selectPdfText, selectionToolbar
} from '../lib/real-pdf.js';

declare global {
	interface Window { pv11PaintSamples?: number[] }
}

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled real server');
test.use({ viewport: { width: 1440, height: 900 } });

async function checked(response: Awaited<ReturnType<APIRequestContext['get']>>, status = 200) {
	expect(response.status(), await response.text()).toBe(status);
	return response;
}

async function createLibrary(page: Page) {
	await signInRealAdmin(page);
	const suffix = randomUUID().slice(0, 8);
	const response = await checked(await page.request.post('/api/v1/admin/libraries', {
		data: { name: `PV11 ${suffix}`, slug: `pv11-${suffix}` }
	}), 201);
	return (await response.json() as { library: { id: number } }).library.id;
}

async function upload(page: Page, libraryID: number, name: string, contents: Buffer, format = 'pdf') {
	const suffix = Buffer.from(randomUUID());
	let bytes: Buffer;
	if (format === 'pdf') {
		bytes = Buffer.concat([contents, Buffer.from(`\n%${suffix.toString()}\n`)]);
	} else {
		const end = contents.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
		if (end < 0 || end + 22 !== contents.length) throw new Error('The fixture ZIP has no empty end comment.');
		const zip = Buffer.from(contents);
		zip.writeUInt16LE(suffix.length, end + 20);
		bytes = Buffer.concat([zip, suffix]);
	}
	const response = await checked(await page.request.post('/api/v1/uploads', {
		multipart: {
			library_id: String(libraryID),
			file: { name: `${name}.${format}`, mimeType: 'application/octet-stream', buffer: bytes }
		}
	}), 202);
	const { job } = await response.json() as { job: { id: number } };
	let bookID = 0;
	await expect.poll(async () => {
		const result = await checked(await page.request.get('/api/v1/imports?limit=100'));
		const { items } = await result.json() as {
			items: Array<{ id: number; status: string; book_id: number | null; error: string | null }>
		};
		const item = items.find((entry) => entry.id === job.id);
		if (item?.status === 'failed') throw new Error(`${format.toUpperCase()} import failed: ${item.error}`);
		bookID = item?.book_id ?? 0;
		return item?.status;
	}, { timeout: 60_000 }).toBe('imported');
	const result = await checked(await page.request.get(`/api/v1/books/${bookID}`));
	return { book: (await result.json() as { book: Book }).book, bytes };
}

async function state(api: APIRequestContext, bookID: number): Promise<BookState> {
	return await (await checked(await api.get(`/api/v1/me/books/${bookID}`))).json() as BookState;
}

async function setting(api: APIRequestContext, key: string) {
	const result = await checked(await api.get('/api/v1/me/settings'));
	const { settings } = await result.json() as { settings: Setting[] };
	return settings.find((entry) => entry.key === key)?.value;
}

async function openViewMenu(page: Page, name: 'Zoom' | 'Page display' | 'Rotate') {
	if ((page.viewportSize()?.width ?? 0) < 640) {
		const more = page.getByRole('button', { name: 'More view options', exact: true });
		if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
		await page.getByRole('menuitem', { name, exact: true }).click();
	} else {
		await page.getByRole('button', { name, exact: true }).click();
	}
}

async function closeViewMenu(page: Page) {
	await page.keyboard.press('Escape');
	const more = page.getByRole('button', { name: 'More view options', exact: true });
	if (await more.isVisible() && await more.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape');
}

async function setLayout(page: Page, label: string) {
	await openViewMenu(page, 'Page display');
	await page.getByRole('menuitemradio', { name: label, exact: true }).click();
}

async function setZoom(page: Page, label: string) {
	await openViewMenu(page, 'Zoom');
	await page.getByRole('menuitemradio', { name: label, exact: true }).click();
}

async function verifySyncedView(
	browser: Browser, source: Page, book: Book,
	expected: { layout?: string; zoom?: string; freeZoom?: number; rotation?: number; background?: string }
) {
	const context = await browser.newContext({
		baseURL: new URL(source.url()).origin, storageState: await source.context().storageState(),
		viewport: { width: 1440, height: 900 }
	});
	try {
		const page = await context.newPage();
		await page.goto(`/read/${book.id}/${book.files[0].id}`);
		await openedPdf(page);
		if (expected.layout) {
			await page.getByRole('button', { name: 'Page display', exact: true }).click();
			if (expected.layout) {
				await expect(page.getByRole('menuitemradio', { name: expected.layout, exact: true }))
					.toHaveAttribute('aria-checked', 'true');
			}
			await page.keyboard.press('Escape');
		}
		if (expected.background) {
			await expect(page.locator('#reader-surface')).toHaveAttribute('data-background', expected.background);
		}
		if (expected.zoom) {
			await page.getByRole('button', { name: 'Zoom', exact: true }).click();
			await expect(page.getByRole('menuitemradio', { name: expected.zoom, exact: true }))
				.toHaveAttribute('aria-checked', 'true');
			await page.keyboard.press('Escape');
		}
		if (expected.freeZoom !== undefined) {
			await expect(page.getByRole('button', { name: 'Zoom', exact: true }))
				.toHaveText(`${Math.round(expected.freeZoom * 100)}%`);
		}
		if (expected.rotation !== undefined) {
			await expect(page.locator('.textLayer').first()).toHaveAttribute('data-main-rotation', String(expected.rotation));
		}
	} finally {
		await context.close();
	}
}

async function chooseInsert(page: Page, name: 'Text' | 'Draw' | 'Image', x = 0.2, y = 0.3) {
	await page.keyboard.press('Escape');
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('i');
	await page.getByRole('menuitem', { name, exact: true }).click();
	const pdf = page.locator('.reader-pdf-page[data-page="1"]');
	const box = await pdf.boundingBox();
	if (!box) throw new Error('The PDF page is unavailable.');
	await page.mouse.click(box.x + box.width * x, box.y + Math.min(box.height * y, 250));
}

async function addText(page: Page, text: string) {
	await chooseInsert(page, 'Text');
	const editor = page.getByRole('textbox', { name: 'Text', exact: true });
	await editor.fill(text);
	await editor.press('Control+Enter');
	await expect(page.getByRole('img', { name: `Text note: ${text}`, exact: true })).toBeVisible();
	await expect(page.locator('#reader-surface')).toHaveAttribute('data-tool', 'select');
}

async function addInk(page: Page) {
	await chooseInsert(page, 'Draw', 0.45, 0.45);
	const drawing = page.getByRole('application', { name: 'Draw', exact: true });
	const box = await drawing.boundingBox();
	if (!box) throw new Error('The drawing surface is unavailable.');
	const x = Math.max(box.x + 30, 30);
	const y = Math.max(box.y + 180, 180);
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 80, y + 30, { steps: 10 });
	await page.mouse.up();
	await page.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(page.getByRole('img', { name: 'Drawing', exact: true })).toBeVisible();
	await expect(page.locator('#reader-surface')).toHaveAttribute('data-tool', 'select');
}

test('real PDF frame, link, saved offset, KOReader and synchronized view settings', async ({ page, browser }) => {
	test.setTimeout(240_000);
	const library = await createLibrary(page);
	const { book, bytes } = await upload(page, library, 'PV11 Text', pdfFixture(4, true));
	const other = await upload(page, library, 'PV11 Format Default', pdfFixture(3));
	const path = `/books/${book.id}`;
	await page.goto('/books?sort=added');
	await page.getByTitle(book.title, { exact: true }).first().click();
	await expect(page).toHaveURL(path);
	const back = page.getByRole('navigation', { name: 'Book sections' }).locator('a').first();
	await expect(back).toHaveAttribute('href', '/books?sort=added');
	await page.getByRole('button', { name: 'Read', exact: true }).click();
	await openedPdf(page, 1, 'First PDF page text');
	await expect(page.locator('.shell-header-band')).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Back to book details' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Close reader', exact: true })).toHaveCSS('border-top-width', '0px');
	await expect(page.getByLabel(/^Progress \d+\.\d{2}%$/)).toBeVisible();

	const link = page.locator('.reader-pdf-page[data-page="1"] .annotationLayer a').first();
	await expect(link).toBeVisible();
	await link.click();
	await expect(pdfPageBox(page)).toHaveValue('2');
	await expect(pdfPageText(page, 2)).toContainText('Second PDF page text');
	await jumpToPdfPage(page, 3);
	await expect(pdfPageText(page, 3)).toContainText('Page 3 PDF page text');
	await jumpToPdfPage(page, 2);
	await expect(pdfPageText(page, 2)).toContainText('Second PDF page text');
	await setLayout(page, 'Single page continuous');
	await setZoom(page, 'Actual size');
	await page.locator('#reader-surface').evaluate((surface) => { surface.scrollTop += 150; });
	await expect.poll(async () => {
		const label = await page.getByLabel(/^Progress /).getAttribute('aria-label');
		return label;
	}).not.toBe('Progress 33.33%');
	await page.getByRole('button', { name: 'Close reader', exact: true }).click();
	await expect(page).toHaveURL(path);
	await expect(back).toHaveAttribute('href', '/books?sort=added');
	await expect.poll(async () => (await state(page.request, book.id)).progress?.locator).toMatchObject({
		type: 'pdf', page: 2, offset: expect.any(Number)
	});
	const progress = (await state(page.request, book.id)).progress;
	const locator = progress?.locator as { page: number; offset: number };
	expect(locator.offset).toBeGreaterThan(0);
	expect(locator.offset).toBeLessThan(1);
	await back.click();
	await expect(page).toHaveURL('/books?sort=added');

	const app = await checked(await page.request.post('/api/v1/me/app-passwords', {
		data: { kind: 'kosync', label: 'PV11 KOReader' }
	}), 201);
	const { app_password } = await app.json() as { app_password: { secret: string } };
	const document = createHash('md5').update(bytes).digest('hex');
	const key = createHash('md5').update(app_password.secret.replaceAll('-', '')).digest('hex');
	const ko = await checked(await page.request.get(`/kosync/syncs/progress/${document}`, {
		headers: { 'X-Auth-User': 'integration-admin', 'X-Auth-Key': key }
	}));
	expect(await ko.json()).toMatchObject({ progress: '2', percentage: progress?.percentage });

	await page.goto(`/read/${book.id}/${book.files[0].id}`);
	await openedPdf(page, 2, 'Second PDF page text');
	for (const [label, value] of [
		['Single page', 'single'], ['Split', 'split'],
		['Split continuous', 'split-continuous'], ['Single page continuous', 'single-continuous']
	] as const) {
		await setLayout(page, label);
		await expect(page.locator('#reader-surface')).toHaveAttribute('data-layout', value);
		await expect.poll(() => setting(page.request, `reader.book.${book.id}`)).toMatchObject({ pdfLayout: value });
		await page.reload();
		await openedPdf(page);
		await expect(page.locator('#reader-surface')).toHaveAttribute('data-layout', value);
		await verifySyncedView(browser, page, book, { layout: label });
	}
	await setLayout(page, 'Split');
	await page.getByRole('button', { name: 'Format', exact: true }).click();
	await page.getByRole('radio', { name: 'Eye-care green', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect.poll(() => setting(page.request, `reader.book.${book.id}`)).toMatchObject({ background: 'green', theme: 'light' });
	await page.reload();
	await openedPdf(page);
	await verifySyncedView(browser, page, book, { layout: 'Split', background: 'green' });
	await setLayout(page, 'Single page continuous');
	for (const [label, value] of [
		['Automatic', 'auto'], ['Actual size', 'page-actual'],
		['Fit page', 'page-fit'], ['Page width', 'page-width']
	] as const) {
		await setZoom(page, label);
		await expect.poll(() => setting(page.request, `reader.book.${book.id}`)).toMatchObject({ pdfZoom: value });
		await page.reload();
		await openedPdf(page);
		await page.getByRole('button', { name: 'Zoom', exact: true }).click();
		await expect(page.getByRole('menuitemradio', { name: label, exact: true })).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
		await verifySyncedView(browser, page, book, { zoom: label });
	}
	await page.getByRole('button', { name: 'Zoom', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Zoom in', exact: true }).click();
	await page.keyboard.press('Escape');
	const readFreeZoom = async () => {
		const value = await setting(page.request, `reader.book.${book.id}`);
		if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
		return typeof value.pdfZoom === 'number' ? value.pdfZoom : undefined;
	};
	await expect.poll(readFreeZoom).toEqual(expect.any(Number));
	const freeZoom = await readFreeZoom();
	if (freeZoom === undefined) throw new Error('Free zoom was not saved.');
	await page.reload();
	await openedPdf(page);
	await expect(page.getByRole('button', { name: 'Zoom', exact: true }))
		.toHaveText(`${Math.round(freeZoom * 100)}%`);
	await verifySyncedView(browser, page, book, { freeZoom });
	await setZoom(page, 'Page width');
	await expect.poll(() => setting(page.request, `reader.book.${book.id}`)).toMatchObject({ pdfZoom: 'page-width' });

	for (const [direction, rotation] of [
		['Rotate right', 90], ['Rotate right', 180], ['Rotate right', 270], ['Rotate right', 0],
		['Rotate left', 270], ['Rotate right', 0], ['Rotate right', 90]
	] as const) {
		await page.getByRole('button', { name: 'Rotate', exact: true }).click();
		await page.getByRole('menuitem', { name: direction, exact: true }).click();
		await expect.poll(() => setting(page.request, `reader.book.${book.id}`)).toMatchObject({ pdfRotation: rotation });
		await page.reload();
		await openedPdf(page);
		await expect(page.locator('.textLayer').first()).toHaveAttribute('data-main-rotation', String(rotation));
		await verifySyncedView(browser, page, book, { rotation });
	}

	const context = await browser.newContext({
		baseURL: new URL(page.url()).origin, storageState: await page.context().storageState(),
		viewport: { width: 1440, height: 900 }
	});
	try {
		const second = await context.newPage();
		await second.goto(`/read/${book.id}/${book.files[0].id}`);
		await openedPdf(second);
		await expect(second.locator('#reader-surface')).toHaveAttribute('data-layout', 'single-continuous');
		await expect(second.locator('.textLayer').first()).toHaveAttribute('data-main-rotation', '90');
		await second.getByRole('button', { name: 'Zoom', exact: true }).click();
		await expect(second.getByRole('menuitemradio', { name: 'Page width', exact: true })).toHaveAttribute('aria-checked', 'true');
		await second.goto(`/read/${other.book.id}/${other.book.files[0].id}`);
		await openedPdf(second);
		await expect(second.locator('#reader-surface')).toHaveAttribute('data-layout', 'single-continuous');
		await expect(second.locator('.textLayer').first()).toHaveAttribute('data-main-rotation', '0');
		await second.getByRole('button', { name: 'Zoom', exact: true }).click();
		await expect(second.getByRole('menuitemradio', { name: 'Page width', exact: true })).toHaveAttribute('aria-checked', 'true');
	} finally {
		await context.close();
	}
});

async function exerciseSelectionActions(page: Page, book: Book, text: string) {
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	await selectPdfText(page, text);
	await selectionToolbar(page).getByRole('button', { name: 'Copy', exact: true }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(text);
	await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
	await page.getByRole('radio', { name: 'Blue', exact: true }).click();
	await expect.poll(async () => (await state(page.request, book.id)).highlights.length).toBe(1);
	for (const action of ['Highlight', 'Underline', 'Strikeout'] as const) {
		await selectPdfText(page, text);
		await selectionToolbar(page).getByRole('button', { name: action, exact: true }).click();
		await expect(selectionToolbar(page)).toHaveCount(0);
	}
	await selectPdfText(page, text);
	await selectionToolbar(page).getByRole('button', { name: 'Comment', exact: true }).click();
	const comment = page.getByRole('dialog', { name: 'Add comment', exact: true });
	await comment.getByRole('textbox').fill(`PV11 comment: ${text}`);
	await comment.getByRole('button', { name: 'Save note' }).click();
	await expect(comment).toHaveCount(0);
	await selectPdfText(page, text);
	await selectionToolbar(page).getByRole('button', { name: 'Bookmark', exact: true }).click();
	await expect.poll(async () => {
		const saved = await state(page.request, book.id);
		return {
			styles: saved.highlights.map((row) => row.style).sort(),
			notes: saved.notes.map((row) => row.body_md),
			bookmarks: saved.bookmarks.length
		};
	}).toEqual({
		styles: ['highlight', 'highlight', 'highlight', 'strikeout', 'underline'],
		notes: [`PV11 comment: ${text}`], bookmarks: 1
	});
	expect((await state(page.request, book.id)).highlights.map((row) => `${row.style}:${row.color}`).sort()).toEqual([
		'highlight:blue', 'highlight:blue', 'highlight:blue', 'strikeout:#000000', 'underline:#000000'
	]);
}

test('selection actions, comments, bookmarks, Highlights and export work on true and OCR text', async ({ page }) => {
	test.setTimeout(240_000);
	const library = await createLibrary(page);
	const trueBook = await upload(page, library, 'PV11 Marks', pdfFixture(2));
	const scan = await upload(page, library, 'PV11 Scanned', scannedPdfFixture([await scannedFixtureImage(page)]));
	await page.goto(`/read/${trueBook.book.id}/${trueBook.book.files[0].id}`);
	await openedPdf(page, 1, 'First PDF page text');
	await setLayout(page, 'Single page');
	await setZoom(page, 'Fit page');
	const surface = page.locator('#reader-surface');
	await page.getByRole('button', { name: 'Select tool', exact: true }).click();
	await expect(surface).toHaveAttribute('data-tool', 'hand');
	await page.getByRole('button', { name: 'Hand tool', exact: true }).click();
	await expect(surface).toHaveAttribute('data-tool', 'select');
	await exerciseSelectionActions(page, trueBook.book, 'First PDF page text');
	await page.goto(`/books/${trueBook.book.id}/highlights`);
	await expect(page.getByText('Underline', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('Strikeout', { exact: true }).first()).toBeVisible();
	const exported = await checked(await page.request.get(`/api/v1/me/notes/export?book_ids=${trueBook.book.id}`));
	const markdown = await exported.text();
	expect(markdown).toContain('**Underline**');
	expect(markdown).toContain('**Strikeout**');
	expect(markdown).toContain('PV11 comment: First PDF page text');

	await page.goto(`/read/${scan.book.id}/${scan.book.files[0].id}`);
	await openedPdf(page);
	await expect(page.locator('.pv-ocr-text')).toContainText('Scanned', { timeout: 90_000 });
	await expect(page.locator('.pv-ocr-text')).toContainText('扫描', { timeout: 90_000 });
	await exerciseSelectionActions(page, scan.book, 'Scanned');
});

test('real text, ink and image inserts sync privately and asset GC retains references', async ({ page, browser }) => {
	test.setTimeout(180_000);
	const library = await createLibrary(page);
	const { book } = await upload(page, library, 'PV11 Inserts', pdfFixture(2));
	await page.goto(`/read/${book.id}/${book.files[0].id}`);
	await openedPdf(page, 1, 'First PDF page text');
	await setLayout(page, 'Single page');
	await setZoom(page, 'Fit page');
	await addText(page, 'PV11 private text');
	await addInk(page);
	const chooser = page.waitForEvent('filechooser');
	const uploadResponse = page.waitForResponse((response) =>
		response.url().endsWith('/api/v1/me/annotation-assets') && response.request().method() === 'POST'
	);
	await chooseInsert(page, 'Image', 0.65, 0.55);
	await (await chooser).setFiles({
		name: 'pv11.png', mimeType: 'image/png', buffer: pngFixture(120, 60, [28, 144, 99])
	});
	const uploaded = await uploadResponse;
	expect([200, 201]).toContain(uploaded.status());
	await expect(page.getByRole('img', { name: 'Image', exact: true }).locator('img')).toHaveJSProperty('complete', true);
	await expect.poll(async () => (await state(page.request, book.id)).page_annotations?.map((row) => row.kind).sort())
		.toEqual(['image', 'ink', 'text']);
	const rows = (await state(page.request, book.id)).page_annotations ?? [];
	const image = rows.find((row) => row.kind === 'image');
	if (!image || image.kind !== 'image') throw new Error('The saved image annotation is missing.');
	const asset = image.data.asset;
	const download = await checked(await page.request.get(`/api/v1/me/annotation-assets/${asset}`));
	expect(download.headers()['cache-control']).toContain('no-store');
	expect(createHash('sha256').update(await download.body()).digest('hex')).toBe(asset);
	const exported = await checked(await page.request.get(`/api/v1/me/notes/export?book_ids=${book.id}`));
	expect(await exported.text()).toContain('PV11 private text');

	const secondContext = await browser.newContext({
		baseURL: new URL(page.url()).origin, storageState: await page.context().storageState()
	});
	try {
		const second = await secondContext.newPage();
		await second.goto(`/read/${book.id}/${book.files[0].id}`);
		await openedPdf(second);
		await expect(second.getByRole('img', { name: 'Text note: PV11 private text' })).toBeVisible();
		await expect(second.getByRole('img', { name: 'Drawing', exact: true })).toBeVisible();
		await expect(second.getByRole('img', { name: 'Image', exact: true }).locator('img')).toHaveJSProperty('complete', true);
	} finally {
		await secondContext.close();
	}

	const username = `pv11-reader-${randomUUID().slice(0, 8)}`;
	const password = 'pv11-reader-test-password';
	const userResponse = await checked(await page.request.post('/api/v1/admin/users', {
		data: { username, password, display_name: 'PV11 Reader', role: 'user', locale: 'en' }
	}), 201);
	const { user } = await userResponse.json() as { user: { id: number } };
	await checked(await page.request.put(`/api/v1/admin/libraries/${library}/access/${user.id}`, { data: {} }));
	const privateContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
	try {
		const reader = await privateContext.newPage();
		await reader.goto('/login');
		await reader.getByLabel('Username', { exact: true }).fill(username);
		await reader.getByLabel('Password', { exact: true }).fill(password);
		await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(reader).toHaveURL('/');
		expect((await state(reader.request, book.id)).page_annotations).toEqual([]);
		await checked(await reader.request.get(`/api/v1/me/annotation-assets/${asset}`), 404);
		await reader.goto(`/read/${book.id}/${book.files[0].id}`);
		await openedPdf(reader);
		await expect(reader.getByRole('img', { name: 'Drawing', exact: true })).toHaveCount(0);
		await expect(reader.getByRole('img', { name: 'Image', exact: true })).toHaveCount(0);
	} finally {
		await privateContext.close();
	}

	const orphanBytes = pngFixture(21, 17, [180, 32, 54]);
	const orphanResponse = await checked(await page.request.post('/api/v1/me/annotation-assets', {
		headers: { 'Content-Type': 'image/png' }, data: orphanBytes
	}), 201);
	const orphan = (await orphanResponse.json() as { asset: { sha256: string } }).asset.sha256;
	expect(await (await checked(await page.request.get(`/api/v1/me/annotation-assets/${orphan}`))).body()).toEqual(orphanBytes);
	const dataDir = process.env.PANDA_E2E_DATA_DIR;
	if (!dataDir) throw new Error('The isolated real-server data directory is unavailable.');
	const database = new DatabaseSync(join(dataDir, 'pandalibrary.db'));
	try {
		database.exec('PRAGMA busy_timeout = 5000');
		database.prepare('UPDATE annotation_assets SET created_at = ? WHERE sha256 IN (?, ?)')
			.run(Date.now() - 25 * 60 * 60 * 1000, asset, orphan);
	} finally {
		database.close();
	}
	const run = await checked(await page.request.post('/api/v1/admin/maintenance/annotation-assets-gc'), 202);
	const runID = (await run.json() as { run: { id: string } }).run.id;
	await expect.poll(async () => {
		const response = await checked(await page.request.get('/api/v1/admin/maintenance'));
		const { jobs } = await response.json() as {
			jobs: Array<{ name: string; last_run: { id: string; status: string } | null }>
		};
		const last = jobs.find((job) => job.name === 'annotation-assets-gc')?.last_run;
		return last?.id === runID ? last.status : null;
	}, { timeout: 30_000 }).toBe('completed');
	await checked(await page.request.get(`/api/v1/me/annotation-assets/${asset}`));
	await checked(await page.request.get(`/api/v1/me/annotation-assets/${orphan}`), 404);
});

test('downloaded PDF queues marks, text and ink offline and syncs them on reconnect', async ({ page, context }) => {
	test.setTimeout(180_000);
	const library = await createLibrary(page);
	const { book } = await upload(page, library, 'PV11 Offline', pdfFixture(2));
	await page.goto(`/books/${book.id}/files`);
	const filePanel = page.getByRole('region', { name: 'This file' });
	await filePanel.getByRole('button', { name: /^Actions for / }).click();
	await filePanel.getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect(page.getByText('Book file downloaded for offline reading.', { exact: true })).toBeVisible();
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) =>
			navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
	});
	await page.goto(`/read/${book.id}/${book.files[0].id}`);
	await openedPdf(page, 1, 'First PDF page text');
	await setLayout(page, 'Single page');
	await setZoom(page, 'Fit page');
	await context.setOffline(true);
	await expect(page.getByRole('button', { name: 'Reader sync status' })).toBeVisible();
	await selectPdfText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Underline', exact: true }).click();
	await expect(page.locator('.reader-pdf-highlight[data-style="underline"]')).toBeVisible();
	await addText(page, 'PV11 offline text');
	await addInk(page);
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('i');
	await expect(page.getByRole('menuitem', { name: 'Image', exact: true })).toBeDisabled();
	await expect(page.getByRole('menuitem', { name: 'Image', exact: true }).locator('..')).toHaveAttribute('title', 'Attaching images needs a connection');
	await page.keyboard.press('Escape');
	await page.reload();
	await openedPdf(page, 1, 'First PDF page text');
	await expect(page.getByRole('img', { name: 'Text note: PV11 offline text' })).toBeVisible();
	await expect(page.getByRole('img', { name: 'Drawing', exact: true })).toBeVisible();
	await expect(page.locator('.reader-pdf-highlight[data-style="underline"]')).toBeVisible();
	const beforeReconnect = await state(page.request, book.id);
	expect(beforeReconnect.highlights).toHaveLength(0);
	expect(beforeReconnect.page_annotations ?? []).toHaveLength(0);
	await context.setOffline(false);
	await expect.poll(async () => {
		const saved = await state(page.request, book.id);
		return {
			highlights: saved.highlights,
			annotations: saved.page_annotations
		};
	}, { timeout: 30_000 }).toMatchObject({
		highlights: [{
			book_id: book.id, book_file_id: book.files[0].id, text: 'First PDF page text', style: 'underline',
			locator: { type: 'pdf', page: 1, rects: expect.any(Array) }
		}],
		annotations: expect.arrayContaining([
			expect.objectContaining({
				book_id: book.id, book_file_id: book.files[0].id, kind: 'text',
				locator: { type: 'pdf', page: 1, rect: expect.any(Object) },
				data: expect.objectContaining({ text: 'PV11 offline text' })
			}),
			expect.objectContaining({
				book_id: book.id, book_file_id: book.files[0].id, kind: 'ink',
				locator: { type: 'pdf', page: 1, rect: expect.any(Object) },
				data: expect.objectContaining({ strokes: expect.any(Array) })
			})
		])
	});
	expect((await state(page.request, book.id)).page_annotations).toHaveLength(2);
});

test('a 300-page PDF navigates and persists its final page', async ({ page }) => {
	test.setTimeout(90_000);
	const library = await createLibrary(page);
	const { book } = await upload(page, library, 'PV11 Large Text', pdfFixture(300));
	await page.goto(`/read/${book.id}/${book.files[0].id}`);
	await openedPdf(page, 1, 'First PDF page text');
	await jumpToPdfPage(page, 150);
	await expect(pdfPageText(page, 150)).toContainText('Page 150 PDF page text');
	await jumpToPdfPage(page, 300);
	await expect(pdfPageText(page, 300)).toContainText('Page 300 PDF page text');
	await page.getByRole('button', { name: 'Close reader', exact: true }).click();
	await expect.poll(async () => (await state(page.request, book.id)).progress?.locator)
		.toMatchObject({ type: 'pdf', page: 300 });
});

test('a mixed PDF recognizes only the scanned page', async ({ page }) => {
	test.setTimeout(120_000);
	const library = await createLibrary(page);
	const { book } = await upload(page, library, 'PV11 Mixed', mixedPdfFixture(await scannedFixtureImage(page)));
	await page.goto(`/read/${book.id}/${book.files[0].id}`);
	await openedPdf(page, 1, 'True text page already has selectable content.');
	await expect(page.locator('.reader-pdf-page[data-page="1"] .pv-ocr-text')).toHaveCount(0);
	await jumpToPdfPage(page, 2);
	await expect(page.locator('.reader-pdf-page[data-page="2"] .pv-ocr-text'))
		.toContainText('扫描', { timeout: 90_000 });
	await selectPdfText(page, 'Scanned');
	await selectionToolbar(page).getByRole('button', { name: 'Highlight', exact: true }).click();
	await expect.poll(async () => (await state(page.request, book.id)).highlights[0]?.locator)
		.toMatchObject({ type: 'pdf', page: 2 });
});

test('mobile OCR status preserves reader controls and its accessible failure message', async ({ page, browser }) => {
	test.setTimeout(90_000);
	const library = await createLibrary(page);
	const { book } = await upload(page, library, 'PV11 Mobile OCR', scannedPdfFixture([await scannedFixtureImage(page)]));
	const mobile = await browser.newContext({
		baseURL: new URL(page.url()).origin, storageState: await page.context().storageState(),
		viewport: { width: 360, height: 800 }, serviceWorkers: 'block'
	});
	try {
		await mobile.route('**/eng.traineddata.gz', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
		const reader = await mobile.newPage();
		await reader.goto(`/read/${book.id}/${book.files[0].id}`);
		await openedPdf(reader);
		const status = reader.getByRole('status').filter({ hasText: 'Text recognition failed' });
		await expect(status).toBeVisible({ timeout: 60_000 });
		await expect(status.locator('.pv6-message')).toHaveText('Text recognition failed');
		const retry = status.getByRole('button', { name: 'Retry', exact: true });
		await mobile.setOffline(true);
		await expect(reader.getByRole('button', { name: 'Reader sync status', exact: true })).toBeVisible();
		for (const width of [360, 479, 480, 639, 640, 768]) {
			await reader.setViewportSize({ width, height: 800 });
			await expect(pdfPageBox(reader)).toBeInViewport({ ratio: 1 });
			await expect(retry).toBeInViewport({ ratio: 1 });
			await retry.click({ trial: true });
			const retryBox = await retry.boundingBox();
			if (!retryBox) throw new Error('The OCR retry button is unavailable.');
			expect(retryBox.width).toBeGreaterThanOrEqual(36);
			expect(retryBox.height).toBeGreaterThanOrEqual(36);
			for (const name of [
				'Reader sync status', 'Select tool', 'Insert text, drawing or image', 'Close reader',
				...(width < 640 ? ['More view options'] : ['Zoom', 'Page display', 'Rotate'])
			]) {
				const control = reader.getByRole('button', { name, exact: true });
				await expect(control).toBeInViewport({ ratio: 1 });
				await control.click({ trial: true });
			}
			await expect(reader.getByRole('tab', { name: 'Annotations', exact: true })).toBeInViewport({ ratio: 1 });
		}
	} finally {
		await mobile.close();
	}
});

test('EPUB and CBZ retain their legacy frame and highlighting', async ({ page }) => {
	test.setTimeout(120_000);
	const library = await createLibrary(page);
	const epub = await upload(page, library, 'PV11 Legacy', epubFixture('PV11 Legacy EPUB'), 'epub');
	const cbz = await upload(page, library, 'PV11 Legacy Comic', cbzFixture(pngFixture(32, 32, [200, 220, 240])), 'cbz');
	for (const { book } of [epub, cbz]) {
		await page.goto(`/read/${book.id}/${book.files[0].id}`);
		await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
		await expect(page.locator('.shell-header-band')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Back to book details' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Close reader', exact: true })).toHaveText('Close reader');
		await expect(page.locator('#reader-surface')).toHaveCount(0);
		await expect.poll(() => page.frames().some((frame) => frame.url().startsWith('blob:'))).toBe(true);
		const frame = page.frames().find((candidate) => candidate.url().startsWith('blob:'));
		if (!frame) throw new Error('The legacy reader frame was not created.');
		if (book.files[0].format === 'epub') {
			await expect(frame.locator('#passage')).toBeVisible();
			await frame.evaluate(() => {
				const passage = document.querySelector('#passage');
				if (!passage) throw new Error('The EPUB passage is missing.');
				const range = document.createRange();
				range.selectNodeContents(passage);
				const selection = window.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
				document.dispatchEvent(new Event('selectionchange'));
			});
			await page.getByRole('button', { name: 'Highlight selection' }).click();
		} else {
			await expect(frame.locator('img')).toBeVisible();
			await page.getByRole('button', { name: 'Highlight current page' }).click();
		}
		await expect.poll(async () => (await state(page.request, book.id)).highlights.length).toBe(1);
		await page.getByRole('button', { name: 'Close reader', exact: true }).click();
		await expect(page).toHaveURL(`/books/${book.id}`);
	}
});

test('migration from version 7 preserves highlights and progress without new revisions', async () => {
	test.setTimeout(90_000);
	const directory = await mkdtemp(join(tmpdir(), 'pandalibrary-pv11-migration-'));
	let child: ReturnType<typeof spawn> | undefined;
	let api: APIRequestContext | undefined;
	try {
		const baseline = join(directory, 'version-7.db');
		const database = new DatabaseSync(baseline);
		try {
			const migrations = [
				'00001_init', '00002_shelf_modes', '00003_bookmarks', '00004_bookheap',
				'00005_reading_statuses', '00006_status_lifecycle', '00007_book_reviews'
			];
			for (const name of migrations) {
				const text = await readFile(resolve('..', 'internal', 'db', 'migrations', `${name}.sql`), 'utf8');
				database.exec(text.split('-- +goose Up')[1].split('-- +goose Down')[0]
					.replaceAll('-- +goose StatementBegin', '').replaceAll('-- +goose StatementEnd', ''));
			}
			const salt = Buffer.from('pv11-migration-salt');
			const hash = argon2Sync('argon2id', {
				message: 'pv11-migration-password', nonce: salt, parallelism: 4, tagLength: 32, memory: 65536, passes: 3
			});
			const encoded = `$argon2id$v=19$m=65536,t=3,p=4$${salt.toString('base64').replaceAll('=', '')}$${hash.toString('base64').replaceAll('=', '')}`;
			database.prepare(`INSERT INTO users (id, username, password_hash, role, locale, created_at, updated_at)
				VALUES (1, 'pv11-migration', ?, 'admin', 'en', 1, 1)`).run(encoded);
			database.exec(`
				CREATE TABLE goose_db_version (id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL, is_applied INTEGER NOT NULL, tstamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
				INSERT INTO goose_db_version (version_id, is_applied) VALUES (0,1),(1,1),(2,1),(3,1),(4,1),(5,1),(6,1),(7,1);
				INSERT INTO libraries (id,name,slug,created_at,updated_at) VALUES (1,'PV11','pv11',1,1);
				INSERT INTO books (id,library_id,title,sort_title,created_at,updated_at) VALUES (1,1,'PV11 Migration','pv11 migration',1,1);
				INSERT INTO book_files (id,book_id,sha256,format,size_bytes,original_filename,created_at)
					VALUES (1,1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','pdf',1,'old.pdf',1);
				INSERT INTO highlights (id,user_id,book_id,book_file_id,locator,position,text,color,created_at,updated_at,rev)
					VALUES ('018f0f7e-7b00-7000-8000-000000000001',1,1,1,'{"type":"pdf","page":2}',0.5,'Old highlight','yellow',1000,1000,1);
				INSERT INTO reading_progress (user_id,book_id,book_file_id,source,locator,percentage,updated_at,rev)
					VALUES (1,1,1,'web','{"type":"pdf","page":2,"offset":0.25}',0.5,2000,2);
				UPDATE sync_counter SET value=2 WHERE id=1;
			`);
		} finally {
			database.close();
		}
		const dataDir = join(directory, 'server');
		await mkdir(dataDir);
		await copyFile(baseline, join(dataDir, 'pandalibrary.db'));
		const listener = createServer();
		await new Promise<void>((done, reject) => {
			listener.once('error', reject);
			listener.listen(0, '127.0.0.1', done);
		});
		const address = listener.address();
		if (!address || typeof address === 'string') throw new Error('Cannot allocate migration port.');
		const port = address.port;
		await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
		const origin = `http://127.0.0.1:${port}`;
		child = spawn(process.env.PANDA_E2E_BINARY!, ['serve'], {
			env: {
				...process.env, PANDA_DATA_DIR: dataDir, PANDA_LISTEN: `127.0.0.1:${port}`,
				PANDA_BASE_URL: origin, PANDA_DROP_DIR: join(dataDir, 'drop'), PANDA_DROP_POLL: '0',
				PANDA_AUTO_MIGRATE: 'true', PANDA_TRUSTED_PROXIES: ''
			},
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let logs = '';
		child.stdout?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
		child.stderr?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
		await expect.poll(async () => {
			if (child?.exitCode !== null) throw new Error(`Migration server exited: ${logs}`);
			try {
				return (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
			} catch (error) {
				if (!(error instanceof TypeError || error instanceof DOMException)) throw error;
				return false;
			}
		}, { timeout: 60_000 }).toBe(true);
		api = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
		await checked(await api.post('/api/v1/auth/login', {
			data: { username: 'pv11-migration', password: 'pv11-migration-password' }
		}));
		const upgraded = await state(api, 1);
		expect(upgraded.highlights).toEqual([expect.objectContaining({ text: 'Old highlight', style: 'highlight', rev: 1 })]);
		expect(upgraded.progress).toMatchObject({
			locator: { type: 'pdf', page: 2, offset: 0.25 }, percentage: 0.5, rev: 2
		});
		const full = await checked(await api.get('/api/v1/sync/pull?cursor=0'));
		expect(await full.json()).toMatchObject({
			cursor: 2, highlights: [expect.objectContaining({ style: 'highlight', rev: 1 })],
			reading_progress: [expect.objectContaining({ rev: 2 })], page_annotations: []
		});
		for (let i = 0; i < 2; i++) {
			const incremental = await checked(await api.get('/api/v1/sync/pull?cursor=2'));
			expect(await incremental.json()).toMatchObject({
				cursor: 2, highlights: [], reading_progress: [], page_annotations: []
			});
		}
	} finally {
		await api?.dispose();
		if (child && child.exitCode === null && child.signalCode === null) {
			const closed = new Promise((done) => child!.once('close', done));
			child.kill();
			await closed;
		}
		await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}
});

test('reconciles previously saved changes after lost sync acknowledgments', async ({ page }) => {
	test.setTimeout(120_000);
	const library = await createLibrary(page);
	const { book } = await upload(page, library, 'PV11 Sync Replay', pdfFixture());
	const accountResponse = await checked(await page.request.get('/api/v1/auth/me'));
	const { user } = await accountResponse.json() as { user: { id: number } };
	const now = Date.now() - 10_000;
	const progress = {
		entity: 'reading_progress', key: String(book.id), op: 'upsert', updated_at: now,
		data: {
			book_id: book.id, book_file_id: book.files[0].id, source: 'web',
			locator: { type: 'pdf', page: 2 }, percentage: 0.5, device: 'PandaLibrary Web', device_id: 'replay-test'
		}
	};
	const session = {
		entity: 'reading_sessions', id: uuidv7(), op: 'upsert', updated_at: now,
		data: {
			book_id: book.id, source: 'web', device: 'PandaLibrary Web', started_at: now - 60_000,
			ended_at: now, active_seconds: 60, start_percentage: 0.2, end_percentage: 0.5
		}
	};
	const setting = {
		entity: 'user_settings', key: `reader.book.${book.id}`, op: 'upsert', updated_at: now,
		data: { value: { theme: 'dark' } }
	};
	await push(page.request, [progress, session, setting]);
	const before = await state(page.request, book.id);
	await page.evaluate(() => navigator.locks.request('pandalibrary-session-and-sync', () => undefined));
	const replay = page.waitForResponse((response) => {
		if (new URL(response.url()).pathname !== '/api/v1/sync/push' || response.request().method() !== 'POST') return false;
		const payload = response.request().postDataJSON() as { mutations: Array<{ entity: string; key?: string }> };
		return payload.mutations.some((item) => item.entity === 'reading_progress' && item.key === progress.key);
	});
	const sequences = await page.evaluate(({ account, mutations }) => new Promise<number[]>((resolve, reject) => {
		const opening = indexedDB.open('pandalibrary-offline');
		opening.onerror = () => reject(opening.error);
		opening.onsuccess = () => {
			const database = opening.result;
			const transaction = database.transaction('outbox', 'readwrite');
			const queue = transaction.objectStore('outbox');
			const requests = mutations.map((mutation, index) =>
				queue.add({ account, mutation, status: index === 2 ? 'stale' : 'pending' }));
			transaction.oncomplete = () => {
				database.close();
				const ids: number[] = [];
				for (const request of requests) {
					if (typeof request.result !== 'number') {
						reject(new Error('The queued change has no sequence.'));
						return;
					}
					ids.push(request.result);
				}
				resolve(ids);
			};
			transaction.onabort = () => { database.close(); reject(transaction.error); };
		};
	}), { account: user.id, mutations: [progress, session, setting] });
	await page.reload();
	const response = await replay;
	expect(response.ok()).toBe(true);
	const body = response.request().postDataJSON() as { mutations: Array<{ entity: string; key?: string; id?: string }> };
	const { results } = await response.json() as { results: Array<{ index: number; status: string }> };
	for (const entity of ['reading_progress', 'reading_sessions']) {
		const index = body.mutations.findIndex((mutation) => mutation.entity === entity);
		expect(results.find((result) => result.index === index)?.status).toBe('stale');
	}
	await expect.poll(() => page.evaluate((ids) => new Promise<number[]>((resolve, reject) => {
		const opening = indexedDB.open('pandalibrary-offline');
		opening.onerror = () => reject(opening.error);
		opening.onsuccess = () => {
			const database = opening.result;
			const transaction = database.transaction('outbox');
			const store = transaction.objectStore('outbox');
			const requests = ids.map((id) => store.get(id));
			transaction.oncomplete = () => {
				database.close();
				resolve(ids.filter((_, index) => requests[index].result !== undefined));
			};
			transaction.onabort = () => { database.close(); reject(transaction.error); };
		};
	}), sequences), { timeout: 30_000 }).toEqual([]);
	await expect(page.getByText('Some changes were rejected or conflicted. Review them in offline storage settings.')).toHaveCount(0);
	const after = await state(page.request, book.id);
	expect(after.progress).toEqual(before.progress);
	const sessionResponse = await checked(await page.request.get(`/api/v1/me/books/${book.id}/sessions`));
	const sessions = await sessionResponse.json() as { items: Array<{ id: string }> };
	expect(sessions.items.filter((item) => item.id === session.id)).toHaveLength(1);
});

test('replays a committed PDF setting after a lost acknowledgement', async ({ page }) => {
	const library = await createLibrary(page);
	const { book } = await upload(page, library, 'PV11 Settings Replay', pdfFixture());
	const accountResponse = await checked(await page.request.get('/api/v1/auth/me'));
	const { user } = await accountResponse.json() as { user: { id: number } };
	const mutation = {
		entity: 'user_settings',
		key: `reader.book.${book.id}`,
		op: 'upsert',
		data: { value: { theme: 'light', pdfLayout: 'split', pdfZoom: 'page-fit', pdfRotation: 0, pdfCoverAlone: false } },
		updated_at: Date.now() - 1000
	};
	await push(page.request, [mutation]);
	const beforeResponse = await checked(await page.request.get('/api/v1/me/settings'));
	const { settings: beforeSettings } = await beforeResponse.json() as { settings: Setting[] };
	const before = beforeSettings.find((item) => item.key === mutation.key);
	if (!before) throw new Error('The initially committed PDF setting is unavailable.');

	const replay = page.waitForResponse((response) => {
		if (new URL(response.url()).pathname !== '/api/v1/sync/push' || response.request().method() !== 'POST') return false;
		const payload = response.request().postDataJSON() as { mutations: Array<{ key?: string; updated_at: number }> };
		return payload.mutations.some((item) => item.key === mutation.key && item.updated_at === mutation.updated_at);
	});
	const sequence = await page.evaluate(({ account, entry }) => new Promise<number>((resolve, reject) => {
		const opening = indexedDB.open('pandalibrary-offline');
		opening.onerror = () => reject(opening.error ?? new Error('Could not open the offline database.'));
		opening.onsuccess = () => {
			const database = opening.result;
			const transaction = database.transaction('outbox', 'readwrite');
			const added = transaction.objectStore('outbox').add({ account, mutation: entry, status: 'pending' });
			transaction.oncomplete = () => {
				database.close();
				if (typeof added.result !== 'number') reject(new Error('The queued setting has no sequence.'));
				else resolve(added.result);
			};
			transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Could not queue the setting.')); };
		};
	}), { account: user.id, entry: mutation });
	const [response] = await Promise.all([
		replay,
		expect.poll(async () => {
			await page.evaluate(() => window.dispatchEvent(new Event('online')));
			return page.evaluate((queued) => new Promise<boolean>((resolve, reject) => {
				const opening = indexedDB.open('pandalibrary-offline');
				opening.onerror = () => reject(opening.error ?? new Error('Could not open the offline database.'));
				opening.onsuccess = () => {
					const database = opening.result;
					const read = database.transaction('outbox').objectStore('outbox').get(queued);
					read.onsuccess = () => {
						database.close();
						resolve(read.result === undefined || read.result.status === 'applied');
					};
					read.onerror = () => { database.close(); reject(read.error ?? new Error('Could not read the outbox.')); };
				};
			}), sequence);
		}, { timeout: 30_000 }).toBe(true)
	]);
	expect(response.ok()).toBe(true);
	const payload = response.request().postDataJSON() as { mutations: Array<{ key?: string; updated_at: number }> };
	const index = payload.mutations.findIndex((item) => item.key === mutation.key && item.updated_at === mutation.updated_at);
	const { results } = await response.json() as { results: Array<{ index: number; status: string }> };
	expect(results.find((item) => item.index === index)?.status).toBe('applied');

	await page.goto(`/read/${book.id}/${book.files[0].id}`);
	await openedPdf(page, 1, 'First PDF page text');
	await expect(page.getByRole('button', { name: 'Reader sync status', exact: true })).toHaveCount(0, { timeout: 30_000 });
	await openViewMenu(page, 'Page display');
	await expect(page.getByRole('menuitemradio', { name: 'Split', exact: true })).toHaveAttribute('aria-checked', 'true');
	const afterResponse = await checked(await page.request.get('/api/v1/me/settings'));
	const { settings: afterSettings } = await afterResponse.json() as { settings: Setting[] };
	const after = afterSettings.find((item) => item.key === mutation.key);
	expect(after?.rev).toBe(before.rev);
	expect(after?.value).toEqual(mutation.data.value);
});

test('measures large-PDF and annotation performance', async ({ page, context, browser }) => {
	test.skip(process.env.PV11_PERFORMANCE !== '1', 'Set PV11_PERFORMANCE=1 to run the large-fixture benchmark');
	test.setTimeout(600_000);
	const library = await createLibrary(page);
	const text = await upload(page, library, 'PV11 Performance Text', pdfFixture(300));
	const now = Date.now();
	for (let batch = 0; batch < 4; batch++) {
		await push(page.request, Array.from({ length: 50 }, (_, index) => {
			const n = batch * 50 + index;
			return {
				entity: 'highlights', id: uuidv7(now), op: 'upsert', updated_at: now,
				data: {
					book_id: text.book.id, book_file_id: text.book.files[0].id,
					locator: { type: 'pdf', page: 1, rects: [{ x: (n % 10) / 10, y: Math.floor(n / 10) / 20, width: 0.08, height: 0.025 }] },
					position: 0, text: `PV11 mark ${n}`, color: 'yellow', style: 'highlight', created_at: now
				}
			};
		}));
	}
	async function downloadForPerformance(book: Book) {
		await page.goto(`/books/${book.id}/files`);
		const panel = page.getByRole('region', { name: 'This file' });
		await panel.getByRole('button', { name: /^Actions for / }).click();
		await panel.getByRole('menuitem', { name: 'Save for offline' }).click();
		await expect(page.getByText('Book file downloaded for offline reading.', { exact: true })).toBeVisible({ timeout: 90_000 });
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) await new Promise<void>((done) =>
				navigator.serviceWorker.addEventListener('controllerchange', () => done(), { once: true }));
		});
	}
	async function measureScroll() {
		return page.locator('#reader-surface').evaluate(async (surface) => {
			return await new Promise<{ fps: number; frames: number; pixels: number; worstFrameMs: number }>((done) => {
				const startScroll = surface.scrollTop;
				let start = 0, last = 0, frames = 0, worst = 0;
				const tick = (time: number) => {
					if (!start) start = time;
					if (last) worst = Math.max(worst, time - last);
					last = time;
					frames++;
					surface.scrollTop = startScroll + (time - start) * 0.6;
					if (time - start >= 3000) done({
						fps: (frames - 1) * 1000 / (time - start), frames,
						pixels: surface.scrollTop - startScroll, worstFrameMs: worst
					});
					else requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
		});
	}
	const browserSession = await browser.newBrowserCDPSession();
	const pageSession = await context.newCDPSession(page);
	await pageSession.send('Performance.enable');
	const memorySamples: Array<{ phase: string; processes: number; workingSetBytes: number; privateBytes: number; jsHeapUsedBytes: number }> = [];
	async function sampleMemory(phase: string) {
		if (process.platform !== 'win32') throw new Error('This benchmark currently requires Windows process-memory sampling.');
		const info = await browserSession.send('SystemInfo.getProcessInfo') as { processInfo: Array<{ id: number }> };
		const ids = info.processInfo.map((entry) => entry.id);
		const command = `$p=@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue); ` +
			`Write-Output ("{0},{1},{2}" -f $p.Count, (($p | Measure-Object WorkingSet64 -Sum).Sum), ` +
			`(($p | Measure-Object PrivateMemorySize64 -Sum).Sum))`;
		const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
		const [processes, workingSetBytes, privateBytes] = stdout.trim().split(',').map(Number);
		const metrics = await pageSession.send('Performance.getMetrics') as { metrics: Array<{ name: string; value: number }> };
		const jsHeapUsedBytes = metrics.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value;
		if (!processes || !workingSetBytes || !privateBytes || jsHeapUsedBytes === undefined) {
			throw new Error(`Could not sample Chromium memory: ${stdout}`);
		}
		memorySamples.push({ phase, processes, workingSetBytes, privateBytes, jsHeapUsedBytes });
	}
	await page.addInitScript(() => {
		const starts = new WeakMap<Element, { time: number; count: number }>();
		const samples: number[] = [];
		window.pv11PaintSamples = samples;
		const replace = Element.prototype.replaceChildren;
		const append = Element.prototype.append;
		Element.prototype.replaceChildren = function (...nodes: (Node | string)[]) {
			if (this instanceof HTMLElement && this.classList.contains('pv-layer') && this.dataset.layer === 'highlight') {
				starts.set(this, { time: performance.now(), count: 0 });
			}
			return replace.apply(this, nodes);
		};
		Element.prototype.append = function (...nodes: (Node | string)[]) {
			const count = nodes.reduce((sum, node) => sum + (node instanceof DocumentFragment ? node.childElementCount : 1), 0);
			const result = append.apply(this, nodes);
			const sample = starts.get(this);
			if (sample) {
				sample.count += count;
				if (sample.count === 200) samples.push(performance.now() - sample.time);
			}
			return result;
		};
	});
	await downloadForPerformance(text.book);
	const textUrl = `/read/${text.book.id}/${text.book.files[0].id}`;
	await page.goto(textUrl);
	await openedPdf(page, 1, 'First PDF page text');
	await expect(page.locator('.pv-layer[data-layer="highlight"] .reader-pdf-highlight')).toHaveCount(200);
	await context.setOffline(true);
	const textFirstPageMs: number[] = [];
	const paintSamples: number[] = [];
	for (let i = 0; i < 3; i++) {
		const started = performance.now();
		await page.goto(textUrl);
		await openedPdf(page, 1, 'First PDF page text');
		await expect(page.locator('.pv-layer[data-layer="highlight"] .reader-pdf-highlight')).toHaveCount(200);
		textFirstPageMs.push(performance.now() - started);
		const samples = await page.evaluate(() => {
			if (!window.pv11PaintSamples) throw new Error('Mark-paint instrumentation is unavailable.');
			return window.pv11PaintSamples;
		});
		expect(samples.length).toBeGreaterThan(0);
		paintSamples.push(...samples);
	}
	await sampleMemory('text-open');
	await setLayout(page, 'Single page continuous');
	await setZoom(page, 'Actual size');
	const textScrolling = await measureScroll();
	expect(textScrolling.pixels).toBeGreaterThan(1000);
	await sampleMemory('text-scroll');
	const textJumpStart = performance.now();
	await jumpToPdfPage(page, 300);
	await expect(pdfPageText(page, 300)).toContainText('Page 300 PDF page text');
	const textJumpMs = performance.now() - textJumpStart;
	await sampleMemory('text-jump');
	await context.setOffline(false);

	const encoded = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 900;
		canvas.height = 1273;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas is unavailable for the scanned fixture.');
		const image = ctx.createImageData(canvas.width, canvas.height);
		let seed = 314159265;
		for (let pixel = 0; pixel < canvas.width * canvas.height; pixel++) {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			const gray = 245 + ((seed >>> 0) % 2);
			image.data.set([gray, gray, gray, 255], pixel * 4);
		}
		ctx.putImageData(image, 0, 0);
		ctx.fillStyle = '#111';
		ctx.font = '32px Arial';
		for (let line = 0; line < 12; line++) {
			ctx.fillText(`Performance scanned page line ${line + 1} with readable sample text.`, 55, 100 + line * 75);
		}
		return canvas.toDataURL('image/png').split(',')[1];
	});
	const scan = { png: Buffer.from(encoded, 'base64'), width: 595, height: 842 };
	const largePdf = scannedPdfFixture(Array.from({ length: 500 }, () => scan));
	expect(largePdf.length).toBeGreaterThan(120_000_000);
	expect(largePdf.length).toBeLessThan(200_000_000);
	const scanned = await upload(page, library, 'PV11 Performance Scanned', largePdf);
	await downloadForPerformance(scanned.book);
	await page.evaluate(() => localStorage.setItem('pandalibrary.pdf-ocr', 'false'));
	async function expectRenderedScan(n: number) {
		const pdfPage = page.locator(`.reader-pdf-page[data-page="${n}"]`);
		await expect(pdfPage.locator('.pv-layer[data-layer="highlight"]')).toBeVisible({ timeout: 90_000 });
		const canvas = pdfPage.locator('.canvasWrapper canvas').first();
		await expect(canvas).toBeVisible();
		await expect(canvas).toBeInViewport();
		const background = await canvas.evaluate((node) => {
			if (!(node instanceof HTMLCanvasElement)) throw new Error('The rendered PDF page has no canvas.');
			const context = node.getContext('2d');
			if (!context) throw new Error('The rendered PDF canvas is unavailable.');
			return context.getImageData(Math.floor(node.width / 2), Math.floor(node.height * 0.95), 1, 1).data[0];
		});
		// The fixture is light gray, so a white pixel would indicate a blank page.
		expect(background).toBeLessThan(250);
	}
	const url = `/read/${scanned.book.id}/${scanned.book.files[0].id}`;
	await page.goto(url);
	await expectRenderedScan(1);
	await context.setOffline(true);
	const firstPageMs: number[] = [];
	for (let i = 0; i < 3; i++) {
		const started = performance.now();
		await page.goto(url);
		await expectRenderedScan(1);
		firstPageMs.push(performance.now() - started);
	}
	await sampleMemory('scanned-open');
	await setLayout(page, 'Single page continuous');
	await setZoom(page, 'Actual size');
	const scrolling = await measureScroll();
	expect(scrolling.pixels).toBeGreaterThan(1000);
	await sampleMemory('scanned-scroll');
	const scannedJumpStart = performance.now();
	await jumpToPdfPage(page, 300);
	await expectRenderedScan(300);
	const scannedJumpMs = performance.now() - scannedJumpStart;
	await sampleMemory('scanned-jump');

	await context.setOffline(false);
	await setLayout(page, 'Single page');
	await setZoom(page, 'Fit page');
	await jumpToPdfPage(page, 4);
	await expectRenderedScan(4);
	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	const coldOcrStart = performance.now();
	await page.getByRole('menuitemcheckbox', { name: 'Recognize text in scanned pages' }).click();
	await expect(page.locator('.reader-pdf-page[data-page="4"] .pv-ocr-text')).toContainText('Performance', { timeout: 120_000 });
	const coldOcrMs = performance.now() - coldOcrStart;
	await sampleMemory('cold-ocr');
	const warmOcrStart = performance.now();
	await jumpToPdfPage(page, 400);
	await expect(page.locator('.reader-pdf-page[data-page="400"] .pv-ocr-text')).toContainText('Performance', { timeout: 120_000 });
	const warmOcrMs = performance.now() - warmOcrStart;
	await sampleMemory('warm-ocr');
	await browserSession.detach();
	await pageSession.detach();

	const paintMs = Math.max(...paintSamples);
	const memoryBytes = Math.max(...memorySamples.map((sample) => sample.workingSetBytes));
	const results = {
		fixture: { pages: 500, bytes: largePdf.length, sourcePixels: '900x1273', pdfPoints: '595x842', duplicateImageStreams: true },
		textFirstPageMs, textScrolling, firstPageMs, scrolling, textJumpMs, scannedJumpMs, coldOcrMs, warmOcrMs, paintSamples, memorySamples,
		budgets: {
			firstPage: Math.max(...firstPageMs) < 2000, scrolling: scrolling.fps >= 50,
			jump: scannedJumpMs < 300, ocr: warmOcrMs <= 6000,
			paint: paintMs <= 2, memory: memoryBytes < 1_000_000_000
		}
	};
	console.log(`PV11_PERFORMANCE ${JSON.stringify(results)}`);
});

test('captures PDF visual, keyboard, reduced-motion and touch QA', async ({ page, context, browser }) => {
	test.skip(process.env.PV11_VISUAL !== '1', 'Set PV11_VISUAL=1 to capture the visual QA matrix');
	test.setTimeout(600_000);
	const directory = resolve('..', 'docs', 'dev', 'plans', 'assets', 'pv11');
	await mkdir(directory, { recursive: true });
	const library = await createLibrary(page);
	const text = await upload(page, library, 'PV11 Visual Text', pdfFixture(2));
	const scan = await upload(page, library, 'PV11 Visual Scanned', scannedPdfFixture([await scannedFixtureImage(page)]));
	const textUrl = `/read/${text.book.id}/${text.book.files[0].id}`;
	const scanUrl = `/read/${scan.book.id}/${scan.book.files[0].id}`;
	await page.goto(textUrl);
	await openedPdf(page, 1, 'First PDF page text');
	await setLayout(page, 'Single page');
	await setZoom(page, 'Fit page');
	await selectPdfText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Highlight', exact: true }).click();
	await expect(page.locator('.reader-pdf-highlight')).toHaveCount(1);
	const chooser = page.waitForEvent('filechooser');
	await chooseInsert(page, 'Image', 0.35, 0.6);
	await (await chooser).setFiles({
		name: 'pv11-visual.png', mimeType: 'image/png', buffer: pngFixture(120, 80, [100, 160, 220])
	});
	await expect(page.getByRole('img', { name: 'Image', exact: true })).toBeVisible();
	const shots: string[] = [];
	async function shot(name: string) {
		await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' });
		shots.push(name);
	}
	async function theme(name: 'Light' | 'Dark') {
		await page.evaluate((color) => {
			localStorage.setItem('pandalibrary.theme', color);
			document.documentElement.dataset.theme = color;
			document.documentElement.style.colorScheme = color;
		}, name.toLowerCase());
		await openViewMenu(page, 'Page display');
		await page.getByRole('menuitemradio', { name, exact: true }).click();
	}
	for (const width of [360, 768, 1440]) {
		await page.setViewportSize({ width, height: width === 360 ? 800 : 900 });
		for (const color of ['Light', 'Dark'] as const) {
			const prefix = `${width}-${color.toLowerCase()}`;
			await theme(color);
			for (const [label, name] of [
				['Single page', 'single'], ['Single page continuous', 'single-continuous'],
				['Split', 'split'], ['Split continuous', 'split-continuous']
			] as const) {
				await setLayout(page, label);
				await shot(`${prefix}-rest-${name}`);
			}
			await setLayout(page, 'Single page');
			await setZoom(page, 'Fit page');
			for (const [button, name] of [
				['Zoom', 'zoom-menu'], ['Page display', 'layout-menu'], ['Rotate', 'rotate-menu']
			] as const) {
				await openViewMenu(page, button);
				await expect(page.getByRole('menu', { name: button, exact: true })).toBeVisible();
				await shot(`${prefix}-${name}`);
				await closeViewMenu(page);
			}
			await selectPdfText(page, 'First PDF page text');
			await shot(`${prefix}-selection-toolbar`);
			await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
			await expect(page.getByRole('radiogroup', { name: 'Highlight colors' })).toBeVisible();
			await shot(`${prefix}-selection-palette`);
			await page.keyboard.press('Escape');
			await page.keyboard.press('Escape');
			await page.locator('.reader-pdf-highlight').first().click();
			const mark = page.getByRole('dialog', { name: 'Mark actions', exact: true });
			await expect(mark).toBeVisible();
			await shot(`${prefix}-mark-toolbar`);
			await mark.getByRole('button', { name: 'Add comment', exact: true }).click();
			const comment = page.getByRole('dialog', { name: 'Add comment', exact: true });
			await expect(comment).toBeVisible();
			const note = comment.getByRole('textbox');
			await note.fill('A visual QA comment.');
			await expect(note).toHaveValue('A visual QA comment.');
			await expect(comment.locator('.cm-editor, .reader-note-preview')).toHaveCount(0);
			await expect(note).toHaveCSS('color', 'rgb(73, 61, 27)');
			await shot(`${prefix}-comment`);
			await comment.getByRole('button', { name: 'Cancel', exact: true }).click();

			await page.locator('#reader-surface').focus();
			await page.keyboard.press('i');
			await expect(page.getByRole('menuitem', { name: 'Text', exact: true })).toBeVisible();
			await shot(`${prefix}-insert-menu`);
			await page.getByRole('menuitem', { name: 'Text', exact: true }).click();
			const box = await page.locator('.reader-pdf-page[data-page="1"]').boundingBox();
			if (!box) throw new Error('The visual fixture page is unavailable.');
			await page.mouse.click(box.x + box.width * 0.15, box.y + Math.min(box.height * 0.55, 250));
			const editor = page.getByRole('textbox', { name: 'Text', exact: true });
			await editor.fill('A visual QA text note');
			await shot(`${prefix}-text-box`);
			await editor.fill('');
			await editor.press('Escape');
			await chooseInsert(page, 'Draw', 0.15, 0.55);
			await expect(page.getByRole('toolbar', { name: 'Draw', exact: true })).toBeVisible();
			await shot(`${prefix}-ink-bar`);
			await page.keyboard.press('Escape');
			await page.getByRole('img', { name: 'Image', exact: true }).click();
			const imageFrame = page.getByRole('group', { name: 'Selected annotation', exact: true });
			await expect(imageFrame).toBeVisible();
			await expect(imageFrame).toBeInViewport({ ratio: 1 });
			await shot(`${prefix}-image-frame`);
			await openAnnotationsPanel(page);
			await shot(`${prefix}-annotations-panel`);
			await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
			await context.setOffline(true);
			const sync = page.getByRole('button', { name: 'Reader sync status', exact: true });
			await expect(sync).toBeVisible();
			await sync.click();
			await expect(page.locator('#reader-sync-status')).toContainText('Offline');
			await shot(`${prefix}-offline-status`);
			await sync.click();
			await context.setOffline(false);
			await expect(sync).toHaveCount(0, { timeout: 30_000 });

			await page.evaluate(async () => {
				localStorage.setItem('pandalibrary.pdf-ocr', 'false');
				await new Promise<void>((done, reject) => {
					const deletion = indexedDB.deleteDatabase('pandalibrary-ocr');
					deletion.onsuccess = () => done();
					deletion.onerror = () => reject(deletion.error);
					deletion.onblocked = () => reject(new Error('The OCR cache is blocked.'));
				});
			});
			await page.goto(scanUrl);
			await openedPdf(page);
			await theme(color);
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await openViewMenu(page, 'Page display');
			await page.getByRole('menuitemcheckbox', { name: 'Recognize text in scanned pages' }).click();
			const ocr = page.locator('[role="status"]').filter({ hasText: /Loading OCR model|Recognizing text/ });
			await expect(ocr).toBeVisible({ timeout: 30_000 });
			for (const name of ['Insert text, drawing or image', 'Close reader']) {
				await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
			}
			await expect(page.getByRole('tab', { name: 'Annotations', exact: true })).toBeInViewport({ ratio: 1 });
			const spinner = ocr.locator('.animate-spin');
			await expect(spinner).toHaveCSS('animation-name', 'none');
			await shot(`${prefix}-ocr-chip`);
			await page.emulateMedia({ reducedMotion: 'no-preference' });
			await page.getByRole('button', { name: 'Close reader', exact: true }).click();
			await expect(page).toHaveURL(new RegExp(`/books/${scan.book.id}$`));
			await page.goto(textUrl);
			await openedPdf(page, 1, 'First PDF page text');
		}
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await setLayout(page, 'Single page');
	const surface = page.locator('#reader-surface');
	await surface.focus();
	await page.keyboard.press('End');
	await expect(pdfPageBox(page)).toHaveValue('2');
	await page.keyboard.press('Home');
	await expect(pdfPageBox(page)).toHaveValue('1');
	await page.keyboard.press('h');
	await expect(surface).toHaveAttribute('data-tool', 'hand');
	await page.keyboard.press('v');
	await expect(surface).toHaveAttribute('data-tool', 'select');
	await page.keyboard.press('i');
	await expect(page.getByRole('menuitem', { name: 'Text', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(surface).toHaveAttribute('data-tool', 'insert');
	await surface.focus();
	await page.keyboard.press('Escape');
	await expect(surface).toHaveAttribute('data-tool', 'select');
	for (const name of ['Zoom', 'Page display', 'Rotate', 'Select tool', 'Insert text, drawing or image', 'Close reader']) {
		await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
	}
	await expect(page.getByRole('tab', { name: 'Annotations', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Zoom', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('menu')).toBeVisible();
	await page.keyboard.press('Escape');

	const mobile = await browser.newContext({
		baseURL: new URL(page.url()).origin, storageState: await context.storageState(),
		viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true
	});
	try {
		const touch = await mobile.newPage();
		await touch.goto(textUrl);
		await openedPdf(touch, 1, 'First PDF page text');
		await setZoom(touch, 'Actual size');
		const touchPage = touch.locator('.reader-pdf-page[data-page="1"]');
		const before = (await touchPage.boundingBox())?.width;
		if (before === undefined) throw new Error('The touch PDF page is unavailable.');
		const cdp = await mobile.newCDPSession(touch);
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchStart', touchPoints: [{ x: 100, y: 300, id: 1 }, { x: 260, y: 300, id: 2 }]
		});
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove', touchPoints: [{ x: 60, y: 300, id: 1 }, { x: 300, y: 300, id: 2 }]
		});
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await expect.poll(async () => (await touchPage.boundingBox())?.width ?? 0).toBeGreaterThan(before);
		await setZoom(touch, 'Fit page');
		await chooseInsert(touch, 'Draw', 0.2, 0.5);
		const drawing = touch.getByRole('application', { name: 'Draw', exact: true });
		const box = await drawing.boundingBox();
		if (!box) throw new Error('The touch drawing surface is unavailable.');
		const scroll = await touch.locator('#reader-surface').evaluate((node) => node.scrollTop);
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchStart', touchPoints: [{ x: box.x + 50, y: box.y + 180, id: 3 }]
		});
		for (let i = 1; i <= 8; i++) {
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchMove', touchPoints: [{ x: box.x + 50 + i * 5, y: box.y + 180 + i * 3, id: 3 }]
			});
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		expect(await touch.locator('#reader-surface').evaluate((node) => node.scrollTop)).toBe(scroll);
		await touch.getByRole('button', { name: 'Done', exact: true }).click();
		await expect(touch.getByRole('img', { name: 'Drawing', exact: true })).toBeVisible();
		await cdp.detach();
	} finally {
		await mobile.close();
	}
	expect(shots).toHaveLength(108);
	expect(new Set(shots).size).toBe(108);
	console.log(`PV11_VISUAL ${JSON.stringify({ screenshots: shots.length, directory, keyboard: true, accessibleNames: true, reducedMotion: true, touch: ['pinch', 'ink'] })}`);
});
