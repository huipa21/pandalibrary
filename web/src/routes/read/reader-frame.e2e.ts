import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { epubFixture, pdfFixture } from '../../lib/reader/fixtures';

async function setup(page: Page, format = 'pdf', locale = 'en') {
	const bytes = format === 'pdf' ? pdfFixture() : epubFixture();
	const file = { id: 31, format, size_bytes: bytes.length, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}` };
	const book = {
		id: 21, library_id: 1, title: 'Frame fixture', sort_title: 'Frame fixture', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
	};
	const pushes: Array<{ entity: string; data: { book_file_id?: number } }> = [];
	const bookmarks: Record<string, unknown>[] = [];
	let fail = false;
	let rejection: string | null = null;
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: { user_book: null, progress: null, highlights: [], notes: [], bookmarks } });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings: [
			{ key: 'reader.pdf', value: { pdfLayout: 'single', pdfZoom: 'page-width' }, updated_at: '2026-11-03T00:00:00Z', rev: 1 }
		] } });
		if (path === '/api/v1/sync/pull') return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], bookmarks: [], user_settings: [] } });
		if (path === '/api/v1/sync/push') {
			if (fail) return route.fulfill({ status: 503, json: { status: 503, title: 'Unavailable' } });
			const { mutations } = route.request().postDataJSON();
			pushes.push(...mutations);
			return route.fulfill({ json: { results: mutations.map((mutation: { entity: string }, index: number) =>
				rejection && mutation.entity === 'bookmarks'
					? { index, status: 'rejected', reason: rejection }
					: { index, status: 'applied' }
			) } });
		}
		if (path.endsWith('/reading-summary')) return route.fulfill({ json: { reading_summary: { total_active_seconds: 0, session_count: 0, first_read_at: null, last_read_at: null } } });
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	return {
		pushes, bookmarks,
		failPushes: (value: boolean) => { fail = value; },
		rejectBookmarks: (reason: string) => { rejection = reason; }
	};
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 360, height: 740 }]) {
	for (const format of ['pdf', 'epub']) {
	test(`${format.toUpperCase()} owns the viewport at ${viewport.width}px and X saves before closing`, async ({ page }) => {
		await page.setViewportSize(viewport);
		const state = await setup(page, format);
		await page.goto('/read/21/31');
		if (format === 'pdf') await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
		else await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
		await expect(page.locator('.shell-header-band')).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Back to book details' })).toHaveCount(0);
		await expect(page).toHaveTitle('Frame fixture · PandaLibrary');
		const surface = page.locator('#reader-surface');
		const bounds = await surface.boundingBox();
		if (!bounds) throw new Error('The reader surface is missing.');
		expect(bounds.y).toBeLessThanOrEqual(48);
		expect(bounds.height).toBeGreaterThanOrEqual(viewport.height - (format === 'pdf' ? 48 : 84));
		expect(await page.evaluate(() => ({
			height: document.documentElement.scrollHeight,
			width: document.documentElement.scrollWidth
		}))).toEqual({ height: viewport.height, width: viewport.width });
		const close = page.getByRole('button', { name: 'Close reader', exact: true });
		await expect(close).toHaveCSS('border-top-width', '0px');
		await expect(close).toHaveCSS('width', '36px');
		await expect(close).toHaveAttribute('title', 'Close reader');
		await close.click();
		await expect(page).toHaveURL('/books/21');
		await expect(page.locator('.shell-header-band')).toBeVisible();
		const progress = state.pushes.filter((mutation) => mutation.entity === 'reading_progress');
		if (format === 'pdf') expect(progress).toHaveLength(1);
		else expect(progress.length).toBeGreaterThan(0);
		expect(state.pushes.find((mutation) => mutation.entity === 'reading_progress')?.data.book_file_id).toBe(31);
	});
	}
}

for (const width of [1440, 360]) {
	test(`EPUB contents, bookmarks and responsive sidebar work at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 });
		const state = await setup(page, 'epub');
		await page.goto('/read/21/31');
		await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
		const surface = page.locator('#reader-surface');
		const originalX = (await surface.boundingBox())?.x;
		await page.getByRole('tab', { name: 'Contents', exact: true }).click();
		const contents = page.getByRole('tabpanel', { name: 'Contents', exact: true });
		await expect(contents).toBeVisible();
		expect((await surface.boundingBox())?.x).toBe(originalX! + (width >= 1024 ? 300 : 0));
		await contents.getByRole('button', { name: 'Second', exact: true }).click();
		await expect.poll(() => page.frames().some((frame) => frame.url().startsWith('blob:'))).toBe(true);
		await expect(async () => {
			const frames = page.frames().filter((frame) => frame.url().startsWith('blob:'));
			expect((await Promise.all(frames.map((frame) => frame.getByText('Second section', { exact: true }).isVisible()))).some(Boolean)).toBe(true);
		}).toPass();
		if (width < 1024) await expect(contents).toHaveCount(0);
		else await page.getByRole('button', { name: 'Collapse sidebar' }).click();
		const toggle = page.getByTestId('reflow-bookmark-toggle');
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('tab', { name: 'Bookmarks', exact: true }).click();
		const bookmarks = page.getByRole('tabpanel', { name: 'Bookmarks', exact: true });
		await expect(bookmarks.getByRole('button', { name: 'Save position', exact: true })).toHaveCount(0);
		await expect(bookmarks.getByRole('combobox', { name: 'Jump to bookmark' })).toHaveCount(0);
		const row = bookmarks.locator('[data-bookmark-id]');
		await expect(row).toHaveCount(1);
		await expect(row.locator('[data-bookmark-label]')).toHaveText('Second section');
		await row.getByRole('button', { name: 'Edit', exact: true }).click();
		await bookmarks.getByRole('textbox', { name: /^Label/ }).fill('Chapter two');
		await bookmarks.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(row.locator('[data-bookmark-label]')).toHaveText('Chapter two');
		await expect.poll(() => state.pushes.some((mutation) => mutation.entity === 'bookmarks')).toBe(true);
		await bookmarks.focus();
		await page.keyboard.press('Escape');
		await expect(bookmarks).toHaveCount(0);
		await expect(page.getByRole('tab', { name: 'Bookmarks', exact: true })).toBeFocused();
	});
}

