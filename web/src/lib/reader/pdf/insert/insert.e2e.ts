import { expect, test, type Page } from '@playwright/test';
import { pdfFixture } from '../../fixtures';
import { resolve } from 'node:path';
import type { PageAnnotationInput } from '../../types';

type InsertMutation = { entity: string; id: string; op: string; data: {
	kind: string; locator: { page: number; rect: { x: number; y: number; width: number; height: number } };
	data: { text?: string; strokes?: number[][]; asset?: string }; position: number;
} };

async function setup(page: Page, initial: PageAnnotationInput[] = [], theme = 'light') {
	page.on('pageerror', (error) => { throw error; });
	const bytes = pdfFixture(3);
	const stamp = '2026-11-09T00:00:00Z';
	const file = { id: 31, format: 'pdf', size_bytes: bytes.length, original_filename: 'Insert.pdf', created_at: stamp,
		download_url: `/api/v1/books/21/files/31?v=${'c'.repeat(64)}` };
	const book = { id: 21, library_id: 1, title: 'Insert', sort_title: 'Insert', subtitle: null, description: null, language: 'en',
		publisher: null, published_date: null, page_count: null, cover_url: null, cover_source: null, authors: [], series: null,
		tags: [], identifiers: [], files: [file], field_sources: [], created_at: stamp, updated_at: stamp };
	const rows = new Map<string, Record<string, unknown>>();
	const pushes: InsertMutation[] = [];
	let revision = 1, failUpload = false, assetsOffline = false, assetDownloads = 0;
	for (const [index, input] of initial.entries()) {
		const id = `01900000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
		rows.set(id, { ...input, id, book_id: 21, book_file_id: 31, created_at: stamp, updated_at: stamp, deleted_at: null, rev: ++revision });
	}
	let imageBytes: Buffer = await page.evaluate(() => {
		const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 60;
		const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#2563eb'; ctx.fillRect(0, 0, 120, 60);
		return canvas.toDataURL().split(',')[1];
	}).then((data) => Buffer.from(data, 'base64'));
	let imageType = 'image/png';
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/version') return route.fulfill({ json: { version: 'test', commit: 'test', commit_date: stamp, dirty: false, release: null } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Library', access: 'read' } } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ body: bytes, contentType: 'application/pdf' });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: { user_book: null, progress: null, highlights: [], notes: [], bookmarks: [], page_annotations: [...rows.values()].filter((row) => !row.deleted_at) } });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings: [
			{ key: 'reader.book.21', value: { theme }, updated_at: stamp, rev: 1 }
		] } });
		if (path === '/api/v1/sync/pull') {
			const cursor = Number(new URL(route.request().url()).searchParams.get('cursor'));
			return route.fulfill({ json: { cursor: revision, user_books: [], reading_progress: [], highlights: [], notes: [], bookmarks: [], page_annotations: [...rows.values()].filter((row) => Number(row.rev) > cursor), user_settings: [] } });
		}
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON() as { mutations: InsertMutation[] };
			for (const mutation of mutations) if (mutation.entity === 'page_annotations') {
				pushes.push(mutation);
				rows.set(mutation.id, { ...rows.get(mutation.id), ...mutation.data, id: mutation.id, book_id: 21, book_file_id: 31,
					created_at: stamp, updated_at: new Date().toISOString(), deleted_at: mutation.op === 'delete' ? stamp : null, rev: ++revision });
			}
			return route.fulfill({ json: { results: mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		if (path === '/api/v1/me/annotation-assets') {
			if (failUpload) return route.fulfill({ status: 413, contentType: 'application/problem+json', body: JSON.stringify({ code: 'asset_too_large', detail: 'Too large' }) });
			imageBytes = route.request().postDataBuffer() ?? imageBytes;
			imageType = route.request().headers()['content-type'];
			return route.fulfill({ json: { asset: { sha256: 'a'.repeat(64), media_type: imageType, width: 120, height: 60, size: imageBytes.length } } });
		}
		if (path.startsWith('/api/v1/me/annotation-assets/')) {
			assetDownloads++;
			return assetsOffline ? route.abort('internetdisconnected') : route.fulfill({ body: imageBytes, contentType: imageType });
		}
		if (path.endsWith('/reading-summary')) return route.fulfill({ json: { reading_summary: { total_active_seconds: 0, session_count: 0, first_read_at: null, last_read_at: null } } });
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-page[data-page="1"] .reader-pdf-text')).toContainText('First PDF page text');
	return { pushes, imageBytes, failUpload: () => { failUpload = true; },
		offlineAssets: () => { assetsOffline = true; }, assetDownloads: () => assetDownloads };
}

async function choose(page: Page, name: string) {
	await page.keyboard.press('Escape');
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('i');
	const layer = page.locator('.reader-pdf-page[data-page="1"]');
	const box = await layer.boundingBox();
	if (!box) throw new Error('Page missing');
	await page.mouse.click(box.x + box.width * 0.2, box.y + Math.min(box.height * 0.3, 250));
	await page.getByRole('menuitem', { name, exact: true }).click();
}

test('text insert, zoom/rotation, edit, move, keyboard, delete and same-ID undo', async ({ page }) => {
	const state = await setup(page);
	await choose(page, 'Text');
	const editor = page.getByRole('textbox', { name: 'Text', exact: true });
	await editor.fill('Private text\nSecond line');
	await editor.press('Control+Enter');
	const item = page.getByRole('img', { name: 'Text note: Private text\nSecond line' });
	await expect(item).toBeVisible();
	await expect.poll(() => state.pushes.filter((row) => row.data.kind === 'text').length).toBe(1);
	const first = state.pushes.find((row) => row.data.kind === 'text')!;
	expect(first.data).toMatchObject({ kind: 'text', locator: { type: 'pdf', page: 1 }, data: { text: 'Private text\nSecond line', color: '#111827', size: 0.018 } });
	const style = await item.getAttribute('style');
	await page.getByRole('button', { name: 'Zoom', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Zoom in', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Zoom in', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Zoom in', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toHaveText('200%');
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('r');
	await expect(item).toBeAttached();
	expect(await item.evaluate((node) => parseFloat((node as HTMLElement).style.left))).toBeCloseTo(first.data.locator.rect.x * 100, 3);
	expect(style).toContain('font-size');
	await item.scrollIntoViewIfNeeded();
	await item.dblclick();
	await editor.fill('Edited');
	await expect(editor).toHaveValue('Edited');
	await editor.press('Escape');
	await expect.poll(() => state.pushes.map((row) => row.data.data.text)).toEqual(['Private text\nSecond line', 'Edited']);
	const edited = page.getByRole('img', { name: 'Text note: Edited', exact: true });
	await expect(edited).toBeVisible();
	await edited.focus();
	await edited.press('ArrowRight');
	await expect.poll(() => state.pushes.filter((row) => row.id === first.id && row.op === 'upsert').length).toBe(3);
	const frame = page.getByRole('group', { name: 'Selected annotation', exact: true });
	const before = state.pushes.at(-1)!.data.locator.rect;
	const box = await frame.boundingBox();
	if (!box) throw new Error('Frame missing');
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20); await page.mouse.up();
	await expect.poll(() => state.pushes.at(-1)!.data.locator.rect).not.toEqual(before);
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(edited).toHaveCount(0);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(edited).toBeVisible();
	await expect.poll(() => state.pushes.at(-1)?.op).toBe('upsert');
	expect(state.pushes.at(-1)?.id).toBe(first.id);
});

test('mouse drawing undo and bounded private ink push; Hand cannot drag items', async ({ page }) => {
	const state = await setup(page);
	await choose(page, 'Draw');
	const surface = page.getByRole('application', { name: 'Draw', exact: true });
	const box = await surface.boundingBox();
	if (!box) throw new Error('Ink surface missing');
	for (const offset of [0, 40]) {
		await page.mouse.move(box.x + 100, box.y + 200 + offset);
		await page.mouse.down(); await page.mouse.move(box.x + 230, box.y + 240 + offset, { steps: 30 }); await page.mouse.up();
	}
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(surface.locator('path')).toHaveCount(1);
	await page.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(page.getByRole('img', { name: 'Drawing', exact: true })).toBeVisible();
	await expect.poll(() => state.pushes.filter((row) => row.data.kind === 'ink').length).toBe(1);
	const ink = state.pushes.find((row) => row.data.kind === 'ink')!;
	expect(ink.data.data.strokes).toHaveLength(1);
	expect(ink.data.data.strokes!.flat().length / 2).toBeLessThanOrEqual(10000);
	await page.getByRole('img', { name: 'Drawing', exact: true }).click();
	await page.getByRole('group', { name: 'Selected annotation', exact: true }).press('ArrowRight');
	await expect.poll(() => state.pushes.filter((row) => row.data.kind === 'ink').length).toBe(2);
	const moved = state.pushes.filter((row) => row.data.kind === 'ink')[1];
	expect(moved.data.data.strokes![0][0]).toBeCloseTo(ink.data.data.strokes![0][0] + 0.005, 4);
	await expect(page.getByRole('button', { name: 'Select tool', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Select tool', exact: true }).click();
	await expect(page.locator('#reader-surface')).toHaveAttribute('data-tool', 'hand');
	await expect(page.getByRole('img', { name: 'Drawing', exact: true })).toHaveCSS('pointer-events', 'none');
	await expect(page.locator('.selection-frame')).toHaveCount(0);
});

test('image preparation, upload, aspect-locked resize, cached offline reload and disabled attachment', async ({ page }) => {
	const state = await setup(page);
	const chooser = page.waitForEvent('filechooser');
	await choose(page, 'Image');
	await (await chooser).setFiles({ name: 'image.png', mimeType: 'image/png',
		buffer: state.imageBytes });
	const image = page.getByRole('img', { name: 'Image', exact: true });
	await expect(image.locator('img')).toHaveJSProperty('complete', true);
	await expect.poll(() => state.pushes.filter((row) => row.data.kind === 'image').length).toBe(1);
	await image.click();
	const handle = page.getByRole('button', { name: 'Resize se', exact: true });
	const box = await handle.boundingBox();
	if (!box) throw new Error('Resize handle missing');
	await page.mouse.move(box.x + 7, box.y + 7); await page.mouse.down();
	await page.mouse.move(box.x + 57, box.y + 32); await page.mouse.up();
	await expect.poll(() => state.pushes.filter((row) => row.data.kind === 'image').length).toBe(2);
	const rect = state.pushes.at(-1)!.data.locator.rect;
	expect(rect.width / rect.height).toBeCloseTo(2 * 792 / 612);
	const downloads = state.assetDownloads();
	await page.goto('/books/21/files');
	await page.getByRole('region', { name: 'This file' }).getByRole('button', { name: 'Actions for Insert.pdf' }).click();
	await page.getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect(page.getByText('Book file downloaded for offline reading.', { exact: true })).toBeVisible();
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) =>
			navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
	});
	await page.goto('/read/21/31');
	await expect(image.locator('img')).toHaveJSProperty('naturalWidth', 120);
	state.offlineAssets();
	await page.context().setOffline(true);
	await page.reload();
	await expect(image.locator('img')).toHaveJSProperty('complete', true);
	await expect(image.locator('img')).toHaveJSProperty('naturalWidth', 120);
	expect(state.assetDownloads()).toBe(downloads);
	await page.evaluate(() => window.dispatchEvent(new Event('offline')));
	await page.locator('#reader-surface').focus(); await page.keyboard.press('i');
	const pdf = await page.locator('.reader-pdf-page').first().boundingBox();
	if (!pdf) throw new Error('Page missing');
	await page.mouse.click(pdf.x + 20, pdf.y + 180);
	await expect(page.getByRole('menuitem', { name: 'Image', exact: true })).toBeDisabled();
	await expect(image.locator('img')).toHaveJSProperty('complete', true);
});

test('upload failure creates no annotation', async ({ page }) => {
	const state = await setup(page); state.failUpload();
	const chooser = page.waitForEvent('filechooser');
	await choose(page, 'Image');
	await (await chooser).setFiles({ name: 'image.png', mimeType: 'image/png',
		buffer: state.imageBytes });
	await expect(page.getByText('This image is too large. Try a smaller image.')).toBeAttached();
	expect(state.pushes).toHaveLength(0);
	await expect(page.getByRole('img', { name: 'Image', exact: true })).toHaveCount(0);
});

for (const width of [360, 1440]) for (const theme of ['light', 'dark']) {
	test(`insert visual hand-off ${width} ${theme}`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' });
		await setup(page, [
			{ kind: 'text', position: 0, locator: { type: 'pdf', page: 1, rect: { x: 0.1, y: 0.15, width: 0.5, height: 0.08 } },
				data: { text: 'Private text note\nSecond line', color: '#2563eb', size: 0.028 } },
			{ kind: 'ink', position: 0, locator: { type: 'pdf', page: 1, rect: { x: 0.1, y: 0.3, width: 0.4, height: 0.1 } },
				data: { color: '#dc2626', width: 0.004, strokes: [[0.1, 0.35, 0.2, 0.3, 0.3, 0.4, 0.4, 0.3, 0.5, 0.35]] } },
			{ kind: 'image', position: 0, locator: { type: 'pdf', page: 1, rect: { x: 0.1, y: 0.5, width: 0.3, height: 0.116 } },
				data: { asset: 'a'.repeat(64), media_type: 'image/png', width: 120, height: 60 } }
		], theme);
		await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
		const image = page.getByRole('img', { name: 'Image', exact: true });
		await expect(image.locator('img')).toHaveJSProperty('naturalWidth', 120);
		await image.click();
		await expect(page.getByRole('button', { name: 'Resize se', exact: true })).toBeVisible();
		const path = resolve('..', 'docs', 'dev', 'plans', 'assets', 'pv9', `inserts-${width}-${theme}.png`);
		await page.screenshot({ path });
		await testInfo.attach('Text, drawing, image and selection frame', { path, contentType: 'image/png' });
	});
}

test('touch drawing captures the pointer without scrolling the page', async ({ browser }) => {
	const context = await browser.newContext({ hasTouch: true, viewport: { width: 360, height: 740 } });
	const page = await context.newPage();
	const state = await setup(page);
	await choose(page, 'Draw');
	const box = await page.getByRole('application', { name: 'Draw', exact: true }).boundingBox();
	if (!box) throw new Error('Ink surface missing');
	const session = await context.newCDPSession(page);
	const scroll = await page.locator('#reader-surface').evaluate((node) => node.scrollTop);
	await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 100, y: box.y + 150 }] });
	for (let i = 1; i < 10; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 100 + i * 5, y: box.y + 150 + i * 5 }] });
	await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	expect(await page.locator('#reader-surface').evaluate((node) => node.scrollTop)).toBe(scroll);
	await page.getByRole('button', { name: 'Done', exact: true }).click();
	await expect.poll(() => state.pushes.filter((row) => row.data.kind === 'ink').length).toBe(1);
	await context.close();
});
