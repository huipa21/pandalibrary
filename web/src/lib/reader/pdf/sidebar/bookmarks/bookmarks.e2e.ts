import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { build } from 'vite';
import { pdfFixture } from '../../../fixtures.js';
import type { Bookmark } from '../../../types.js';

test.use({ serviceWorkers: 'block' });
const id = (n: number) => `0190f5c2-7a00-7000-8000-${String(n).padStart(12, '0')}`;
const base = {
	book_id: 21, book_file_id: 31, position: 0, chapter: null,
	created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z', deleted_at: null, rev: 1
};
const saved = (n: number, extra: Partial<Bookmark> = {}): Bookmark => ({
	...base, id: id(n), locator: { type: 'pdf', page: 1 }, label: `Saved ${n}`, ...extra
});
type Push = { entity: string; id: string; op: string; updated_at: number; data: Record<string, unknown> };
const panel = (page: Page) => page.getByRole('tabpanel', { name: 'Bookmarks', exact: true });
const entry = (page: Page, n: number) => panel(page).locator(`[data-bookmark-id="${id(n)}"]`);
const pageBox = (page: Page) => page.getByRole('textbox', { name: /^Page \d+ of \d+$/ });

async function setup(page: Page, bookmarks: Bookmark[] = [], width = 1280, locale = 'en') {
	await page.setViewportSize({ width, height: 800 });
	await page.addInitScript(() => localStorage.setItem('pandalibrary.reader-sidebar', '{"open":true,"tab":"bookmarks"}'));
	const bytes = pdfFixture();
	const file = { id: 31, format: 'pdf', size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}` };
	const book = {
		id: 21, library_id: 1, title: 'Bookmarks fixture', sort_title: 'Bookmarks fixture', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: base.created_at, updated_at: base.updated_at
	};
	const pushes: Push[] = [];
	let cursor = 1;
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: { user_book: null, progress: null, highlights: [], notes: [], bookmarks, page_annotations: [] } });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings: [
			{ key: 'reader.pdf', value: { pdfLayout: 'single', pdfZoom: 'page-fit' }, updated_at: base.updated_at, rev: 1 }
		] } });
		if (path === '/api/v1/sync/pull') {
			const since = Number(new URL(route.request().url()).searchParams.get('cursor') ?? 0);
			return route.fulfill({ json: {
				cursor, user_books: [], reading_progress: [], highlights: [], notes: [],
				bookmarks: bookmarks.filter((row) => row.rev > since), page_annotations: [], user_settings: []
			} });
		}
		if (path === '/api/v1/sync/push') {
			const { mutations }: { mutations: Push[] } = route.request().postDataJSON();
			pushes.push(...mutations);
			for (const mutation of mutations) {
				if (mutation.entity !== 'bookmarks') continue;
				const index = bookmarks.findIndex((row) => row.id === mutation.id);
				const now = new Date(mutation.updated_at).toISOString();
				const row = {
					...(index < 0 ? saved(0) : bookmarks[index]),
					...(mutation.op === 'upsert' ? mutation.data : {}),
					id: mutation.id, rev: ++cursor, updated_at: now,
					deleted_at: mutation.op === 'delete' ? now : null
				};
				if (index < 0) bookmarks.push(row);
				else bookmarks[index] = row;
			}
			return route.fulfill({ json: { results: mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await expect(page.locator('.rp8-bookmarks')).toBeVisible();
	return pushes;
}

test('page toggle adds an exact page-level locator and removes it without a second confirmation', async ({ page }) => {
	const pushes = await setup(page);
	const dialogs: string[] = [];
	page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
	await expect(panel(page)).toContainText('No bookmarks yet.');
	await panel(page).getByRole('button', { name: 'Bookmark this page', exact: true }).click();
	const toggle = panel(page).getByRole('button', { name: 'Remove page bookmark', exact: true });
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(panel(page).locator('[data-bookmark-id]')).toHaveCount(1);
	await expect.poll(() => pushes.filter((row) => row.entity === 'bookmarks').length).toBe(1);
	expect(pushes.find((row) => row.entity === 'bookmarks')?.data).toMatchObject({
		locator: { type: 'pdf', page: 1 }, label: 'Page 1', position: 0
	});
	expect(pushes.find((row) => row.entity === 'bookmarks')?.data.locator).toEqual({ type: 'pdf', page: 1 });
	await pageBox(page).fill('2');
	await pageBox(page).press('Enter');
	await expect(panel(page).getByRole('button', { name: 'Bookmark this page', exact: true })).toBeVisible();
	await pageBox(page).fill('1');
	await pageBox(page).press('Enter');
	await toggle.click();
	await expect(panel(page)).toContainText('No bookmarks yet.');
	await expect.poll(() => pushes.filter((row) => row.entity === 'bookmarks' && row.op === 'delete').length).toBe(1);
	expect(dialogs).toEqual([]);
});

test('selection bookmarks do not activate the page toggle; rename validates, trims, and cancels on Escape and blur', async ({ page }) => {
	const bookmark = saved(1, { locator: { type: 'pdf', page: 1, rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.1 }] } });
	const pushes = await setup(page, [bookmark]);
	const row = entry(page, 1);
	await expect(panel(page).getByRole('button', { name: 'Bookmark this page', exact: true })).toHaveAttribute('aria-pressed', 'false');
	expect((await row.boundingBox())?.height).toBe(36);
	const rename = () => row.getByRole('button', { name: /^Rename bookmark:/ }).click();
	await rename();
	const input = panel(page).getByRole('textbox', { name: 'Bookmark label', exact: true });
	await input.fill('  New label  ');
	await input.press('Enter');
	await expect(row.getByRole('button', { name: /New label p. 1/ })).toBeVisible();
	await expect.poll(() => pushes.filter((row) => row.entity === 'bookmarks').length).toBe(1);
	expect(pushes.find((row) => row.entity === 'bookmarks')?.data).toMatchObject({
		label: 'New label', locator: bookmark.locator, position: bookmark.position
	});
	await rename();
	await input.fill('Discard me');
	await input.press('Escape');
	await expect(panel(page)).toBeVisible();
	await expect(row.getByRole('button', { name: /New label p. 1/ })).toBeFocused();
	await rename();
	await input.fill('Cancel on blur');
	await input.press('Tab');
	await expect(input).toHaveCount(0);
	await rename();
	for (const invalid of ['', 'a'.repeat(201), '书'.repeat(171)]) {
		await input.fill(invalid);
		await input.press('Enter');
		await expect(input).toHaveAttribute('aria-invalid', 'true');
		await expect(panel(page).getByRole('alert')).toBeVisible();
	}
	await input.press('Escape');
	expect(pushes.filter((row) => row.entity === 'bookmarks')).toHaveLength(1);
});

test('delete requires a second click within three seconds and never opens a browser confirmation', async ({ page }) => {
	const pushes = await setup(page, [saved(1)]);
	const row = entry(page, 1);
	const dialogs: string[] = [];
	page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
	await row.getByRole('button', { name: 'Delete bookmark: Saved 1', exact: true }).click();
	await expect(row.getByRole('button', { name: 'Confirm delete bookmark: Saved 1', exact: true })).toHaveText('Delete?');
	expect(pushes.filter((row) => row.entity === 'bookmarks')).toHaveLength(0);
	await expect(row.getByRole('button', { name: 'Delete bookmark: Saved 1', exact: true })).toBeVisible({ timeout: 5000 });
	await row.getByRole('button', { name: 'Delete bookmark: Saved 1', exact: true }).click();
	await row.getByRole('button', { name: 'Confirm delete bookmark: Saved 1', exact: true }).click();
	await expect(row).toHaveCount(0);
	await expect.poll(() => pushes.filter((row) => row.entity === 'bookmarks' && row.op === 'delete').length).toBe(1);
	expect(dialogs).toEqual([]);
});

test('current file rows are ordered and other files are read-only in a trailing group', async ({ page }) => {
	await setup(page, [
		saved(2, { locator: { type: 'pdf', page: 2 } }), saved(1),
		saved(3, { book_file_id: 32, label: 'Other file' }),
		saved(4, { book_file_id: null, label: 'Missing file' }),
		saved(5, { deleted_at: base.updated_at })
	]);
	await expect(panel(page)).toContainText('2 bookmarks');
	expect(await panel(page).locator('[data-bookmark-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-bookmark-id')))).toEqual([id(1), id(2)]);
	const other = panel(page).getByRole('list', { name: 'Other files', exact: true });
	await expect(other.getByRole('button')).toHaveCount(2);
	for (const button of await other.getByRole('button').all()) await expect(button).toBeDisabled();
	await expect(panel(page)).not.toContainText('Saved 5');
});

test('offline page bookmarks and label edits are queued and survive reconnect and reload', async ({ page, context }) => {
	const pushes = await setup(page);
	await context.setOffline(true);
	await panel(page).getByRole('button', { name: 'Bookmark this page', exact: true }).click();
	await expect(panel(page).locator('[data-bookmark-id]')).toHaveCount(1);
	await panel(page).getByRole('button', { name: 'Rename bookmark: Page 1', exact: true }).click();
	const input = panel(page).getByRole('textbox', { name: 'Bookmark label', exact: true });
	await input.fill('Offline label');
	await input.press('Enter');
	await expect(panel(page).locator('[data-bookmark-jump]')).toContainText('Offline label');
	expect(pushes.filter((row) => row.entity === 'bookmarks')).toHaveLength(0);
	await context.setOffline(false);
	await expect.poll(() => pushes.some((row) => row.entity === 'bookmarks' && row.data.label === 'Offline label')).toBe(true);
	await page.reload();
	await expect(panel(page).locator('[data-bookmark-jump]')).toContainText('Offline label');
});

test('jump changes page and collapses the overlay sidebar', async ({ page }) => {
	await setup(page, [saved(2, { locator: { type: 'pdf', page: 2 }, position: 1 })], 800);
	await entry(page, 2).locator('[data-bookmark-jump]').click();
	await expect(pageBox(page)).toHaveValue('2');
	await expect(panel(page)).toBeHidden();
	await expect(page.getByRole('tab', { name: 'Bookmarks', exact: true })).toBeFocused();
});

test('a bookmark from the floating selection toolbar appears in the tab', async ({ page }) => {
	await setup(page);
	await page.locator('.reader-pdf-text span').filter({ hasText: 'First PDF page text' }).first().evaluate((element) => {
		const text = element.firstChild;
		if (!text) throw new Error('The PDF selection text is missing.');
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, text.textContent!.length);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	});
	await page.getByRole('button', { name: 'Bookmark', exact: true }).click();
	await expect(panel(page).locator('[data-bookmark-id]')).toHaveCount(1);
	await expect(panel(page).locator('[data-bookmark-jump]')).toContainText('First PDF page text');
	await expect(panel(page).getByRole('button', { name: 'Bookmark this page', exact: true })).toBeVisible();
});

test('reveal scrolls, focuses and flashes the entry again for each new target sequence', async ({ page }) => {
	test.setTimeout(90_000);
	const result = await build({
		configFile: false,
		plugins: [
			svelte(),
			{
				name: 'bookmarks-fixture-navigation',
				resolveId: (source) => source === '$app/navigation' ? '\0rp8-navigation' : null,
				load: (id) => id === '\0rp8-navigation'
					? 'export function goto() { throw new Error("Unexpected navigation in reveal fixture"); }' : null
			}
		],
		resolve: { alias: [{ find: '#lib', replacement: resolve('src/lib') }] },
		build: {
			target: 'esnext',
			write: false,
			lib: { entry: resolve('src/lib/reader/pdf/sidebar/bookmarks/bookmarks-fixture.ts'), formats: ['es'] },
			rolldownOptions: { output: { codeSplitting: false } }
		}
	});
	const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
		if (!('output' in item)) throw new Error('Unexpected reveal fixture build result.');
		return item.output;
	});
	const script = outputs.find((item) => item.type === 'chunk' && item.isEntry);
	const css = outputs.find((item) => item.type === 'asset' && item.fileName.endsWith('.css'));
	if (!script || script.type !== 'chunk' || !css || css.type !== 'asset') throw new Error('Missing reveal fixture output.');
	await setup(page, Array.from({ length: 20 }, (_, i) => saved(i + 1)));
	await page.route('**/rp8-reveal-fixture', (route) => route.fulfill({
		contentType: 'text/html',
		body: '<!doctype html><html lang="en"><head><title>Reveal</title></head><body><div id="rp8-root"></div></body></html>'
	}));
	await page.goto('/rp8-reveal-fixture');
	await page.addStyleTag({ content: typeof css.source === 'string' ? css.source : Buffer.from(css.source).toString('utf8') });
	await page.addScriptTag({ content: script.code, type: 'module' });
	await expect(page.getByRole('alert')).toHaveCount(0);
	const target = page.locator(`[data-bookmark-jump="${id(20)}"]`);
	await expect(target).toBeAttached();
	for (let i = 0; i < 2; i++) {
		await page.evaluate((id) => window.dispatchEvent(new CustomEvent('rp8-reveal', { detail: id })), id(20));
		await expect(target).toBeFocused();
		await expect(target).toBeInViewport();
		await expect(page.locator(`[data-bookmark-id="${id(20)}"]`)).toHaveClass(/rp8-flash/);
		await expect(page.locator('.rp8-flash')).toHaveCount(0, { timeout: 3000 });
	}
});

for (const theme of ['light', 'dark']) {
	test(`bookmarks are axe clean at mobile width (${theme})`, async ({ page }) => {
		await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
		await setup(page, [saved(1), saved(2, { book_file_id: 32 })], 375);
		await expect(panel(page).locator('[data-bookmark-id]')).toHaveCount(1);
		const scan = async () => (await new AxeBuilder({ page }).include('.pv-sidebar').analyze()).violations;
		expect(await scan()).toEqual([]);
		await entry(page, 1).getByRole('button', { name: /^Rename bookmark:/ }).click();
		expect(await scan()).toEqual([]);
		await panel(page).getByRole('textbox', { name: 'Bookmark label', exact: true }).press('Escape');
		await entry(page, 1).getByRole('button', { name: 'Delete bookmark: Saved 1', exact: true }).click();
		expect(await scan()).toEqual([]);
	});
}

test('page toggle and default labels are localized in Chinese', async ({ page }) => {
	const pushes = await setup(page, [], 1280, 'zh');
	const chinese = page.getByRole('tabpanel', { name: '书签', exact: true });
	await expect(chinese).toContainText('暂无书签。');
	await chinese.getByRole('button', { name: '为此页添加书签', exact: true }).click();
	await expect(chinese.getByRole('button', { name: '移除此页书签', exact: true })).toBeVisible();
	await expect.poll(() => pushes.find((row) => row.entity === 'bookmarks')?.data.label).toBe('第 1 页');
});
