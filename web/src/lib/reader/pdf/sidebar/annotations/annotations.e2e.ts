import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { build } from 'vite';
import { pdfFixture, pngFixture } from '../../../fixtures';

test.use({ serviceWorkers: 'block' });

const id = (n: number) => `0190f5c2-7a00-7000-8000-${String(n).padStart(12, '0')}`;
const rect = { x: 0.1, y: 0.2, width: 0.4, height: 0.05 };
const base = {
	book_id: 21, book_file_id: 31, position: 0,
	created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-02T10:00:00Z', deleted_at: null, rev: 1
};
const fullText = `First English mark 中文 ${'long content '.repeat(25)}ending`;
const initialHighlights = [
	{ ...base, id: id(1), locator: { type: 'pdf', page: 1, rects: [rect] }, text: fullText, style: 'underline', color: '#000000', chapter: null },
	{ ...base, id: id(2), locator: { type: 'pdf', page: 2, rects: [rect] }, position: 1, text: 'Second page strikeout', style: 'strikeout', color: 'pink', chapter: null },
	{ ...base, id: id(3), book_file_id: 32, locator: { type: 'pdf', page: 1 }, text: 'Other file mark', color: 'yellow', chapter: null },
	{ ...base, id: id(4), locator: { type: 'pdf', page: 1, rects: [{ ...rect, y: 0.1 }] }, text: 'Yellow highlight', style: 'highlight', color: 'yellow', chapter: null }
];
const initialNotes = [
	{ ...base, id: id(11), highlight_id: id(1), body_md: 'Original **comment** <img src=x onerror="window.__unsafe=1">' },
	{ ...base, id: id(13), highlight_id: id(1), body_md: 'Second [comment](https://example.org)' },
	{ ...base, id: id(12), highlight_id: null, body_md: 'Book-level note' }
];
const bookmark = { ...base, id: id(21), locator: { type: 'pdf', page: 2 }, position: 1, label: 'Saved position', chapter: null };
const inserts = [
	{ ...base, id: id(31), locator: { type: 'pdf', page: 1, rect: { ...rect, y: 0.4 } }, kind: 'text', data: { text: 'Inserted 中文 text\nSecond line', color: '#112233', size: 0.02 } },
	{ ...base, id: id(32), locator: { type: 'pdf', page: 2, rect }, position: 1, kind: 'ink', data: { color: '#112233', width: 0.01, strokes: [[0.1, 0.2, 0.2, 0.23], [0.2, 0.2, 0.3, 0.24]] } },
	{ ...base, id: id(33), locator: { type: 'pdf', page: 2, rect: { ...rect, y: 0.4 } }, position: 1, kind: 'image', data: { asset: 'b'.repeat(64), media_type: 'image/png', width: 10, height: 10 } },
	{ ...base, id: id(34), book_file_id: 32, locator: { type: 'pdf', page: 1, rect }, kind: 'text', data: { text: 'Other file inserted text', color: '#112233', size: 0.02 } }
];

