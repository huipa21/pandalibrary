import { expect, test, type Frame, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resolve } from 'node:path';
import { epubFixture } from '../../lib/reader/fixtures.js';
import { outlinePdfFixture } from '../../lib/reader/pdf/sidebar/toc/outline-fixture.js';
import { openedPdf, pdfPageBox, selectPdfText, selectionToolbar } from '../../lib/real-pdf.js';

test.use({ serviceWorkers: 'block' });

type Mutation = {
	entity: string;
	id?: string;
	key?: string;
	op: string;
	data: Record<string, unknown>;
	updated_at: number;
};
type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string; deleted_at: string | null; rev: number };
type Setting = { key: string; value: unknown; updated_at: string; rev: number };

const timestamp = '2026-11-01T10:00:00Z';
const fileHash = 'a'.repeat(64);
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const panel = (page: Page, name: string) => page.getByRole('tabpanel', { name, exact: true });

async function setup(page: Page, format: 'pdf' | 'epub', initialHighlights: Row[] = []) {
	const bytes = format === 'pdf' ? outlinePdfFixture() : epubFixture('Reader Pane Integration');
	const file = { id: 31, format, size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${fileHash}` };
	const book = {
		id: 21, library_id: 1, title: 'Reader Pane Integration', sort_title: 'Reader Pane Integration',
		subtitle: null, description: null, language: 'en', publisher: null, published_date: null,
		page_count: format === 'pdf' ? 3 : null, cover_url: null, cover_source: null,
		authors: [], series: null, tags: [], identifiers: [], files: [file], field_sources: [],
		created_at: timestamp, updated_at: timestamp
	};
	const state = {
		rev: 1,
		progress: null as Record<string, unknown> | null,
		highlights: [...initialHighlights],
		bookmarks: [] as Row[],
		notes: [] as Row[],
		pageAnnotations: [] as Row[],
		settings: [
			{ key: `reader.${format}`, value: format === 'pdf' ? { pdfLayout: 'single', pdfZoom: 'page-fit' } : {}, updated_at: timestamp, rev: 1 }
		] as Setting[],
		mutations: [] as Mutation[]
	};

	function applyRows(rows: Row[], mutation: Mutation, now: string): Row[] {
		if (!mutation.id) throw new Error(`Missing ${mutation.entity} mutation ID.`);
		const previous = rows.find((row) => row.id === mutation.id);
		const next = rows.filter((row) => row.id !== mutation.id);
		if (mutation.op !== 'delete') {
			next.push({
				...previous, ...mutation.data, id: mutation.id,
				created_at: previous?.created_at ?? now, updated_at: now, deleted_at: null, rev: state.rev
			});
		}
		return next;
	}

	await page.route('**/api/v1/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') {
			return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		}
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: {
			user_book: null, progress: state.progress, highlights: state.highlights, notes: state.notes,
			bookmarks: state.bookmarks, page_annotations: state.pageAnnotations
		} });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings: state.settings } });
		if (path === '/api/v1/sync/pull') {
			const cursor = Number(url.searchParams.get('cursor') ?? 0);
			const newer = (row: { rev: number }) => row.rev > cursor;
			return route.fulfill({ json: {
				cursor: state.rev, user_books: [], reading_progress: [],
				highlights: state.highlights.filter(newer), notes: state.notes.filter(newer),
				bookmarks: state.bookmarks.filter(newer), page_annotations: state.pageAnnotations.filter(newer),
				user_settings: state.settings.filter(newer)
			} });
		}
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON() as { mutations: Mutation[] };
			for (const mutation of mutations) {
				state.rev += 1;
				state.mutations.push(mutation);
				const now = new Date(mutation.updated_at).toISOString();
				switch (mutation.entity) {
					case 'highlights': state.highlights = applyRows(state.highlights, mutation, now); break;
					case 'bookmarks': state.bookmarks = applyRows(state.bookmarks, mutation, now); break;
					case 'notes': state.notes = applyRows(state.notes, mutation, now); break;
					case 'page_annotations': state.pageAnnotations = applyRows(state.pageAnnotations, mutation, now); break;
					case 'reading_progress': state.progress = { ...mutation.data, updated_at: now, rev: state.rev }; break;
					case 'user_settings':
						if (!mutation.key) throw new Error('Missing setting key.');
						state.settings = [
							...state.settings.filter((setting) => setting.key !== mutation.key),
							{ key: mutation.key, value: mutation.data.value, updated_at: now, rev: state.rev }
						];
						break;
				}
			}
			return route.fulfill({ json: { results: mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto('/read/21/31');
	return state;
}

async function bookFrame(page: Page): Promise<Frame> {
	let frame: Frame | undefined;
	await expect(async () => {
		frame = page.frames().find((candidate) => candidate.url().startsWith('blob:'));
		expect(frame).toBeDefined();
		await expect(frame!.getByText('First section', { exact: true })).toBeVisible();
	}).toPass({ timeout: 15_000 });
	if (!frame) throw new Error('The EPUB frame is unavailable.');
	return frame;
}

test('PDF navigation, sidebar, marks, appearance and bookmarks work together', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const state = await setup(page, 'pdf');
	await openedPdf(page, 1, 'First PDF page text');

	const title = page.locator('.pv-title');
	const startTitle = await title.boundingBox();
	if (!startTitle) throw new Error('The reader title is unavailable.');
	const originalX = (await page.locator('#reader-surface').boundingBox())?.x;
	expect(originalX).toBe(44);

	await tab(page, 'Contents').click();
	await expect(panel(page, 'Contents').getByRole('treeitem', { name: /Part Two/ })).toBeVisible();
	await expect.poll(async () => (await page.locator('#reader-surface').boundingBox())?.x).toBe(344);
	await panel(page, 'Contents').getByRole('treeitem', { name: /Part Two/ }).click();
	await expect(pdfPageBox(page)).toHaveValue('3');
	await expect(page.getByLabel('Progress 100.00%')).toBeVisible();
	const endTitle = await title.boundingBox();
	if (!endTitle) throw new Error('The reader title disappeared.');
	expect(Math.abs(startTitle.x - endTitle.x)).toBeLessThanOrEqual(1);
	await expect(panel(page, 'Contents').getByRole('treeitem', { name: /Part Two/ })).toHaveAttribute('aria-current', 'location');
	expect((await new AxeBuilder({ page }).include('.pv-sidebar-panel').analyze()).violations).toEqual([]);

	await tab(page, 'Pages').click();
	const pages = panel(page, 'Pages');
	await expect(pages.getByRole('button', { name: 'Page 3', exact: true })).toHaveAttribute('aria-current', 'page');
	await pages.getByRole('button', { name: 'Page 2', exact: true }).click();
	await expect(pdfPageBox(page)).toHaveValue('2');
	await expect(pages.getByRole('button', { name: 'Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
	await page.reload();
	await openedPdf(page);
	await expect(panel(page, 'Pages')).toBeVisible();
	await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pandalibrary.reader-sidebar') ?? 'null')))
		.toEqual({ open: true, tab: 'pages' });

	await tab(page, 'Bookmarks').click();
	const bookmarks = panel(page, 'Bookmarks');
	await bookmarks.getByRole('button', { name: 'Bookmark this page', exact: true }).click();
	await expect(bookmarks.getByRole('button', { name: 'Remove page bookmark', exact: true })).toBeVisible();
	await expect.poll(() => state.bookmarks.length).toBe(1);
	await page.reload();
	await openedPdf(page);
	await expect(panel(page, 'Bookmarks').getByRole('button', { name: 'Remove page bookmark', exact: true })).toBeVisible();
	await panel(page, 'Bookmarks').getByRole('button', { name: 'Remove page bookmark', exact: true }).click();
	await expect.poll(() => state.bookmarks.length).toBe(0);

	await tab(page, 'Annotations').click();
	await expect(panel(page, 'Annotations')).toContainText('No annotations yet.');
	await selectPdfText(page, 'Second PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Underline', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(1);
	const underline = state.highlights[0];
	expect(underline).toMatchObject({ style: 'underline', color: '#000000' });

	await selectPdfText(page, 'Second PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
	const palette = page.getByRole('radiogroup', { name: 'Highlight colors' });
	await expect(palette.locator('[role="radio"][data-color]')).toHaveCount(16);
	await expect(palette.getByRole('radio')).toHaveCount(17);
	await palette.getByRole('radio', { name: 'Red', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(2);
	const red = state.highlights.find((row) => row.color === '#f87171');
	if (!red) throw new Error('The red preset highlight was not saved.');

	await selectPdfText(page, 'Second PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
	const customPalette = page.getByRole('radiogroup', { name: 'Highlight colors' });
	const picker = customPalette.locator('input[type="color"]');
	await picker.evaluate((input) => input.addEventListener('click', (event) => event.preventDefault()));
	await customPalette.getByRole('radio', { name: 'Custom…', exact: true }).click();
	await picker.evaluate((input) => {
		if (!(input instanceof HTMLInputElement)) throw new Error('The custom colour picker is unavailable.');
		input.value = '#123456';
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await expect.poll(() => state.highlights.length).toBe(3);
	const custom = state.highlights.find((row) => row.color === '#123456');
	if (!custom) throw new Error('The custom highlight was not saved.');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('pandalibrary.mark-color.custom'))).toBe('#123456');

	const annotations = panel(page, 'Annotations');
	const entry = (id: string) => annotations.locator(`[data-panel-entry="${id}"]`);
	await expect(entry(underline.id).locator('.rp7-swatch')).toHaveCSS('color', 'rgb(0, 0, 0)');
	await expect(entry(red.id).locator('.rp7-swatch')).toHaveCSS('background-color', 'rgb(248, 113, 113)');
	await expect(entry(custom.id).locator('.rp7-swatch')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
	await entry(red.id).locator('[data-rp7-expand]').click();
	const dialog = page.locator('dialog.rp7-dialog');
	await expect(dialog).toContainText('Second PDF page text');
	await expect(dialog).toContainText('Red');
	await dialog.getByRole('button', { name: 'Close annotation details' }).click();

	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	const display = page.getByRole('menu', { name: 'Page display' });
	await expect(display.getByRole('menuitemradio')).toHaveCount(4);
	await expect(display.getByRole('menuitemcheckbox')).toHaveCount(1);
	await expect(display.getByText(/cover alone|background|sepia/i)).toHaveCount(0);
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Format', exact: true }).click();
	await page.getByRole('dialog', { name: 'Format' }).getByRole('radio', { name: 'Night', exact: true }).click();
	await expect(page.locator('#reader-surface')).toHaveAttribute('data-tone', 'dark');
	const paintedLine = page.locator(`.reader-pdf-highlight[data-annotation-id="${underline.id}"]`);
	await expect(paintedLine).toHaveAttribute('data-mark-color', '#000000');
	await expect.poll(() => paintedLine.evaluate((element) => getComputedStyle(element).getPropertyValue('--pv-mark').trim())).toBe('#e5e7eb');
	await page.keyboard.press('Escape');
	await expect.poll(() => state.settings.find((setting) => setting.key === 'reader.book.21')?.value)
		.toMatchObject({ background: 'night' });

	await page.reload();
	await openedPdf(page);
	await expect(panel(page, 'Annotations').locator(`[data-panel-entry="${custom.id}"] .rp7-swatch`))
		.toHaveCSS('background-color', 'rgb(18, 52, 86)');
	await expect(page.locator('#reader-surface')).toHaveAttribute('data-background', 'night');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('pandalibrary.mark-color.custom'))).toBe('#123456');
	const customEntry = panel(page, 'Annotations').locator(`[data-panel-entry="${custom.id}"]`);
	await customEntry.locator('[data-rp7-delete]').click();
	await customEntry.getByRole('button', { name: /^Confirm delete/ }).click();
	await expect(customEntry).toHaveCount(0);
	await expect.poll(() => state.highlights.some((row) => row.id === custom.id)).toBe(false);
});

test('mobile sidebar overlays, navigates and persists its selected tab', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const state = await setup(page, 'pdf');
	await openedPdf(page, 1, 'First PDF page text');
	const surface = page.locator('#reader-surface');
	const original = await surface.boundingBox();
	if (!original) throw new Error('The reader surface is unavailable.');
	await tab(page, 'Contents').click();
	await expect(panel(page, 'Contents')).toBeVisible();
	expect((await surface.boundingBox())?.x).toBe(original.x);
	await panel(page, 'Contents').getByRole('treeitem', { name: /Part Two/ }).click();
	await expect(pdfPageBox(page)).toHaveValue('3');
	await expect(panel(page, 'Contents')).toHaveCount(0);
	await tab(page, 'Pages').click();
	await expect(panel(page, 'Pages').getByRole('button', { name: 'Page 3', exact: true })).toHaveAttribute('aria-current', 'page');
	await panel(page, 'Pages').getByRole('button', { name: 'Page 1', exact: true }).click();
	await expect(pdfPageBox(page)).toHaveValue('1');
	await expect(panel(page, 'Pages')).toHaveCount(0);
	await tab(page, 'Bookmarks').click();
	await panel(page, 'Bookmarks').getByRole('button', { name: 'Bookmark this page', exact: true }).click();
	await expect.poll(() => state.bookmarks.length).toBe(1);
	await page.reload();
	await openedPdf(page);
	await expect(panel(page, 'Bookmarks').getByRole('button', { name: 'Remove page bookmark', exact: true })).toBeVisible();
	await panel(page, 'Bookmarks').focus();
	await page.keyboard.press('Escape');
	await expect(panel(page, 'Bookmarks')).toHaveCount(0);
	await expect(tab(page, 'Bookmarks')).toBeFocused();
});

test('EPUB Format changes typography and background and persists both settings scopes', async ({ page }) => {
	const state = await setup(page, 'epub');
	let frame = await bookFrame(page);
	const initialSize = await frame.locator('body').evaluate((body) => parseFloat(getComputedStyle(body).fontSize));
	await page.getByRole('button', { name: 'Format', exact: true }).click();
	const format = page.getByRole('dialog', { name: 'Format', exact: true });
	await format.getByRole('radio', { name: 'System', exact: true }).click();
	await format.getByRole('button', { name: 'Increase font size', exact: true }).click();
	await format.getByRole('button', { name: 'Increase spacing', exact: true }).click();
	await format.getByRole('radio', { name: 'Wood', exact: true }).click();
	await expect(frame.locator('body')).toHaveCSS('font-family', 'system-ui');
	await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(220, 194, 155)');
	await expect.poll(() => frame.locator('body').evaluate((body) => parseFloat(getComputedStyle(body).fontSize)))
		.toBeCloseTo(initialSize * 1.1, 2);
	await page.getByRole('button', { name: 'Save settings', exact: true }).click();
	await page.getByRole('button', { name: 'Save as format default', exact: true }).click();
	for (const key of ['reader.book.21', 'reader.epub']) {
		await expect.poll(() => state.settings.find((setting) => setting.key === key)?.value)
			.toMatchObject({ font: 'system', size: 110, spacing: 1.6, background: 'wood' });
	}
	await page.reload();
	frame = await bookFrame(page);
	await expect(frame.locator('body')).toHaveCSS('font-family', 'system-ui');
	await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(220, 194, 155)');
});

for (const width of [1280, 375]) {
	for (const theme of ['light', 'dark'] as const) {
		test(`visual reader sidebar at ${width}px in ${theme} app theme`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
			await setup(page, 'pdf', [{
				id: '0190f5c2-7a00-7000-8000-000000000001', book_id: 21, book_file_id: 31, position: 0,
				locator: { type: 'pdf', page: 1, rects: [{ x: 0.1, y: 0.08, width: 0.4, height: 0.05 }] },
				text: 'First PDF page text', style: 'highlight', color: 'yellow', chapter: null,
				created_at: timestamp, updated_at: timestamp, deleted_at: null, rev: 1
			}]);
			await openedPdf(page, 1, 'First PDF page text');
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await tab(page, 'Annotations').click();
			await expect(panel(page, 'Annotations').locator('[data-panel-entry]')).toHaveCount(1);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
			const screenshot = resolve('..', 'docs', 'dev', 'plans', 'assets', `rp-${width}-${theme}.png`);
			await page.screenshot({ path: screenshot, animations: 'disabled' });
			await testInfo.attach(`Reader pane ${width}px ${theme}`, { path: screenshot, contentType: 'image/png' });
		});
	}
}