for (const theme of ['light', 'dark']) {
	test(`EPUB shared chrome and sidebar are accessible in ${theme} mode`, async ({ page }) => {
		await page.addInitScript((value) => localStorage.setItem('pandalibrary.theme', value), theme);
		await setup(page, 'epub');
		await page.goto('/read/21/31');
		await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
		for (const name of ['Contents', 'Annotations', 'Bookmarks']) {
			await page.getByRole('tab', { name, exact: true }).click();
			await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
			const result = await new AxeBuilder({ page }).include('.pv-frame-toolbar').include('.pv-sidebar').analyze();
			expect(result.violations).toEqual([]);
		}
	});
}

test('pending writes appear in the status dot and can be retried', async ({ page }) => {
	const state = await setup(page);
	state.failPushes(true);
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	const status = page.getByRole('button', { name: 'Reader sync status' });
	await expect(status).toBeVisible();
	await status.click();
	await expect(page.locator('#reader-sync-status')).toContainText(/waiting to sync|failed/i);
	await page.keyboard.press('Escape');
	await expect(page.locator('#reader-sync-status')).toHaveCount(0);
	await expect(status).toBeFocused();
	const retry = page.getByRole('button', { name: 'Retry unsaved changes' });
	await expect(retry).toBeVisible();
	state.failPushes(false);
	await retry.click();
	await expect.poll(() => state.pushes.filter((mutation) => mutation.entity === 'reading_progress').length).toBe(1);
});

