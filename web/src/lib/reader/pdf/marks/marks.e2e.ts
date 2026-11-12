import { expect, test, type Page } from '@playwright/test';
import axe from 'axe-core';
import { pdfFixture, scannedPdfFixture } from '../../fixtures';

declare global {
	interface Window {
		axe?: typeof axe;
	}
}

const id = (n: number) => `0190f5c2-7a00-7000-8000-${String(n).padStart(12, '0')}`;

// Keep mocked API traffic independent of service-worker caching.
test.use({ serviceWorkers: 'block', bypassCSP: true });
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
			const { mutations }: { mutations: Push[] } = route.request().postDataJSON();
			state.pushes.push(...mutations);
			for (const mutation of mutations) {
				if (mutation.entity !== 'highlights') continue;
				const previous = state.highlights.find((row): row is Record<string, unknown> =>
					typeof row === 'object' && row !== null && 'id' in row && row.id === mutation.id);
				state.highlights = state.highlights.filter((row) =>
					typeof row !== 'object' || row === null || !('id' in row) || row.id !== mutation.id);
				if (mutation.op === 'upsert') {
					state.highlights.push({ ...base, ...previous, ...mutation.data, id: mutation.id });
				}
			}
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
	for (const name of ['Copy', 'Highlight', 'Highlight colors', 'Underline', 'Strikeout', 'Line colors', 'Comment', 'Bookmark']) {
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
	expect(await page.evaluate(() => localStorage.getItem('pandalibrary.mark-color.highlight'))).toBe('purple');
	for (const [name, style] of [['Underline', 'underline'], ['Strikeout', 'strikeout'], ['Highlight', 'highlight']] as const) {
		await selectText(page, 'First PDF page text');
		await selectionToolbar(page).getByRole('button', { name, exact: true }).click();
		await expect.poll(() => highlightPushes(state).at(-1)?.data.style).toBe(style);
		const pushed = highlightPushes(state).at(-1)!;
		expect(pushed.data.color).toBe(style === 'highlight' ? 'purple' : '#000000');
		await expect(page.locator(`.reader-pdf-highlight[data-annotation-id="${pushed.id}"]`)).toHaveAttribute('data-style', style);
		await expect(selectionToolbar(page)).toHaveCount(0);
	}
	expect(highlightPushes(state)).toHaveLength(9);
	await page.reload();
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await selectText(page, 'First PDF page text');
	await expect(selectionToolbar(page).locator('.pv8-split .pv8-colour-dot')).toHaveCSS('background-color', 'rgb(167, 139, 250)');
});

test('new highlights are yellow and both line styles are black by default', async ({ page }) => {
	const state = await setup(page);
	for (const [label, style, color] of [
		['Underline', 'underline', '#000000'],
		['Strikeout', 'strikeout', '#000000'],
		['Highlight', 'highlight', 'yellow']
	] as const) {
		await selectText(page, 'First PDF page text');
		await selectionToolbar(page).getByRole('button', { name: label, exact: true }).click();
		await expect.poll(() => highlightPushes(state).at(-1)?.data).toMatchObject({ style, color });
		const pushed = highlightPushes(state).at(-1)!;
		const mark = page.locator(`.reader-pdf-highlight[data-annotation-id="${pushed.id}"]`);
		await expect(mark).toHaveAttribute('data-style', style);
		await expect(mark).toHaveCSS('opacity', style === 'highlight' ? '0.35' : '1');
		await expect(mark).toHaveCSS('mix-blend-mode', style === 'highlight' ? 'multiply' : 'normal');
	}
});

