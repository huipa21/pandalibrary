import { expect, test, type Page } from '@playwright/test';
import { pdfFixture, scannedPdfFixture } from '../../fixtures';

const id = (n: number) => `0190f5c2-7a00-7000-8000-${String(n).padStart(12, '0')}`;

// Keep mocked API traffic independent of service-worker caching.
test.use({ serviceWorkers: 'block' });
const base = {
	book_id: 21, book_file_id: 31, position: 0,
	created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z', deleted_at: null, rev: 1
};
const seededMark = {
	...base, id: id(1), locator: { type: 'pdf', page: 1, rects: [{ x: 0.11, y: 0.08, width: 0.42, height: 0.04 }] },
	text: 'First PDF page text', color: 'yellow', style: 'highlight', chapter: null
};

type Push = { entity: string; id: string; op: string; data: Record<string, unknown> };
type Rect = { x: number; y: number; width: number; height: number };

interface Options {
	pdf?: Buffer;
	settings?: Record<string, unknown>;
	highlights?: unknown[];
	language?: string;
	waitFor?: string | null;
}

async function setup(page: Page, options: Options = {}) {
	const bytes = options.pdf ?? pdfFixture();
	const file = { id: 31, format: 'pdf', size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}` };
	const book = {
		id: 21, library_id: 1, title: 'Marks fixture', sort_title: 'Marks fixture', subtitle: null,
		description: null, language: options.language ?? 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: base.created_at, updated_at: base.updated_at
	};
	const state = {
		pushes: [] as Push[],
		settings: { pdfLayout: 'single', pdfZoom: 'page-fit', ...options.settings } as Record<string, unknown>,
		highlights: options.highlights ?? []
	};
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') {
			return route.fulfill({ json: { user_book: null, progress: null, highlights: state.highlights, notes: [], bookmarks: [], page_annotations: [] } });
		}
		if (path === '/api/v1/me/settings') {
			return route.fulfill({ json: { settings: [{ key: 'reader.pdf', value: state.settings, updated_at: base.updated_at, rev: 1 }] } });
		}
		if (path === '/api/v1/sync/pull') {
			return route.fulfill({ json: { cursor: 1, user_books: [], reading_progress: [], highlights: [], notes: [], bookmarks: [], page_annotations: [], user_settings: [] } });
		}
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON();
			state.pushes.push(...mutations);
			return route.fulfill({ json: { results: mutations.map((_: unknown, index: number) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	page.on('dialog', (dialog) => dialog.dismiss());
	await page.goto('/read/21/31');
	if (options.waitFor === null) await expect(page.locator('.reader-pdf-page').first()).toBeVisible({ timeout: 30_000 });
	else await expect(page.locator('.reader-pdf-text').first()).toContainText(options.waitFor ?? 'First PDF page text', { timeout: 30_000 });
	return state;
}

/** Selects from the start of the text item containing `from` to the end of the one containing `to`. */
async function selectText(page: Page, from: string, to = from) {
	await page.evaluate(([start, end]) => {
		const items = [...document.querySelectorAll('.reader-pdf .textLayer span')].filter((span) => !span.children.length);
		const find = (text: string) => {
			const item = items.find((span) => span.textContent?.includes(text));
			if (!item?.firstChild) throw new Error(`Missing text ${text}`);
			return item.firstChild as Text;
		};
		const first = find(start);
		const last = find(end);
		const range = document.createRange();
		range.setStart(first, 0);
		range.setEnd(last, last.length);
		const selection = document.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	}, [from, to]);
}

const selectionToolbar = (page: Page) => page.getByRole('toolbar', { name: 'Selection actions', exact: true });
const markToolbar = (page: Page) => page.getByRole('dialog', { name: 'Mark actions', exact: true });
const highlightPushes = (state: { pushes: Push[] }) => state.pushes.filter((row) => row.entity === 'highlights' && row.op === 'upsert');

test('the toolbar appears next to a mouse selection and stays inside a 360 px viewport', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 740 });
	await setup(page, { settings: { pdfZoom: 'page-width' } });
	const span = page.locator('.reader-pdf-text span').filter({ hasText: 'First PDF page text' }).first();
	const box = (await span.boundingBox())!;
	await page.mouse.move(box.x + 1, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
	await page.mouse.up();
	const toolbar = selectionToolbar(page);
	await expect(toolbar).toBeVisible();
	const bar = (await toolbar.boundingBox())!;
	expect(bar.x).toBeGreaterThanOrEqual(0);
	expect(bar.x + bar.width).toBeLessThanOrEqual(360);
	expect(Math.min(Math.abs(bar.y + bar.height - box.y), Math.abs(bar.y - box.y - box.height))).toBeLessThan(24);
	for (const name of ['Copy', 'Highlight', 'Highlight colors', 'Underline', 'Strikeout', 'Comment', 'Bookmark']) {
		await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible();
	}
	await page.screenshot({ path: test.info().outputPath('selection-toolbar-360.png') });
	await page.keyboard.press('Escape');
	await expect(toolbar).toHaveCount(0);
});

test('copies the selection, keeps it, and is reachable by keyboard', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await setup(page);
	await selectText(page, 'First PDF page text');
	await expect(selectionToolbar(page)).toBeVisible();
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('Tab');
	await expect(selectionToolbar(page).getByRole('button', { name: 'Copy', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(selectionToolbar(page).getByRole('button', { name: 'Highlight', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('First PDF page text');
	await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('First PDF page text');
	await page.keyboard.press('Escape');
	await expect(selectionToolbar(page)).toHaveCount(0);
	await expect(page.locator('#reader-surface')).toBeFocused();
});

test('every colour and style pushes one mark and paints the matching element', async ({ page }) => {
	const state = await setup(page);
	const colours = ['Yellow', 'Green', 'Blue', 'Pink', 'Orange', 'Purple'];
	for (const [index, colour] of colours.entries()) {
		await selectText(page, 'First PDF page text');
		await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
		await page.getByRole('radio', { name: colour, exact: true }).click();
		await expect.poll(() => highlightPushes(state).length).toBe(index + 1);
		const pushed = highlightPushes(state).at(-1)!;
		expect(pushed.data).toMatchObject({ color: colour.toLowerCase(), style: 'highlight', text: 'First PDF page text', locator: { type: 'pdf', page: 1 } });
		await expect(page.locator(`.reader-pdf-highlight[data-annotation-id="${pushed.id}"]`)).toHaveAttribute('data-style', 'highlight');
	}
	expect(await page.evaluate(() => localStorage.getItem('pandalibrary.pdf-mark-color'))).toBe('purple');
	for (const [name, style] of [['Underline', 'underline'], ['Strikeout', 'strikeout'], ['Highlight', 'highlight']] as const) {
		await selectText(page, 'First PDF page text');
		await selectionToolbar(page).getByRole('button', { name, exact: true }).click();
		await expect.poll(() => highlightPushes(state).at(-1)?.data.style).toBe(style);
		const pushed = highlightPushes(state).at(-1)!;
		expect(pushed.data.color).toBe('purple');
		await expect(page.locator(`.reader-pdf-highlight[data-annotation-id="${pushed.id}"]`)).toHaveAttribute('data-style', style);
		await expect(selectionToolbar(page)).toHaveCount(0);
	}
	expect(highlightPushes(state)).toHaveLength(9);
	await page.reload();
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await selectText(page, 'First PDF page text');
	await expect(selectionToolbar(page).locator('.pv8-colour-dot')).toHaveCSS('background-color', 'rgb(167, 139, 250)');
});

test('comment saves a note with a marker, and cancelling an empty comment removes the mark', async ({ page }) => {
	const state = await setup(page);
	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Comment', exact: true }).click();
	const popover = page.getByRole('dialog', { name: 'Add comment', exact: true });
	await expect(popover).toBeVisible();
	await popover.getByRole('textbox', { name: 'Note in Markdown' }).fill('A **useful** comment');
	await expect(popover.locator('.reader-note-preview strong')).toHaveText('useful');
	await popover.getByRole('button', { name: 'Save note' }).click();
	await expect(popover).toHaveCount(0);
	const mark = highlightPushes(state)[0];
	await expect.poll(() => state.pushes.find((row) => row.entity === 'notes')?.data).toMatchObject({ highlight_id: mark.id, body_md: 'A **useful** comment' });
	const marker = page.locator(`.pv-mark-comment[data-annotation-id="${mark.id}"]`);
	await expect(marker).toBeVisible();
	await marker.click();
	const editor = page.getByRole('dialog', { name: 'Edit comment', exact: true });
	await expect(editor.locator('.reader-note-preview strong')).toHaveText('useful');
	await editor.getByRole('button', { name: 'Cancel' }).click();
	await expect(editor).toHaveCount(0);

	await page.locator('#reader-surface').focus();
	await page.keyboard.press('End');
	await expect(page.locator('.reader-pdf-page[data-page="2"] .reader-pdf-text')).toContainText('Second PDF page text');
	await selectText(page, 'Second PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Comment', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Add comment', exact: true })).toBeVisible();
	const pageTwo = page.locator('.reader-pdf-page[data-page="2"] .reader-pdf-highlight');
	await expect(pageTwo).toHaveCount(1);
	await page.getByRole('dialog', { name: 'Add comment', exact: true }).getByRole('button', { name: 'Cancel' }).click();
	const second = highlightPushes(state)[1];
	await expect.poll(() => state.pushes.some((row) => row.entity === 'highlights' && row.op === 'delete' && row.id === second.id)).toBe(true);
	await expect(pageTwo).toHaveCount(0);
});

test('bookmark pushes the selection label and position', async ({ page }) => {
	const state = await setup(page);
	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Bookmark', exact: true }).click();
	await expect.poll(() => state.pushes.find((row) => row.entity === 'bookmarks')?.data).toMatchObject({
		label: 'First PDF page text', locator: { type: 'pdf', page: 1, rects: [expect.any(Object)] }
	});
	await expect(page.getByText('Bookmarked page 1')).toBeAttached();
	await expect(selectionToolbar(page)).toHaveCount(0);
});

test('a cross-page selection in continuous mode creates one mark per page', async ({ page }) => {
	const state = await setup(page, { settings: { pdfLayout: 'single-continuous', pdfZoom: 0.5 } });
	await expect(page.locator('.reader-pdf-page[data-page="2"] .reader-pdf-text')).toContainText('Second PDF page text');
	await selectText(page, 'First PDF page text', 'Second PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Highlight', exact: true }).click();
	await expect.poll(() => highlightPushes(state).length).toBe(2);
	const [first, second] = highlightPushes(state);
	expect(first.data).toMatchObject({ text: 'First PDF page text', locator: { page: 1 } });
	expect(second.data).toMatchObject({ text: 'Second PDF page text', locator: { page: 2 } });
	expect(second.data.position as number).toBeGreaterThan(first.data.position as number);
	await expect(page.locator('.reader-pdf-highlight')).toHaveCount(2);
});

test('the mark toolbar recolours, restyles, deletes and Undo restores', async ({ page }) => {
	const state = await setup(page, { highlights: [seededMark] });
	const mark = page.locator(`.reader-pdf-highlight[data-annotation-id="${seededMark.id}"]`);
	await expect(mark).toHaveCount(1);
	await mark.click();
	const toolbar = markToolbar(page);
	await expect(toolbar).toBeVisible();
	await expect(toolbar.getByRole('radio', { name: 'Yellow', exact: true })).toHaveAttribute('aria-checked', 'true');
	await page.screenshot({ path: test.info().outputPath('mark-toolbar-light.png') });
	await toolbar.getByRole('radio', { name: 'Blue', exact: true }).click();
	await expect.poll(() => highlightPushes(state).at(-1)?.data.color).toBe('blue');
	await expect(toolbar.getByRole('radio', { name: 'Blue', exact: true })).toHaveAttribute('aria-checked', 'true');
	await toolbar.getByRole('radio', { name: 'Underline', exact: true }).click();
	await expect.poll(() => highlightPushes(state).at(-1)?.data).toMatchObject({ color: 'blue', style: 'underline' });
	await expect(mark).toHaveAttribute('data-style', 'underline');
	await toolbar.getByRole('button', { name: 'Delete mark', exact: true }).click();
	await expect.poll(() => state.pushes.some((row) => row.op === 'delete' && row.id === seededMark.id)).toBe(true);
	await expect(mark).toHaveCount(0);
	await expect(toolbar).toHaveCount(0);
	await page.getByTestId('pv8-toast').getByRole('button', { name: 'Undo', exact: true }).click();
	await expect.poll(() => highlightPushes(state).filter((row) => row.id === seededMark.id).length).toBe(3);
	expect(highlightPushes(state).at(-1)!.data).toMatchObject({ color: 'blue', style: 'underline' });
	await expect(mark).toHaveAttribute('data-style', 'underline');
});

test('a mark made at rotation 90 is stored in unrotated page space', async ({ page }) => {
	const state = await setup(page);
	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Highlight', exact: true }).click();
	await expect.poll(() => highlightPushes(state).length).toBe(1);
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('Escape');
	await page.keyboard.press('r');
	await expect(page.locator('.textLayer').first()).toHaveAttribute('data-main-rotation', '90');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	const turned = (await page.locator('.reader-pdf-highlight').first().boundingBox())!;
	expect(turned.height).toBeGreaterThan(turned.width);
	await page.locator('.reader-pdf-highlight').first().click();
	await markToolbar(page).getByRole('button', { name: 'Delete mark', exact: true }).click();
	await expect(page.locator('.reader-pdf-highlight')).toHaveCount(0);
	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Underline', exact: true }).click();
	await expect.poll(() => highlightPushes(state).length).toBe(2);
	const [upright, rotated] = highlightPushes(state).map((row) => (row.data.locator as { rects: Rect[] }).rects);
	expect(rotated).toHaveLength(upright.length);
	for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(rotated[0][key] - upright[0][key])).toBeLessThan(0.01);
	await expect(page.locator('.reader-pdf-highlight')).toHaveCount(1);
	const painted = (await page.locator('.reader-pdf-highlight').first().boundingBox())!;
	expect(painted.height).toBeGreaterThan(painted.width);
});

test('Hand mode shows no selection toolbar when dragging', async ({ page }) => {
	await setup(page);
	await page.getByRole('button', { name: 'Select tool' }).click();
	await expect(page.locator('#reader-surface')).toHaveAttribute('data-tool', 'hand');
	const box = (await page.locator('.reader-pdf-text span').first().boundingBox())!;
	await page.mouse.move(box.x + 1, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(300);
	await expect(selectionToolbar(page)).toHaveCount(0);
});

test('offline marks are queued in the outbox and painted', async ({ page }) => {
	const state = await setup(page);
	await page.route('**/api/v1/sync/push', (route) => route.abort('internetdisconnected'));
	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Highlight', exact: true }).click();
	await expect(page.locator('.reader-pdf-highlight')).toHaveCount(1);
	const id = await page.locator('.reader-pdf-highlight').getAttribute('data-annotation-id');
	await expect.poll(() => page.evaluate(async () => {
		const request = indexedDB.open('pandalibrary-offline');
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const rows = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
			return JSON.stringify(await new Promise<unknown[]>((resolve, reject) => {
				rows.onsuccess = () => resolve(rows.result);
				rows.onerror = () => reject(rows.error);
			}));
		} finally { db.close(); }
	})).toContain(id!);
	expect(highlightPushes(state)).toHaveLength(0);
});

for (const theme of ['light', 'dark']) {
	test(`palette and mark toolbar in the ${theme} theme`, async ({ page }) => {
		await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
		await setup(page, { highlights: [seededMark], settings: { theme } });
		await selectText(page, 'First PDF page text');
		await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
		await expect(page.getByRole('radiogroup', { name: 'Highlight colors' })).toBeVisible();
		await page.screenshot({ path: test.info().outputPath(`palette-${theme}.png`) });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await page.locator('.reader-pdf-highlight').first().click();
		await expect(markToolbar(page)).toBeVisible();
		await page.screenshot({ path: test.info().outputPath(`mark-toolbar-${theme}.png`) });
		await markToolbar(page).getByRole('button', { name: 'Add comment', exact: true }).click();
		const comment = page.getByRole('dialog', { name: 'Add comment', exact: true });
		const editor = comment.getByRole('textbox', { name: 'Note in Markdown' });
		await editor.fill('A **readable** comment');
		await expect(comment.locator('.reader-note-preview strong')).toHaveText('readable');
		await expect(editor).toHaveCSS('color', 'rgb(15, 23, 42)');
		await expect(comment.locator('.reader-note-preview')).toHaveCSS('color', 'rgb(15, 23, 42)');
	});
}

async function scannedPage(page: Page) {
	await page.goto('about:blank');
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 1200;
		canvas.height = 480;
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'white';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.fillStyle = 'black';
		context.font = '64px serif';
		context.fillText('Scanned PDF sample', 70, 180);
		return canvas.toDataURL('image/png').split(',')[1];
	});
	return scannedPdfFixture([{ png: Buffer.from(png, 'base64'), width: 600, height: 240 }]);
}

test('scanned pages are recognized, marked with the recognized text, and the switch removes OCR text', async ({ page }) => {
	test.slow();
	const pdf = await scannedPage(page);
	const state = await setup(page, { pdf, waitFor: null });
	const text = page.locator('.pv-ocr-text');
	await expect(text).toContainText('Scanned', { timeout: 60_000 });
	const span = text.locator('span').filter({ hasText: 'Scanned' }).first();
	const box = (await span.boundingBox())!;
	await page.mouse.move(box.x + 1, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
	await page.mouse.up();
	await selectionToolbar(page).getByRole('button', { name: 'Highlight', exact: true }).click();
	await expect.poll(() => highlightPushes(state)[0]?.data.text).toContain('Scanned');
	await expect(page.locator('.reader-pdf-highlight')).not.toHaveCount(0);
	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Recognize text in scanned pages' }).click();
	await expect(text).toHaveCount(0);
	await expect(page.locator('.reader-pdf-highlight')).not.toHaveCount(0);
});