for (const width of [1440, 360]) {
	test(`EPUB queued bookmark diagnostics and retry never cover content or sidebar at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 });
		const state = await setup(page, 'epub');
		await page.goto('/read/21/31');
		await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
		state.failPushes(true);
		const toggle = page.getByTestId('reflow-bookmark-toggle');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		const notifications = page.locator('.reader-notifications');
		await expect(notifications).toContainText('Bookmark change saved on this device and waiting to sync.');
		await expect(notifications.getByRole('alert')).toContainText('Sync failed. Your queued changes remain on this device.');
		await expect(notifications.getByRole('alert')).toContainText('HTTP 503');
		await page.getByRole('tab', { name: 'Bookmarks', exact: true }).click();
		await expect(page.locator('[data-bookmark-id]')).toHaveCount(1);
		const footer = await notifications.boundingBox();
		const surface = await page.locator('#reader-surface').boundingBox();
		const sidebar = await page.getByRole('tabpanel', { name: 'Bookmarks', exact: true }).boundingBox();
		if (!footer || !surface || !sidebar) throw new Error('Reader layout is missing.');
		expect(surface.y + surface.height).toBeLessThanOrEqual(footer.y + 1);
		expect(sidebar.y + sidebar.height).toBeLessThanOrEqual(footer.y + 1);
		expect(footer.height).toBeLessThanOrEqual(200);
		expect(footer.x).toBeGreaterThanOrEqual(0);
		expect(footer.x + footer.width).toBeLessThanOrEqual(width);

		const status = page.getByRole('button', { name: 'Reader sync status' });
		await status.click();
		const panel = page.locator('#reader-sync-status');
		await expect(panel).toContainText('HTTP 503');
		const panelBounds = await panel.boundingBox();
		if (!panelBounds) throw new Error('Sync diagnostics are missing.');
		expect(panelBounds.x).toBeGreaterThanOrEqual(0);
		expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(width);
		await page.keyboard.press('Escape');
		await expect(status).toBeFocused();
		state.failPushes(false);
		await notifications.getByRole('button', { name: 'Retry unsaved changes' }).click();
		await expect(notifications.getByRole('alert')).toHaveCount(0);
		await expect(notifications).toContainText('Bookmark saved.');
		await expect(notifications).not.toContainText('waiting to sync');
		expect(state.pushes.filter((mutation) => mutation.entity === 'bookmarks')).toHaveLength(1);
	});
}

test('EPUB bookmark rejection remains an accessible error instead of a queued success', async ({ page }) => {
	const state = await setup(page, 'epub');
	await page.goto('/read/21/31');
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
	state.rejectBookmarks('bookmark book is unavailable');
	const toggle = page.getByTestId('reflow-bookmark-toggle');
	await toggle.click();
	await expect(page.locator('.reader-notifications').getByRole('alert')).toContainText('A change could not be saved.');
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(page.locator('.reader-notifications')).not.toContainText('Bookmark saved.');
	await page.getByRole('button', { name: 'Reader sync status' }).click();
	await expect(page.locator('#reader-sync-status')).toContainText('Some changes were rejected or conflicted.');
	await expect(page.locator('#reader-sync-status').getByRole('link', { name: 'Review changes' })).toBeVisible();
});

test('PDF keyboard navigation updates page and two-decimal progress', async ({ page }) => {
	await setup(page);
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.locator('.reader-pdf-text')).toContainText('Second PDF page text');
	await expect(page.locator('.pv-frame-toolbar')).toContainText('100.00%');
	await page.keyboard.press('ArrowLeft');
	await expect(page.locator('.pv-frame-toolbar')).toContainText('0.00%');
});

test('PDF navigation failures restore the normal shell', async ({ page }) => {
	await setup(page);
	await page.route('**/api/v1/books/21/files/31?*', (route) => route.fulfill({ body: 'not a PDF' }));
	await page.goto('/read/21/31');
	await expect(page.getByRole('alert')).toBeVisible();
	await expect(page.locator('.shell-header-band')).toBeVisible();
});

test('Chinese PDF chrome is localized', async ({ page }) => {
	await setup(page, 'pdf', 'zh');
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	await expect(page.getByRole('button', { name: '关闭阅读器' })).toBeVisible();
	await expect(page.locator('.pv-frame-toolbar')).toContainText('0.00%');
});

test('a failed close stays in the frame and can retry before leaving', async ({ page }) => {
	const state = await setup(page);
	state.failPushes(true);
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	await page.getByRole('button', { name: 'Close reader', exact: true }).click();
	await expect(page).toHaveURL('/read/21/31');
	await expect(page.getByRole('link', { name: 'Leave without saving' })).toBeVisible();
	await expect(page.locator('.shell-header-band')).toHaveCount(0);
	state.failPushes(false);
	await page.getByRole('button', { name: 'Retry unsaved changes' }).click();
	await expect.poll(() => state.pushes.filter((mutation) => mutation.entity === 'reading_progress').length).toBe(1);
	await page.getByRole('button', { name: 'Close reader', exact: true }).click();
	await expect(page).toHaveURL('/books/21');
});

test('PDF saved-bookmark links restore their page without the legacy bookmark UI', async ({ page }) => {
	const state = await setup(page);
	state.bookmarks.push({
		id: 'saved-page', book_id: 21, book_file_id: 31, locator: { type: 'pdf', page: 2 },
		position: 1, label: 'Second page', chapter: null, created_at: '2026-11-03T00:00:00Z',
		updated_at: '2026-11-03T00:00:00Z', deleted_at: null, rev: 1
	});
	await page.goto('/read/21/31?bookmark=saved-page');
	await expect(page.locator('.reader-pdf-text')).toContainText('Second PDF page text');
	await expect(page.getByRole('button', { name: 'Save current position' })).toHaveCount(0);
});