test('preset and custom colours persist separately and a hex mark syncs and renders after reload', async ({ page }) => {
	const state = await setup(page);
	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
	await page.getByRole('radio', { name: 'Red', exact: true }).click();
	await expect.poll(() => highlightPushes(state).length).toBe(1);
	expect(highlightPushes(state)[0].data.color).toBe('#f87171');

	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Line colors', exact: true }).click();
	await page.getByRole('radio', { name: 'Cyan', exact: true }).click();
	expect(highlightPushes(state)).toHaveLength(1);
	await expect(selectionToolbar(page)).toBeVisible();
	await expect.poll(() => page.evaluate(() => localStorage.getItem('pandalibrary.mark-color.line'))).toBe('#22d3ee');

	await selectionToolbar(page).getByRole('button', { name: 'Line colors', exact: true }).click();
	const palette = page.getByRole('radiogroup', { name: 'Line colors' });
	const picker = palette.locator('input[type="color"]');
	await picker.evaluate((input) => input.addEventListener('click', (event) => {
		event.preventDefault();
		input.setAttribute('data-picker-opened', 'true');
	}));
	await palette.getByRole('radio', { name: 'Custom…', exact: true }).click();
	await expect(picker).toHaveAttribute('data-picker-opened', 'true');
	await picker.evaluate((element) => {
		if (!(element instanceof HTMLInputElement)) throw new Error('Missing color picker');
		element.value = '#123456';
		element.dispatchEvent(new Event('change', { bubbles: true }));
	});
	expect(highlightPushes(state)).toHaveLength(1);
	await expect.poll(() => page.evaluate(() => localStorage.getItem('pandalibrary.mark-color.custom'))).toBe('#123456');
	await selectionToolbar(page).getByRole('button', { name: 'Underline', exact: true }).click();
	await expect.poll(() => highlightPushes(state).length).toBe(2);
	const line = highlightPushes(state)[1];
	expect(line.data).toMatchObject({ color: '#123456', style: 'underline' });

	await page.reload();
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	const paintedHighlight = page.locator(`.reader-pdf-highlight[data-annotation-id="${highlightPushes(state)[0].id}"]`);
	await expect.poll(() => paintedHighlight.evaluate((element) => getComputedStyle(element).getPropertyValue('--pv-mark').trim())).toBe('#f87171');
	const painted = page.locator(`.reader-pdf-highlight[data-annotation-id="${line.id}"]`);
	await expect(painted).toHaveAttribute('data-style', 'underline');
	await expect.poll(() => painted.evaluate((element) => getComputedStyle(element).getPropertyValue('--pv-mark').trim())).toBe('#123456');
	await selectText(page, 'First PDF page text');
	const toolbar = selectionToolbar(page);
	await expect(toolbar.locator('.pv8-split .pv8-colour-dot')).toHaveCSS('background-color', 'rgb(248, 113, 113)');
	await expect(toolbar.locator('.pv8-line-caret .pv8-colour-dot')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
	await toolbar.getByRole('button', { name: 'Line colors', exact: true }).click();
	await expect(page.getByRole('radio', { name: 'Custom…', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('mark palettes use a 2D keyboard grid, including the custom slot', async ({ page }) => {
	const state = await setup(page);
	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
	const palette = page.getByRole('radiogroup', { name: 'Highlight colors' });
	await expect(palette.getByRole('radio')).toHaveCount(17);
	const boxes = await palette.getByRole('radio').evaluateAll((buttons) =>
		buttons.map((button) => {
			const { x, y, width, height } = button.getBoundingClientRect();
			return { x, y, width, height };
		})
	);
	expect(boxes.every((box) => box.width === 24 && box.height === 24)).toBe(true);
	expect(boxes[1].x - boxes[0].x).toBe(28);
	expect(boxes.slice(0, 8).every((box) => box.y === boxes[0].y)).toBe(true);
	expect(boxes.slice(8, 16).every((box) => box.y === boxes[0].y + 28)).toBe(true);
	expect(boxes[16].y).toBe(boxes[0].y + 56);
	const yellow = palette.getByRole('radio', { name: 'Yellow', exact: true });
	const lime = palette.getByRole('radio', { name: 'Lime', exact: true });
	const custom = palette.getByRole('radio', { name: 'Custom…', exact: true });
	await expect(custom.locator('.pv8-custom-inner')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
	await expect(yellow).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(lime).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(custom).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(lime).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(palette.getByRole('radio', { name: 'Teal', exact: true })).toBeFocused();
	await page.keyboard.press('Home');
	await expect(yellow).toBeFocused();
	await page.keyboard.press('End');
	await expect(custom).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true })).toBeFocused();
	await selectionToolbar(page).getByRole('button', { name: 'Line colors', exact: true }).click();
	const linePalette = page.getByRole('radiogroup', { name: 'Line colors' });
	await page.keyboard.press('Home');
	await page.keyboard.press('ArrowDown');
	await expect(linePalette.getByRole('radio', { name: 'Lime', exact: true })).toBeFocused();
	await page.keyboard.press('Space');
	await expect(linePalette).toHaveCount(0);
	expect(highlightPushes(state)).toHaveLength(0);
	await selectionToolbar(page).getByRole('button', { name: 'Underline', exact: true }).click();
	await expect.poll(() => highlightPushes(state).at(-1)?.data).toMatchObject({ style: 'underline', color: '#a3e635' });
});

test('the selection palette stays inside a short reader viewport', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 240 });
	await setup(page, { settings: { pdfZoom: 'page-width' } });
	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Line colors', exact: true }).click();
	const popover = selectionToolbar(page).locator('.pv8-palette-popover');
	const viewport = page.locator('.reader-pdf');
	await expect.poll(async () => {
		const [paletteBox, viewportBox] = await Promise.all([popover.boundingBox(), viewport.boundingBox()]);
		return !!paletteBox && !!viewportBox &&
			paletteBox.y >= viewportBox.y && paletteBox.y + paletteBox.height <= viewportBox.y + viewportBox.height;
	}).toBe(true);
	await expect(popover.getByRole('radio', { name: 'Custom…', exact: true })).toBeInViewport();
});

test('dark tone repaints line ink and highlight blend without changing stored colours', async ({ page }) => {
	const line = { ...seededMark, id: id(2), color: '#000000', style: 'underline' };
	const state = await setup(page, { highlights: [seededMark, line] });
	const viewport = page.locator('.reader-pdf');
	const mark = page.locator(`.reader-pdf-highlight[data-annotation-id="${line.id}"]`);
	const highlight = page.locator(`.reader-pdf-highlight[data-annotation-id="${seededMark.id}"]`);
	const ink = () => mark.evaluate((element) => getComputedStyle(element, '::after').backgroundColor);
	await expect(mark).toBeVisible();
	await expect.poll(ink).toBe('rgb(0, 0, 0)');
	await viewport.evaluate((element) => element.setAttribute('data-tone', 'dark'));
	await expect.poll(ink).toBe('rgb(229, 231, 235)');
	await expect(highlight).toHaveCSS('mix-blend-mode', 'screen');
	await expect(highlight).toHaveCSS('opacity', '0.35');
	await expect(mark).toHaveAttribute('data-mark-color', '#000000');
	await viewport.evaluate((element) => element.setAttribute('data-tone', 'light'));
	await expect(viewport).toHaveAttribute('data-tone', 'light');
	await expect(mark).toHaveAttribute('data-mark-color', '#000000');
	await expect.poll(ink).toBe('rgb(0, 0, 0)');
	await expect(highlight).toHaveCSS('mix-blend-mode', 'multiply');
	await viewport.evaluate((element) => {
		element.removeAttribute('data-tone');
		element.setAttribute('data-theme', 'dark');
	});
	await expect.poll(ink).toBe('rgb(229, 231, 235)');
	await expect(highlight).toHaveCSS('mix-blend-mode', 'screen');
	await viewport.evaluate((element) => element.setAttribute('data-theme', 'light'));
	await expect.poll(ink).toBe('rgb(0, 0, 0)');
	expect(state.pushes.filter((row) => row.entity === 'highlights')).toHaveLength(0);
});

test('recolouring an existing mark remembers its style family without changing its colour on style switches', async ({ page }) => {
	const state = await setup(page, { highlights: [seededMark] });
	await page.locator('.reader-pdf-highlight').first().click();
	const toolbar = markToolbar(page);
	await toolbar.getByRole('radio', { name: 'Blue', exact: true }).click();
	await expect.poll(() => page.evaluate(() => localStorage.getItem('pandalibrary.mark-color.highlight'))).toBe('blue');
	await toolbar.getByRole('radio', { name: 'Underline', exact: true }).click();
	await expect.poll(() => highlightPushes(state).at(-1)?.data).toMatchObject({ color: 'blue', style: 'underline' });
	await toolbar.getByRole('radio', { name: 'Red', exact: true }).click();
	await expect.poll(() => page.evaluate(() => localStorage.getItem('pandalibrary.mark-color.line'))).toBe('#f87171');
	await toolbar.getByRole('radio', { name: 'Highlight', exact: true }).click();
	await expect.poll(() => highlightPushes(state).at(-1)?.data).toMatchObject({ color: '#f87171', style: 'highlight' });
	expect(await page.evaluate(() => localStorage.getItem('pandalibrary.mark-color.highlight'))).toBe('blue');
});

for (const theme of ['light', 'dark']) {
	test(`mark palettes pass axe in the ${theme} theme`, async ({ page }) => {
		await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
		await setup(page, { highlights: [seededMark], settings: { theme } });
		await page.addScriptTag({ content: axe.source });
		const violations = async (selector: string) => page.evaluate(async (target) => {
			const element = document.querySelector(target);
			if (!element || !window.axe) throw new Error('Missing palette or axe');
			const results = await window.axe.run(element);
			return results.violations.map(({ id, impact, nodes }) => ({
				id, impact, nodes: nodes.map(({ html, failureSummary }) => ({ html, failureSummary }))
			}));
		}, selector);
		await selectText(page, 'First PDF page text');
		await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
		expect(await violations('[data-testid="pv8-selection-toolbar"]')).toEqual([]);
		await page.keyboard.press('Escape');
		await selectionToolbar(page).getByRole('button', { name: 'Line colors', exact: true }).click();
		expect(await violations('[data-testid="pv8-selection-toolbar"]')).toEqual([]);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await page.locator('.reader-pdf-highlight').first().click();
		await expect(markToolbar(page)).toBeVisible();
		expect(await violations('[data-testid="pv8-mark-toolbar"]')).toEqual([]);
	});
}

test('comment saves a note with a marker, and cancelling an empty comment removes the mark', async ({ page }) => {
	const state = await setup(page);
	await selectText(page, 'First PDF page text');
	await selectionToolbar(page).getByRole('button', { name: 'Comment', exact: true }).click();
	const popover = page.getByRole('dialog', { name: 'Add comment', exact: true });
	await expect(popover).toBeVisible();
	await popover.getByRole('textbox').fill('A **useful** comment');
	await expect(popover.locator('textarea')).toHaveValue('A **useful** comment');
	await expect(popover.locator('.cm-editor, .reader-note-preview')).toHaveCount(0);
	await page.screenshot({ path: test.info().outputPath('sticky-note-comment.png') });
	await popover.getByRole('button', { name: 'Save note' }).click();
	await expect(popover).toHaveCount(0);
	const mark = highlightPushes(state)[0];
	await expect.poll(() => state.pushes.find((row) => row.entity === 'notes')?.data).toMatchObject({ highlight_id: mark.id, body_md: 'A **useful** comment' });
	const marker = page.locator(`.pv-mark-comment[data-annotation-id="${mark.id}"]`);
	await expect(marker).toBeVisible();
	await expect(marker.locator('svg')).toHaveCount(1);
	await marker.click();
	const editor = page.getByRole('dialog', { name: 'Edit comment', exact: true });
	await expect(editor.getByRole('textbox')).toHaveValue('A **useful** comment');
	await expect(editor.locator('.cm-editor, .reader-note-preview')).toHaveCount(0);
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
		const editor = comment.getByRole('textbox');
		await editor.fill('A **readable** comment');
		await expect(editor).toHaveValue('A **readable** comment');
		await expect(comment.locator('.cm-editor, .reader-note-preview')).toHaveCount(0);
		await expect(editor).toHaveCSS('color', 'rgb(73, 61, 27)');
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
