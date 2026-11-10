import { expect, test, type Page } from '@playwright/test';
import { pdfFixture } from '../../fixtures';

test.use({ serviceWorkers: 'block' });

const id = (n: number) => `0190f5c2-7a00-7000-8000-${String(n).padStart(12, '0')}`;
const rect = { x: 0.1, y: 0.2, width: 0.4, height: 0.05 };
const base = {
	book_id: 21, book_file_id: 31, position: 0,
	created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z', deleted_at: null, rev: 1
};
const highlights = [
	{ ...base, id: id(1), locator: { type: 'pdf', page: 1, rects: [rect] }, text: 'First English mark 中文', style: 'underline', color: 'green', chapter: null },
	{ ...base, id: id(2), locator: { type: 'pdf', page: 2, rects: [rect] }, position: 1, text: 'Second page strikeout', style: 'strikeout', color: 'pink', chapter: null },
	{ ...base, id: id(3), book_file_id: 32, locator: { type: 'pdf', page: 1 }, text: 'Other file mark', color: 'yellow', chapter: null }
];
const notes = [
	{ ...base, id: id(11), highlight_id: id(1), body_md: 'Original **comment**' },
	{ ...base, id: id(12), highlight_id: null, body_md: 'Book-level note' }
];
const bookmark = { ...base, id: id(21), locator: { type: 'pdf', page: 2 }, position: 1, label: 'Saved position', chapter: null };
const inserts = [
	{ ...base, id: id(31), locator: { type: 'pdf', page: 1, rect }, kind: 'text', data: { text: 'Inserted 中文 text', color: '#112233', size: 0.02 } },
	{ ...base, id: id(32), locator: { type: 'pdf', page: 2, rect }, position: 1, kind: 'ink', data: { color: '#112233', width: 0.01, strokes: [[0, 0, 0.2, 0.2]] } },
	{ ...base, id: id(33), locator: { type: 'pdf', page: 2, rect }, position: 1, kind: 'image', data: { asset: 'b'.repeat(64), media_type: 'image/png', width: 100, height: 100 } }
];

