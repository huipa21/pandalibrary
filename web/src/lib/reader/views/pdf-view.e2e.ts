import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pdfFixture } from '../fixtures';

type Mutation = { entity: string; key?: string; data: { value?: Record<string, unknown> } };

async function setup(page: Page, saved: Record<string, unknown> = {}, bytes = pdfFixture(3)) {
	const file = { id: 31, format: 'pdf', size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${'b'.repeat(64)}` };
	const book = {
		id: 21, library_id: 1, title: 'Toolbar wiring', sort_title: 'Toolbar wiring', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
	};
	const settings = Object.keys(saved).length
		? [{ key: 'reader.book.21', value: saved, updated_at: '2026-11-03T00:00:00Z', rev: 1 }]
		: [];
	const pushes: Mutation[] = [];
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: { user_book: null, progress: null, highlights: [], notes: [], bookmarks: [] } });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings } });
		if (path === '/api/v1/sync/pull') return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], bookmarks: [], user_settings: [] } });
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON();
			pushes.push(...mutations);
			return route.fulfill({ json: { results: mutations.map((_: unknown, index: number) => ({ index, status: 'applied' })) } });
		}
		if (path.endsWith('/reading-summary')) return route.fulfill({ json: { reading_summary: { total_active_seconds: 0, session_count: 0, first_read_at: null, last_read_at: null } } });
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	const lastSaved = () => pushes.filter((mutation) => mutation.entity === 'user_settings' && mutation.key === 'reader.book.21').at(-1)?.data.value;
	return { pushes, lastSaved };
}

async function open(page: Page) {
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
}

test('invalid TrueType hints recover without console warnings and text still renders', async ({ page }) => {
	const font = await readFile(resolve('node_modules', 'pdfjs-dist', 'standard_fonts', 'LiberationSans-Regular.ttf'));
	let patched = false;
	for (let index = 0; index < font.readUInt16BE(4); index++) {
		const entry = 12 + index * 16;
		if (font.toString('ascii', entry, entry + 4) !== 'fpgm') continue;
		const offset = font.readUInt32BE(entry + 8);
		const length = font.readUInt32BE(entry + 12);
		// Replace definitions with PUSHB 32; CALL to exercise PDF.js's undefined-function recovery.
		font.fill(0x22, offset, offset + length);
		font.set([0xb0, 32, 0x2b], offset);
		patched = true;
		break;
	}
	expect(patched).toBe(true);
	const warnings: string[] = [];
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'warning') warnings.push(message.text());
	});
	page.on('pageerror', (error) => errors.push(error.message));
	await setup(page, {}, pdfFixture(1, false, font));
	await open(page);
	const canvas = page.locator('.pdfViewer .page canvas').first();
	await expect(canvas).toBeVisible();
	await expect(page.locator('.pdfViewer .page').first()).toHaveAttribute('data-loaded', 'true');
	expect(await canvas.evaluate((element: HTMLCanvasElement) => {
		const context = element.getContext('2d');
		if (!context) throw new Error('Canvas is unavailable.');
		const pixels = context.getImageData(0, 0, element.width, element.height).data;
		return pixels.some((channel, index) => index % 4 !== 3 && channel < 128);
	})).toBe(true);
	expect(warnings.filter((message) => message.includes('TT:'))).toEqual([]);
	expect(errors).toEqual([]);
});

test('toolbar drives the engine and view changes autosave to the book', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const state = await setup(page);
	await open(page);
	const pageBox = page.getByRole('textbox', { name: /^Page \d+ of \d+$/ });
	await expect(pageBox).toHaveAccessibleName('Page 1 of 3');
	await pageBox.fill('3');
	await pageBox.press('Enter');
	await expect(pageBox).toHaveValue('3');
	await expect(page.getByLabel(/^Progress /)).toBeVisible();

	await page.getByRole('button', { name: 'Zoom', exact: true }).click();
	await page.getByRole('menuitemradio', { name: 'Actual size' }).click();
	await expect.poll(state.lastSaved).toMatchObject({ pdfZoom: 'page-actual' });

	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	await page.getByRole('menuitemradio', { name: 'Split', exact: true }).click();
	await page.getByRole('button', { name: 'Rotate', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Rotate right' }).click();
	await expect.poll(state.lastSaved).toMatchObject({ pdfZoom: 'page-actual', pdfLayout: 'split', pdfRotation: 90 });
	await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toHaveCount(0);

	// Ctrl+wheel free zoom happens inside the engine; the view must still persist it.
	const surface = page.locator('#reader-surface');
	await surface.hover();
	await page.keyboard.down('Control');
	await page.mouse.wheel(0, -100);
	await page.keyboard.up('Control');
	await expect.poll(async () => typeof (await state.lastSaved())?.pdfZoom).toBe('number');
	const zoom = (await state.lastSaved())?.pdfZoom as number;
	await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toHaveText(`${Math.round(zoom * 100)}%`);

	await page.getByRole('button', { name: 'Format', exact: true }).click();
	await page.getByRole('dialog', { name: 'Format' }).getByRole('radio', { name: 'Night', exact: true }).click();
	await expect.poll(state.lastSaved).toMatchObject({
		background: 'night', theme: 'dark', pdfZoom: zoom, pdfLayout: 'split', pdfRotation: 90
	});
});

test('saved view settings restore and Hand/Insert tools follow shortcuts', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await setup(page, { pdfZoom: 1.375, pdfLayout: 'single-continuous' });
	await open(page);
	await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toHaveText('138%');
	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	await expect(page.getByRole('menuitemradio', { name: 'Single page continuous' })).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');

	const surface = page.locator('#reader-surface');
	const toolButton = page.getByRole('button', { name: /^(Select|Hand) tool$/ });
	await expect(surface).toHaveAttribute('data-tool', 'select');
	await surface.focus();
	await page.keyboard.press('h');
	await expect(surface).toHaveAttribute('data-tool', 'hand');
	await expect(toolButton).toHaveAttribute('aria-pressed', 'true');
	await surface.evaluate((element) => { element.scrollTop = 0; });
	const box = await surface.boundingBox();
	if (!box) throw new Error('The reader surface is missing.');
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 200, { steps: 5 });
	await page.mouse.up();
	expect(await surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

	const insert = page.getByRole('button', { name: 'Insert text, drawing or image' });
	await insert.click();
	await expect(surface).toHaveAttribute('data-tool', 'insert');
	await expect(insert).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await expect(surface).toHaveAttribute('data-tool', 'hand');

	await page.reload();
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await expect(surface).toHaveAttribute('data-tool', 'hand');
	await surface.focus();
	await page.keyboard.press('v');
	await expect(surface).toHaveAttribute('data-tool', 'select');
});

test('narrow viewport routes view menus through overflow', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 740 });
	const state = await setup(page);
	await open(page);
	await page.getByRole('button', { name: 'More view options' }).click();
	await page.getByRole('menuitem', { name: 'Zoom', exact: true }).press('ArrowRight');
	await page.getByRole('menuitemradio', { name: 'Fit page' }).click();
	await expect.poll(state.lastSaved).toMatchObject({ pdfZoom: 'page-fit' });
	const bounds = await page.getByRole('button', { name: 'Close reader', exact: true }).boundingBox();
	expect(bounds && bounds.x + bounds.width).toBeLessThanOrEqual(360);
});