type Push = { entity: string; id: string; op: string; data: Record<string, unknown> };
async function setup(page: Page, options: { large?: boolean; splitOther?: boolean; failImage?: boolean; width?: number } = {}) {
	await page.setViewportSize({ width: options.width ?? 1280, height: 800 });
	const bytes = pdfFixture();
	const file = { id: 31, format: 'pdf', size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}` };
	const book = {
		id: 21, library_id: 1, title: 'Annotation fixture', sort_title: 'Annotation fixture', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: base.created_at, updated_at: base.updated_at
	};
	const many = Array.from({ length: 600 }, (_, index) => ({
		...base, id: id(1000 + index),
		locator: { type: 'pdf', page: 1, rects: [{ ...rect, y: index / 700 }] },
		text: `Virtual entry ${String(index).padStart(3, '0')}`, color: 'yellow', chapter: null
	}));
	const state = {
		pushes: [] as Push[],
		failImage: options.failImage ?? false,
		cursor: 1,
		highlights: options.large
			? many.map((row, index) => options.splitOther && index >= 300 ? { ...row, book_file_id: 32 } : row)
			: initialHighlights,
		notes: options.large ? [] : initialNotes,
		inserts: options.large ? [] : inserts.map((row) => ({ ...row }))
	};
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: {
			user_book: null, progress: null, highlights: state.highlights, notes: state.notes,
			bookmarks: options.large ? [] : [bookmark], page_annotations: state.inserts
		} });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings: [
			{ key: 'reader.pdf', value: { pdfLayout: 'single', pdfZoom: 'page-fit' }, updated_at: base.updated_at, rev: 1 }
		] } });
		if (path === '/api/v1/sync/pull') {
			const since = Number(new URL(route.request().url()).searchParams.get('cursor') ?? 0);
			return route.fulfill({ json: {
				cursor: state.cursor, user_books: [], reading_progress: [], highlights: [], notes: [], bookmarks: [],
				page_annotations: state.inserts.filter((row) => row.rev > since), user_settings: []
			} });
		}
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON();
			state.pushes.push(...mutations);
			for (const mutation of mutations) {
				if (mutation.entity !== 'page_annotations') continue;
				const index = state.inserts.findIndex((row) => row.id === mutation.id);
				if (index < 0) throw new Error('The fixture only updates existing page annotations.');
				const updatedAt = new Date(mutation.updated_at).toISOString();
				state.inserts[index] = {
					...state.inserts[index], ...(mutation.op === 'upsert' ? mutation.data : {}),
					rev: ++state.cursor, updated_at: updatedAt, deleted_at: mutation.op === 'delete' ? updatedAt : null
				};
			}
			return route.fulfill({ json: { results: mutations.map((_: unknown, index: number) => ({ index, status: 'applied' })) } });
		}
		if (path.includes('/annotation-assets/')) {
			return state.failImage
				? route.fulfill({ status: 404, json: { title: 'Not Found', status: 404 } })
				: route.fulfill({ contentType: 'image/png', body: pngFixture(10, 10, [200, 30, 20]) });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
	await expect(panel(page)).toBeVisible();
	return state;
}

const panel = (page: Page) => page.getByRole('tabpanel', { name: 'Annotations', exact: true });
const entry = (page: Page, n: number) => panel(page).locator(`[data-panel-entry="${id(n)}"]`);
const expand = (page: Page, n: number) => entry(page, n).locator('[data-rp7-expand]');
const detail = (page: Page) => page.locator('dialog.rp7-dialog');

test('shows compact rows for every annotation kind, without categories or bookmarks, and searches all text', async ({ page }) => {
	await setup(page);
	const drawer = panel(page);
	await expect(drawer.getByText('6 annotations')).toBeVisible();
	await expect(drawer.getByRole('group', { name: 'Annotation type' })).toHaveCount(0);
	await expect(drawer.locator('.rp7-content > .rp7-list > [data-panel-entry]')).toHaveCount(6);
	await expect(entry(page, 4).locator('.rp7-swatch')).toHaveClass(/rp7-fill/);
	await expect(entry(page, 4).locator('.rp7-swatch')).toHaveCSS('background-color', 'rgb(250, 204, 21)');
	await expect(entry(page, 1).locator('.rp7-swatch')).toHaveClass(/rp7-line/);
	await expect(entry(page, 1).locator('.rp7-swatch')).toHaveCSS('color', 'rgb(0, 0, 0)');
	await expect(entry(page, 2).locator('.rp7-swatch')).toHaveCSS('color', 'rgb(244, 114, 182)');
	await expect(entry(page, 31)).toContainText('Inserted 中文 text');
	await expect(entry(page, 32)).toContainText('Drawing');
	await expect(entry(page, 33)).toContainText('Image');
	await expect(entry(page, 1).locator('.rp7-comment')).toHaveText('Original comment');
	await expect(entry(page, 1).locator('.rp7-page')).toHaveText('p. 1');
	await expect(entry(page, 1).locator('time')).toHaveAttribute('title', base.created_at);
	expect((await entry(page, 1).boundingBox())?.height).toBe(56);
	await expect(drawer.locator(`[data-panel-entry="${id(21)}"]`)).toHaveCount(0);
	await drawer.getByText('Other files (2)').click();
	await expect(entry(page, 3).locator('[data-panel-jump]')).toBeDisabled();
	await expect(expand(page, 3)).toBeEnabled();
	await expect(entry(page, 34).locator('[data-panel-jump]')).toBeDisabled();
	await expect(entry(page, 34).locator('[data-rp7-delete]')).toHaveCount(0);
	await expand(page, 34).click();
	await expect(detail(page).locator('.rp7-full-text')).toHaveText('Other file inserted text');
	await expect(detail(page).getByRole('button', { name: 'Go to page' })).toHaveCount(0);
	await expect(detail(page).locator('[data-rp7-delete]')).toHaveCount(0);
	await detail(page).getByRole('button', { name: 'Close annotation details' }).click();
	await drawer.getByRole('searchbox').fill('other file inserted');
	await expect(entry(page, 34)).toBeVisible();
	await expect(drawer.getByText('No annotations match your search.')).toHaveCount(0);
	await drawer.getByRole('searchbox').fill('STRIKEOUT');
	await expect(drawer.locator('[data-panel-entry]')).toHaveCount(1);
	await expect(entry(page, 2)).toBeVisible();
	await drawer.getByRole('searchbox').fill('中文');
	await expect(drawer.locator('[data-panel-entry]')).toHaveCount(2);
	await drawer.getByRole('searchbox').fill('Second comment');
	await expect(entry(page, 1)).toBeVisible();
	await drawer.getByRole('searchbox').fill('not found');
	await expect(drawer.getByText('No annotations match your search.')).toBeVisible();
});

test('two-step deletion resets on blur and timeout, announces, and can be undone', async ({ page }) => {
	const state = await setup(page);
	const remove = entry(page, 1).locator('[data-rp7-delete]');
	await remove.click();
	await expect(remove).toHaveText('Delete?');
	await expect(entry(page, 1)).toBeVisible();
	await page.getByRole('searchbox').focus();
	await expect(remove).not.toHaveText('Delete?');
	await remove.click();
	await expect(remove).toHaveText('Delete?');
	await expect(remove).not.toHaveText('Delete?', { timeout: 4500 });
	await remove.click();
	await remove.click();
	await expect(entry(page, 1)).toHaveCount(0);
	await expect(panel(page).getByRole('status')).toContainText('Annotation deleted.');
	await expect.poll(() => state.pushes.some((row) => row.entity === 'highlights' && row.id === id(1) && row.op === 'delete')).toBe(true);
	await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(entry(page, 1).locator('.rp7-comment')).toHaveText('Original comment');

	const deleteInsert = entry(page, 31).locator('[data-rp7-delete]');
	await deleteInsert.click();
	await deleteInsert.click();
	await expect(entry(page, 31)).toHaveCount(0);
	await expect.poll(() => state.pushes.some((row) => row.entity === 'page_annotations' && row.id === id(31) && row.op === 'delete')).toBe(true);
});

test('dialog shows full text and sanitized comments, traps focus, edits and restores focus', async ({ page }) => {
	const state = await setup(page);
	await expand(page, 1).click();
	const dialog = detail(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('heading', { name: 'Underline · p. 1' })).toBeVisible();
	await expect(dialog.locator('blockquote')).toHaveText(fullText);
	await expect(dialog.getByText('Black', { exact: true })).toBeVisible();
	await expect(dialog.locator('[data-note-id]')).toHaveCount(2);
	await expect(dialog.locator('[data-note-id]').first().locator('strong')).toHaveText('comment');
	await expect(dialog.locator('[data-note-id] img')).toHaveCount(0);
	expect(await page.evaluate(() => (window as Window & { __unsafe?: number }).__unsafe)).toBeUndefined();
	await expect(dialog.getByRole('button', { name: 'Close annotation details' })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.getByRole('button', { name: /^Delete / })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog.getByRole('button', { name: 'Close annotation details' })).toBeFocused();

	await dialog.locator(`[data-note-id="${id(11)}"]`).getByRole('button', { name: 'Edit note' }).click();
	await dialog.getByRole('textbox', { name: 'Note in Markdown' }).fill('Edited **中文** comment');
	await dialog.getByRole('button', { name: 'Save note' }).click();
	await expect(dialog.getByText('中文', { exact: true })).toBeVisible();
	await expect(entry(page, 1).locator('.rp7-comment')).toHaveText('Edited 中文 comment');
	await expect.poll(() => state.pushes.some((row) => row.entity === 'notes' && row.data.body_md === 'Edited **中文** comment')).toBe(true);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(expand(page, 1)).toBeFocused();

	await expand(page, 2).click();
	await detail(page).getByRole('button', { name: 'Add comment' }).click();
	await detail(page).getByRole('textbox', { name: 'Note in Markdown' }).fill('New **comment**');
	await detail(page).getByRole('button', { name: 'Save note' }).click();
	await expect(entry(page, 2).locator('.rp7-comment')).toHaveText('New comment');
	await detail(page).getByRole('button', { name: 'Close annotation details' }).click();
	await expect(expand(page, 2)).toBeFocused();
});

test('closing a dialog protects an unsaved comment draft', async ({ page }) => {
	await setup(page);
	await expand(page, 1).click();
	await detail(page).getByRole('button', { name: 'Add comment' }).click();
	await detail(page).getByRole('textbox', { name: 'Note in Markdown' }).fill('Unfinished comment');
	page.removeAllListeners('dialog');
	page.on('dialog', (dialog) => dialog.dismiss());
	await page.keyboard.press('Escape');
	await expect(detail(page)).toBeVisible();
	await expect(detail(page).getByRole('textbox', { name: 'Note in Markdown' })).toContainText('Unfinished comment');
	page.removeAllListeners('dialog');
	page.on('dialog', (dialog) => dialog.accept());
	await page.keyboard.press('Escape');
	await expect(detail(page)).toHaveCount(0);
	await expect(expand(page, 1)).toBeFocused();
});

test('dialog previews text, ink and image, and retries an unavailable image', async ({ page }) => {
	const state = await setup(page, { failImage: true });
	await expand(page, 31).click();
	await expect(detail(page).locator('.rp7-full-text')).toHaveText('Inserted 中文 text\nSecond line');
	await detail(page).getByRole('button', { name: 'Close annotation details' }).click();
	await expand(page, 32).click();
	await expect(detail(page).getByRole('img', { name: 'Drawing' })).toHaveAttribute('viewBox', '0.1 0.2 0.4 0.05');
	await expect(detail(page).locator('svg.rp7-ink-preview path')).toHaveCount(2);
	await expect(detail(page).locator('svg.rp7-ink-preview path').first()).toHaveAttribute('stroke', '#112233');
	await expect(detail(page).locator('svg.rp7-ink-preview path').first()).toHaveAttribute('stroke-width', '0.01');
	await detail(page).getByRole('button', { name: 'Close annotation details' }).click();
	await page.context().setOffline(true);
	await expand(page, 33).click();
	await expect(detail(page).getByRole('alert')).toContainText('Image unavailable');
	state.failImage = false;
	await page.context().setOffline(false);
	await detail(page).getByRole('button', { name: 'Retry image' }).click();
	await expect(detail(page).getByRole('img', { name: 'Annotation image' })).toBeVisible();
	expect(await detail(page).getByRole('img', { name: 'Annotation image' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(10);
});

test('dialog delete is two-step; jumping closes the dialog and collapses an overlay', async ({ page }) => {
	const state = await setup(page, { width: 800 });
	await expand(page, 31).click();
	const remove = detail(page).locator('[data-rp7-delete]');
	await remove.click();
	await expect(remove).toHaveText('Delete?');
	await expect(detail(page)).toBeVisible();
	await remove.click();
	await expect(detail(page)).toHaveCount(0);
	await expect(entry(page, 31)).toHaveCount(0);
	await expect.poll(() => state.pushes.some((row) => row.entity === 'page_annotations' && row.id === id(31) && row.op === 'delete')).toBe(true);

	await expand(page, 2).click();
	await detail(page).getByRole('button', { name: 'Go to page' }).click();
	await expect(detail(page)).toHaveCount(0);
	await expect(panel(page)).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Page 2 of 2', exact: true })).toHaveValue('2');
	await expect(page.locator(`[data-panel-flash="${id(2)}"]`)).toBeVisible();
	await expect(page.locator('[data-panel-flash]')).toHaveCount(0, { timeout: 3000 });
});

test('a failed delete keeps the dialog open, restores the entry, and reports the error inside the dialog', async ({ page }) => {
	await setup(page);
	await expand(page, 31).click();
	await page.evaluate(() => {
		const add = IDBObjectStore.prototype.add;
		IDBObjectStore.prototype.add = function (value, key) {
			if (this.name === 'outbox') throw new DOMException('Simulated storage failure', 'QuotaExceededError');
			return key === undefined ? add.call(this, value) : add.call(this, value, key);
		};
	});
	const remove = detail(page).locator('[data-rp7-delete]');
	await remove.click();
	await remove.click();
	await expect(detail(page)).toBeVisible();
	await expect(detail(page).getByRole('alert')).toContainText('A change could not be saved.');
	await expect(remove).toBeEnabled();
	await detail(page).getByRole('button', { name: 'Close annotation details' }).click();
	await expect(entry(page, 31)).toBeVisible();
});

test('revealing a comment marker clears a hiding search, focuses and flashes its entry', async ({ page }) => {
	await setup(page);
	await panel(page).getByRole('searchbox').fill('not present');
	await expect(entry(page, 1)).toHaveCount(0);
	await page.locator(`.pv-mark-comment[data-annotation-id="${id(1)}"]`).click();
	await expect(panel(page).getByRole('searchbox')).toHaveValue('');
	await expect(entry(page, 1).locator('[data-panel-jump]')).toBeFocused();
	await expect(entry(page, 1)).toHaveClass(/rp7-entry-flash/);
});

test('note and insert targets clear a hiding search and reveal their entries, including other files', async ({ page }) => {
	test.setTimeout(90_000);
	const result = await build({
		configFile: false,
		plugins: [
			svelte(),
			{
				name: 'annotations-fixture-navigation',
				resolveId: (source) => source === '$app/navigation' ? '\0rp7-navigation' : null,
				load: (id) => id === '\0rp7-navigation'
					? 'export function goto() { throw new Error("Unexpected navigation in reveal fixture"); }' : null
			}
		],
		resolve: { alias: [{ find: '#lib', replacement: resolve('src/lib') }] },
		build: {
			target: 'esnext', write: false,
			lib: { entry: resolve('src/lib/reader/pdf/sidebar/annotations/annotations-fixture.ts'), formats: ['es'] },
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
	await setup(page);
	await page.route('**/rp7-reveal-fixture', (route) => route.fulfill({
		contentType: 'text/html',
		body: '<!doctype html><html lang="en"><head><title>Reveal</title></head><body><div id="rp7-root"></div></body></html>'
	}));
	await page.goto('/rp7-reveal-fixture');
	await page.addStyleTag({ content: typeof css.source === 'string' ? css.source : Buffer.from(css.source).toString('utf8') });
	await page.addScriptTag({ content: script.code, type: 'module' });
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(panel(page).getByText('6 annotations')).toBeVisible();
	const cases = [
		{ kind: 'note', id: id(11), target: 1, selector: '[data-panel-jump]' },
		{ kind: 'insert', id: id(31), target: 31, selector: '[data-panel-jump]' },
		{ kind: 'insert', id: id(34), target: 34, selector: '[data-rp7-expand]' }
	];
	for (const item of cases) {
		await panel(page).getByRole('searchbox').fill('hides this entry');
		await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('rp7-reveal', { detail })), item);
		await expect(panel(page).getByRole('searchbox')).toHaveValue('');
		await expect(entry(page, item.target).locator(item.selector)).toBeFocused();
		await expect(entry(page, item.target)).toHaveClass(/rp7-entry-flash/);
	}
	await page.evaluate((id) => window.dispatchEvent(new CustomEvent('rp7-reveal', {
		detail: { kind: 'note', id }
	})), id(12));
	const bookNote = panel(page).locator(`[data-note-id="${id(12)}"]`);
	await expect(bookNote.getByRole('button', { name: 'Edit note' })).toBeFocused();
	await expect(bookNote).toHaveClass(/rp7-note-flash/);
});

test('a reduced-motion page jump uses a static outline and collapses the overlay', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await setup(page, { width: 800 });
	await entry(page, 31).locator('[data-panel-jump]').click();
	await expect(panel(page)).toHaveCount(0);
	const flash = page.locator(`[data-panel-flash="${id(31)}"]`);
	await expect(flash).toBeVisible();
	await expect(flash).toHaveCSS('animation-name', 'none');
	await expect(flash).toHaveCSS('outline-style', 'solid');
	await expect(flash).toHaveCount(0, { timeout: 3000 });
});

test('deleting an insert offline queues the mutation and syncs it after reconnecting', async ({ page, context }) => {
	const state = await setup(page);
	await context.setOffline(true);
	const remove = entry(page, 31).locator('[data-rp7-delete]');
	await remove.click();
	await remove.click();
	await expect(entry(page, 31)).toHaveCount(0);
	await expect(panel(page).getByRole('status')).toContainText('Annotation deleted.');
	await expect.poll(() => page.evaluate((annotationId) => new Promise<boolean>((resolve, reject) => {
		const request = indexedDB.open('pandalibrary-offline');
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const database = request.result;
			const transaction = database.transaction('outbox');
			const all = transaction.objectStore('outbox').getAll();
			transaction.oncomplete = () => {
				database.close();
				resolve(all.result.some((row) => row.status === 'pending' &&
					row.mutation.entity === 'page_annotations' && row.mutation.id === annotationId &&
					row.mutation.op === 'delete'));
			};
			transaction.onabort = () => { database.close(); reject(transaction.error); };
		};
	}), id(31))).toBe(true);
	await context.setOffline(false);
	await expect.poll(() => state.pushes.some((row) =>
		row.entity === 'page_annotations' && row.id === id(31) && row.op === 'delete')).toBe(true);
});

test('a 600-entry list stays windowed while scrolling and keyboarding', async ({ page }) => {
	await setup(page, { large: true });
	await expect(panel(page).getByText('600 annotations')).toBeVisible();
	const rows = panel(page).locator('[data-panel-entry]');
	expect(await rows.count()).toBeLessThanOrEqual(80);
	const scroller = panel(page).locator('.rp7-content');
	await scroller.evaluate((element) => { element.scrollTop = 300 * 56; });
	await expect(entry(page, 1300)).toBeVisible();
	expect(await rows.count()).toBeLessThanOrEqual(80);
	const lastVisible = rows.last();
	const lastId = await lastVisible.getAttribute('data-panel-entry');
	if (!lastId) throw new Error('Missing virtualized entry id');
	await lastVisible.locator('[data-rp7-expand]').focus();
	await page.keyboard.press('Tab');
	await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-panel-entry]')?.getAttribute('data-panel-entry'))).not.toBe(lastId);
	await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect(entry(page, 1599)).toBeVisible();
	expect(await rows.count()).toBeLessThanOrEqual(80);
});

test('both current-file and other-file lists stay bounded when there are 600 results', async ({ page }) => {
	await setup(page, { large: true, splitOther: true });
	await expect(panel(page).getByText('300 annotations')).toBeVisible();
	const rows = panel(page).locator('[data-panel-entry]');
	expect(await rows.count()).toBeLessThanOrEqual(80);
	await panel(page).getByText('Other files (300)').click();
	const scroller = panel(page).locator('.rp7-content');
	await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect(entry(page, 1599)).toBeVisible();
	expect(await rows.count()).toBeLessThanOrEqual(80);
	await expect(entry(page, 1599).locator('[data-panel-jump]')).toBeDisabled();
});

test('book notes retain their draft guard and undo behavior', async ({ page }) => {
	await setup(page);
	const notes = panel(page).getByRole('region', { name: 'Book notes' });
	await notes.getByRole('button', { name: 'Add book note' }).click();
	await notes.getByRole('textbox', { name: 'Note in Markdown' }).fill('Unsaved draft');
	page.removeAllListeners('dialog');
	page.on('dialog', (dialog) => dialog.dismiss());
	await panel(page).getByRole('button', { name: 'Collapse sidebar' }).click();
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
	await expect(notes.getByRole('textbox', { name: 'Note in Markdown' })).toContainText('Unsaved draft');
	await page.getByRole('tab', { name: 'Contents', exact: true }).click();
	await expect(panel(page)).toBeVisible();
	page.removeAllListeners('dialog');
	page.on('dialog', (dialog) => dialog.accept());
	await notes.getByRole('button', { name: 'Save note' }).click();
	const saved = notes.locator('[data-note-id]').filter({ hasText: 'Unsaved draft' });
	await saved.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(saved).toHaveCount(0);
	await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(saved).toBeVisible();
});

for (const theme of ['light', 'dark']) {
	test(`sidebar and dialog are axe clean in ${theme} mode`, async ({ page }) => {
		await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
		await setup(page);
		expect((await new AxeBuilder({ page }).include('.pv-sidebar').analyze()).violations).toEqual([]);
		await expand(page, 1).click();
		expect((await new AxeBuilder({ page }).include('dialog.rp7-dialog').analyze()).violations).toEqual([]);
	});
}