async function setup(page: Page) {
	const bytes = pdfFixture();
	const file = { id: 31, format: 'pdf', size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}` };
	const book = {
		id: 21, library_id: 1, title: 'Panel fixture', sort_title: 'Panel fixture', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: base.created_at, updated_at: base.updated_at
	};
	const pushes: { entity: string; id: string; op: string; data: Record<string, unknown> }[] = [];
	const serverPages: Record<string, unknown>[] = inserts.map((row) => ({ ...row }));
	let cursor = 1;
	let fail = false;
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: { user_book: null, progress: null, highlights, notes, bookmarks: [bookmark], page_annotations: serverPages } });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings: [
			{ key: 'reader.pdf', value: { pdfLayout: 'single', pdfZoom: 'page-fit' }, updated_at: base.updated_at, rev: 1 }
		] } });
		if (path === '/api/v1/sync/pull') {
			const since = Number(new URL(route.request().url()).searchParams.get('cursor') ?? 0);
			return route.fulfill({ json: {
				cursor, user_books: [], reading_progress: [], highlights: [], notes: [], bookmarks: [],
				page_annotations: serverPages.filter((row) => typeof row.rev === 'number' && row.rev > since), user_settings: []
			} });
		}
		if (path === '/api/v1/sync/push') {
			if (fail) return route.fulfill({ status: 503, json: { status: 503, title: 'Unavailable' } });
			const { mutations } = route.request().postDataJSON();
			pushes.push(...mutations);
			for (const mutation of mutations) {
				if (mutation.entity !== 'page_annotations') continue;
				const index = serverPages.findIndex((row) => row.id === mutation.id);
				if (index < 0) throw new Error('The fixture only updates existing page annotations.');
				const updatedAt = new Date(mutation.updated_at).toISOString();
				serverPages[index] = {
					...serverPages[index], ...(mutation.op === 'upsert' ? mutation.data : {}),
					rev: ++cursor, updated_at: updatedAt, deleted_at: mutation.op === 'delete' ? updatedAt : null
				};
			}
			return route.fulfill({ json: { results: mutations.map((_: unknown, index: number) => ({ index, status: 'applied' })) } });
		}
		if (path.includes('/annotation-assets/')) return route.fulfill({ status: 404, json: { title: 'Not Found', status: 404 } });
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
	await expect(panel(page)).toBeVisible();
	return { pushes, failPushes: () => { fail = true; } };
}
const panel = (page: Page) => page.getByRole('tabpanel', { name: 'Annotations', exact: true });
const entry = (page: Page, n: number) => panel(page).locator(`[data-panel-entry="${id(n)}"]`);

test('groups every annotation type by page and searches English and Chinese', async ({ page }) => {
	await setup(page);
	const drawer = panel(page);
	await expect(drawer.getByRole('heading', { name: 'Annotations', exact: true })).toBeVisible();
	await expect(drawer.getByRole('heading', { name: 'Page 1', exact: true })).toBeVisible();
	await expect(drawer.getByRole('heading', { name: 'Page 2', exact: true })).toBeVisible();
	await expect(drawer.locator('[data-panel-entry]')).toHaveCount(7);
	await drawer.getByText('Another file (1)').click();
	await expect(entry(page, 3).locator('button').first()).toBeDisabled();
	await drawer.getByRole('searchbox').fill('STRIKEOUT');
	await expect(drawer.locator('[data-panel-entry]')).toHaveCount(1);
	await expect(entry(page, 2)).toBeVisible();
	await drawer.getByRole('searchbox').fill('中文');
	await expect(drawer.locator('[data-panel-entry]')).toHaveCount(2);
	await expect(entry(page, 31)).toBeVisible();
});

test('jump navigates, flashes the item and Escape restores focus without a focus trap', async ({ page }) => {
	await setup(page);
	await entry(page, 2).locator('[data-panel-jump]').click();
	await expect(page.getByRole('textbox', { name: 'Page 2 of 2', exact: true })).toHaveValue('2');
	await expect(page.locator(`[data-panel-flash="${id(2)}"]`)).toBeVisible();
	await expect(page.locator('[data-panel-flash]')).toHaveCount(0, { timeout: 3000 });
	await entry(page, 1).locator('[data-panel-jump]').focus();
	await page.keyboard.press('Tab');
	await expect(entry(page, 1).getByRole('button', { name: 'Delete Underline', exact: true })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(entry(page, 1).locator('[data-panel-jump]')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(panel(page)).toHaveCount(0);
	await expect(page.getByRole('tab', { name: 'Annotations', exact: true })).toBeFocused();
});

test('edits comments, bookmarks and inserted text, and deletes and restores a mark with its comment', async ({ page }) => {
	const { pushes } = await setup(page);
	await entry(page, 1).getByRole('button', { name: 'Edit note', exact: true }).click();
	const editor = entry(page, 1).getByRole('textbox', { name: 'Note in Markdown', exact: true });
	await editor.fill('Edited 中文 comment');
	await entry(page, 1).getByRole('button', { name: 'Save note' }).click();
	await expect(entry(page, 1)).toContainText('Edited 中文 comment');
	await expect.poll(() => pushes.some((row) => row.entity === 'notes' && row.data.body_md === 'Edited 中文 comment')).toBe(true);
	await entry(page, 21).getByRole('button', { name: 'Edit Bookmarks' }).click();
	await entry(page, 21).getByRole('textbox').fill('Renamed bookmark');
	await entry(page, 21).getByRole('button', { name: 'Save', exact: true }).click();
	await expect(entry(page, 21)).toContainText('Renamed bookmark');
	await expect.poll(() => pushes.some((row) => row.entity === 'bookmarks' && row.data.label === 'Renamed bookmark')).toBe(true);
	await entry(page, 31).getByRole('button', { name: 'Edit Inserted text' }).click();
	await entry(page, 31).getByRole('textbox').fill('Edited inserted text');
	await entry(page, 31).getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => pushes.some((row) => row.entity === 'page_annotations' && JSON.stringify(row.data).includes('Edited inserted text'))).toBe(true);
	await entry(page, 1).getByRole('button', { name: 'Delete Underline' }).click();
	await expect(entry(page, 1)).toHaveCount(0);
	await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(entry(page, 1)).toContainText('Edited 中文 comment');
	await expect.poll(() => pushes.filter((row) => row.entity === 'highlights' && row.id === id(1)).map((row) => row.op)).toEqual(['delete', 'upsert']);
});

test('book notes can be added, edited, deleted and restored, and offline deletions stay in the outbox', async ({ page }) => {
	const { pushes, failPushes } = await setup(page);
	const bookNotes = panel(page).getByRole('region', { name: 'Book notes' });
	await bookNotes.getByRole('button', { name: 'Add book note' }).click();
	await bookNotes.getByRole('textbox', { name: 'Note in Markdown' }).fill('New book note');
	await bookNotes.getByRole('button', { name: 'Save note' }).click();
	await expect.poll(() => pushes.some((row) => row.entity === 'notes' && row.data.body_md === 'New book note')).toBe(true);
	const saved = bookNotes.locator('[data-note-id]').filter({ hasText: 'New book note' });
	await saved.getByRole('button', { name: 'Edit note' }).click();
	await bookNotes.getByRole('textbox', { name: 'Note in Markdown' }).fill('Updated book note');
	await bookNotes.getByRole('button', { name: 'Save note' }).click();
	await expect(saved).toHaveCount(0);
	const updated = bookNotes.locator('[data-note-id]').filter({ hasText: 'Updated book note' });
	await updated.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(updated).toHaveCount(0);
	await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(updated).toBeVisible();
	failPushes();
	await page.context().setOffline(true);
	await entry(page, 32).getByRole('button', { name: 'Delete Drawing' }).click();
	await expect(entry(page, 32)).toHaveCount(0);
	await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(entry(page, 32)).toBeVisible();
	const queued = await page.evaluate(async () => {
		const request = indexedDB.open('pandalibrary-offline');
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const tx = db.transaction('outbox', 'readonly');
			const rows = tx.objectStore('outbox').getAll();
			return await new Promise<unknown[]>((resolve, reject) => {
				rows.onsuccess = () => resolve(rows.result);
				rows.onerror = () => reject(rows.error);
			});
		} finally { db.close(); }
	});
	expect(JSON.stringify(queued)).toContain(id(32));
});

test('collapsing keeps unsaved notes; switching tabs and navigation are guarded', async ({ page }) => {
	await setup(page);
	const bookNotes = panel(page).getByRole('region', { name: 'Book notes' });
	await bookNotes.getByRole('button', { name: 'Add book note' }).click();
	await bookNotes.getByRole('textbox', { name: 'Note in Markdown' }).fill('Unsaved draft');
	page.removeAllListeners('dialog');
	page.on('dialog', (dialog) => dialog.dismiss());
	await panel(page).getByRole('button', { name: 'Collapse sidebar' }).click();
	await expect(panel(page)).toHaveCount(0);
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
	await expect(bookNotes.getByRole('textbox', { name: 'Note in Markdown' })).toContainText('Unsaved draft');
	await page.getByRole('tab', { name: 'Contents', exact: true }).click();
	await expect(panel(page)).toBeVisible();
	await page.getByRole('button', { name: 'Close reader', exact: true }).click();
	await expect(page).toHaveURL('/read/21/31');
	await expect(bookNotes.getByRole('textbox', { name: 'Note in Markdown' })).toContainText('Unsaved draft');
	page.removeAllListeners('dialog');
	page.on('dialog', (dialog) => dialog.accept());
	await page.getByRole('tab', { name: 'Contents', exact: true }).click();
	await expect(panel(page)).toHaveCount(0);
	await expect(page.getByRole('tabpanel', { name: 'Contents', exact: true })).toBeVisible();
});
for (const width of [1440, 360]) {
	for (const theme of ['light', 'dark']) {
		test(`${theme} panel layout at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
			await setup(page);
			await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
			const bounds = await panel(page).boundingBox();
			expect(bounds?.width).toBe(width < 640 ? width - 44 : 300);
			expect(bounds?.x).toBe(44);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
			await page.screenshot({ path: test.info().outputPath(`panel-${theme}-${width}.png`) });
		});
	}
}
