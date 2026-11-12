import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { pdfFixture, epubFixture } from '../lib/reader/fixtures.js';
import { realAdmin, signInRealAdmin } from '../lib/real-auth.js';
import { bookmarkPdfSelection, jumpToPdfPage, openBookmarksPanel, openedPdf, pdfPageBox, pdfPageText, renamePdfBookmark } from '../lib/real-pdf.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');

async function login(page: Page, username: string, password: string) {
	await page.goto('/login');
	await page.getByLabel('Username', { exact: true }).fill(username);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL('/');
}

async function selectAdminUser(page: Page, id: number) {
	const select = page.getByLabel('User ID', { exact: true });
	await expect(select).toBeEnabled();
	const options = select.locator('option');
	const target = select.locator(`option[value="${id}"]`);
	while (await target.count() === 0) {
		const count = await options.count();
		const more = page.getByRole('button', { name: 'Load more users', exact: true });
		await expect(more).toBeVisible();
		await more.click();
		await expect.poll(() => options.count()).toBeGreaterThan(count);
	}
	await select.selectOption(String(id));
}

async function importBook(page: Page, name: string, bytes: Buffer) {
	const created = await page.request.post('/api/v1/admin/libraries', { data: { name, slug: name.toLowerCase() } });
	expect(created.status()).toBe(201);
	const { library } = await created.json() as { library: { id: number } };
	const uploaded = await page.request.post('/api/v1/uploads', { multipart: {
		library_id: String(library.id), file: { name: `${name}.${name === 'UXEPUB' ? 'epub' : 'pdf'}`, mimeType: 'application/octet-stream', buffer: bytes }
	} });
	expect(uploaded.ok()).toBe(true);
	const { job } = await uploaded.json() as { job: { id: number } };
	let bookID = 0;
	await expect.poll(async () => {
		const result = await page.request.get('/api/v1/imports?limit=100');
		const payload = await result.json() as { items: Array<{ id: number; status: string; book_id: number | null }> };
		const imported = payload.items.find((item) => item.id === job.id);
		bookID = imported?.book_id ?? 0;
		return imported?.status;
	}, { timeout: 30_000 }).toBe('imported');
	const response = await page.request.get(`/api/v1/books/${bookID}`);
	expect(response.ok()).toBe(true);
	const { book } = await response.json() as { book: { title: string; files: Array<{ id: number }> } };
	return { bookID, fileID: book.files[0].id, libraryID: library.id, title: book.title };
}

async function expectEpubSection(page: Page, title: string) {
	await expect(async () => {
		const frames = page.frames().filter((frame) => frame.url().startsWith('blob:'));
		const visible = await Promise.all(frames.map((frame) => frame.getByRole('heading', { name: title, exact: true }).isVisible()));
		expect(visible).toContain(true);
	}).toPass({ timeout: 10_000 });
}

test('real accounts lifecycle, selectors, denied access and self credential retirement', async ({ page, browser }, info) => {
	test.setTimeout(150_000);
	await signInRealAdmin(page);
	await page.goto('/admin/users');
	await page.getByRole('button', { name: 'Create account', exact: true }).click();
	const create = page.getByRole('region', { name: 'Create account' });
	await create.getByLabel('Username', { exact: true }).fill('ux-reader');
	await create.getByLabel('Display name').fill('UX Reader');
	await create.getByLabel('Password', { exact: true }).fill('ux-reader-password');
	const creation = page.waitForResponse((response) =>
		new URL(response.url()).pathname === '/api/v1/admin/users' && response.request().method() === 'POST'
	);
	await create.getByRole('button', { name: 'Create account' }).click();
	const created = await creation;
	expect(created.status()).toBe(201);
	const { user: { id } } = await created.json() as { user: { id: number } };
	const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'ux-reader', exact: true }) });
	await expect(row).toBeVisible();
	await row.getByRole('checkbox').check();
	await page.getByRole('toolbar').getByRole('button', { name: 'Edit', exact: true }).click();
	const edit = page.getByRole('region', { name: 'Edit account' });
	await edit.getByLabel('Display name').fill('Renamed Reader');
	await edit.getByRole('button', { name: 'Save changes' }).click();
	await expect(row).toContainText('Renamed Reader');
	const readerContext = await browser.newContext();
	const reader = await readerContext.newPage();
	try {
		await login(reader, 'ux-reader', 'ux-reader-password');
		await reader.goto('/admin/users');
		await expect(reader.getByText('Only administrators can open this area.')).toBeVisible();
		expect((await reader.request.get('/api/v1/admin/users')).status()).toBe(403);
		page.once('dialog', (dialog) => dialog.accept());
		await page.getByRole('toolbar').getByRole('button', { name: 'Disable', exact: true }).click();
		await expect(row).toContainText('Disabled');
		expect((await reader.request.get('/api/v1/auth/me')).status()).toBe(401);
		page.once('dialog', (dialog) => dialog.accept());
		await row.getByRole('checkbox').check();
		await page.getByRole('toolbar').getByRole('button', { name: 'Enable', exact: true }).click();
		await expect(row).toContainText('Active');
		await row.getByRole('checkbox').check();
		await page.getByRole('toolbar').getByRole('button', { name: 'Reset password', exact: true }).click();
		const reset = page.getByRole('region', { name: 'Reset password' });
		await reset.getByLabel('New password', { exact: true }).fill('ux-replacement-password');
		await reset.getByLabel('Confirm new password').fill('different-password');
		await reset.getByRole('button', { name: 'Save changes' }).click();
		await expect(reset.locator('#field-confirmation')).toHaveAttribute('aria-invalid', 'true');
		await reset.getByLabel('Confirm new password').fill('ux-replacement-password');
		await reset.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByText('Password reset. Sessions and device credentials were revoked.')).toBeVisible();
		await login(reader, 'ux-reader', 'ux-replacement-password');
		page.once('dialog', (dialog) => dialog.accept());
		await page.getByRole('toolbar').getByRole('button', { name: 'Revoke credentials', exact: true }).click();
		await expect(page.getByText('Completed for 1 account(s).', { exact: true })).toBeVisible();
		expect((await reader.request.get('/api/v1/auth/me')).status()).toBe(401);
		await page.goto('/admin/libraries');
		const library = page.getByRole('region', { name: 'New library' });
		await library.getByLabel('Name').fill('UX Grants');
		await library.getByLabel('Slug').fill('ux-grants');
		await library.getByRole('button', { name: 'Create library' }).click();
		await page.getByRole('button', { name: 'Manage access UX Grants' }).click();
		await selectAdminUser(page, id);
		await page.getByRole('button', { name: 'Grant access', exact: true }).click();
		await expect(page.getByText(`User #${id} can now see “UX Grants”.`)).toBeVisible();
		await page.goto('/admin/hidden-books');
		await selectAdminUser(page, id);
		await page.getByRole('button', { name: 'Show hidden books' }).click();
		await expect(page.getByRole('heading', { name: `Books hidden from user #${id}` })).toBeVisible();
		await page.goto('/admin/users');
		await page.screenshot({ path: info.outputPath('admin-users-en.png'), fullPage: true });
		page.once('dialog', (dialog) => dialog.accept());
		await row.getByRole('checkbox').check();
		await page.getByRole('toolbar').getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(row).toHaveCount(0);
		const own = page.getByRole('row').filter({ has: page.getByRole('cell', { name: realAdmin.username, exact: true }) });
		page.once('dialog', (dialog) => dialog.accept());
		await own.getByRole('checkbox').check();
		await page.getByRole('toolbar').getByRole('button', { name: 'Disable', exact: true }).click();
		await expect(page.getByRole('alert')).toContainText('administrator');
		// Self reset and revoke use a separate admin so other real-server tests keep their session.
		const response = await page.request.post('/api/v1/admin/users', { data: {
			username: 'ux-self', password: 'ux-self-password', role: 'admin', locale: 'zh'
		} });
		expect(response.status()).toBe(201);
		await readerContext.clearCookies();
		await login(reader, 'ux-self', 'ux-self-password');
		await reader.goto('/admin/users');
		await expect(reader.getByRole('heading', { name: '用户', level: 1, exact: true })).toBeVisible();
		await reader.screenshot({ path: info.outputPath('admin-users-zh.png'), fullPage: true });
		// Switch this account to English through the API, then test both self invalidations.
		const self = await response.json() as { user: { id: number } };
		expect((await page.request.patch(`/api/v1/admin/users/${self.user.id}`, { data: { locale: 'en' } })).ok()).toBe(true);
		await reader.reload();
		const selfRow = reader.getByRole('row').filter({ has: reader.getByRole('cell', { name: 'ux-self', exact: true }) });
		await selfRow.getByRole('checkbox').check();
		await reader.getByRole('toolbar').getByRole('button', { name: 'Reset password', exact: true }).click();
		await reader.getByLabel('New password', { exact: true }).fill('ux-self-new-password');
		await reader.getByLabel('Confirm new password').fill('ux-self-new-password');
		await reader.getByRole('button', { name: 'Save changes' }).click();
		await expect(reader).toHaveURL('/login');
		await login(reader, 'ux-self', 'ux-self-new-password');
		await reader.goto('/admin/users');
		reader.once('dialog', (dialog) => dialog.accept());
		await selfRow.getByRole('checkbox').check();
		await reader.getByRole('toolbar').getByRole('button', { name: 'Revoke credentials', exact: true }).click();
		await expect(reader).toHaveURL('/login');
		await expect.poll(() => reader.evaluate(() => localStorage.getItem('pandalibrary.offline.signed-out'))).toBe('1');
		expect((await page.request.delete(`/api/v1/admin/users/${self.user.id}`)).ok()).toBe(true);
	} finally {
		await readerContext.close();
	}
});

test('book-scoped PDF and CFI bookmarks jump, rename, survive offline reload and sync', async ({ page, context, browser }, info) => {
	test.setTimeout(150_000);
	await signInRealAdmin(page);
	const pdf = await importBook(page, 'UXPDF', pdfFixture());
	const epub = await importBook(page, 'UXEPUB', epubFixture('UX EPUB Fixture'));
	await page.goto(`/read/${pdf.bookID}/${pdf.fileID}`);
	await openedPdf(page, 1, 'First PDF page text');
	const pdfBookmark = await bookmarkPdfSelection(page, 'First PDF page text', 'PDF saved page');
	await page.goto(`/read/${epub.bookID}/${epub.fileID}`);
	await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
	await page.getByTestId('reflow-bookmark-toggle').click();
	await expect(page.getByTestId('reflow-bookmark-toggle')).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('tab', { name: 'Bookmarks', exact: true }).click();
	const epubBookmarks = page.locator('section[aria-labelledby="bookmarks-heading"]');
	const epubItem = epubBookmarks.locator('[data-bookmark-id]');
	await expect(epubItem).toHaveCount(1);
	await epubItem.getByRole('button', { name: 'Edit', exact: true }).click();
	await epubBookmarks.getByRole('textbox', { name: /^Label/ }).fill('CFI saved position');
	await epubBookmarks.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(epubItem).toContainText('CFI saved position');
	await expect(epubBookmarks).not.toContainText('PDF saved page');
	await expectEpubSection(page, 'First section');
	await page.getByRole('slider', { name: 'Reading position' }).evaluate((element: HTMLInputElement) => {
		element.value = '1000';
		element.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await expectEpubSection(page, 'Second section');
	await epubItem.locator('[data-bookmark-jump]').click();
	await expectEpubSection(page, 'First section');
	await page.goto(`/read/${pdf.bookID}/${pdf.fileID}`);
	await openedPdf(page, 1, 'First PDF page text');
	const panel = await openBookmarksPanel(page);
	const pdfItem = panel.locator(`[data-bookmark-id="${pdfBookmark}"]`);
	await expect(pdfItem).toContainText('PDF saved page');
	await expect(panel).not.toContainText('CFI saved position');
	await page.screenshot({ path: info.outputPath('reader-bookmarks-populated.png'), fullPage: true });
	await jumpToPdfPage(page, 2);
	await renamePdfBookmark(pdfItem, 'PDF renamed');
	// Renaming must not move the saved position to page two.
	await pdfItem.locator('[data-bookmark-jump]').click();
	await expect(pdfPageBox(page)).toHaveValue('1');
	await page.goto(`/read/${epub.bookID}/${epub.fileID}`);
	await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
	await page.getByRole('tab', { name: 'Bookmarks', exact: true }).click();
	await expect(epubItem).toContainText('CFI saved position');
	await epubItem.locator('[data-bookmark-jump]').click();
	await expect.poll(() => page.frames().some((frame) => frame.url().startsWith('blob:'))).toBe(true);
	await page.goto(`/books/${pdf.bookID}/files`);
	const filePanel = page.getByRole('region', { name: 'This file' });
	await filePanel.getByRole('button', { name: 'Actions for UXPDF.pdf' }).click();
	await filePanel.getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect(page.getByText('Book file downloaded for offline reading.', { exact: true })).toBeVisible();
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) =>
			navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
	});
	await page.goto(`/read/${pdf.bookID}/${pdf.fileID}`);
	await openedPdf(page);
	await context.setOffline(true);
	await jumpToPdfPage(page, 2);
	await expect(pdfPageText(page, 2)).toContainText('Second PDF page text');
	const offlineBookmark = await bookmarkPdfSelection(page, 'Second PDF page text', 'Offline page two');
	await expect.poll(() => page.evaluate((id) => new Promise<boolean>((resolve, reject) => {
		const request = indexedDB.open('pandalibrary-offline');
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const all = request.result.transaction('outbox').objectStore('outbox').getAll();
			all.onsuccess = () => { request.result.close(); resolve(JSON.stringify(all.result).includes(id)); };
			all.onerror = () => { request.result.close(); reject(all.error ?? new Error('Could not read the outbox.')); };
		};
	}), offlineBookmark)).toBe(true);
	await page.reload();
	await openedPdf(page);
	await expect((await openBookmarksPanel(page)).getByText('Offline page two', { exact: true })).toBeVisible();
	await context.setOffline(false);
	await expect.poll(async () => {
		const result = await page.request.get(`/api/v1/me/books/${pdf.bookID}`);
		expect(result.ok()).toBe(true);
		const data = await result.json() as { bookmarks: Array<{ id: string; label: string }> };
		return data.bookmarks.some((item) => item.id === offlineBookmark && item.label === 'Offline page two');
	}).toBe(true);
	const other = await browser.newContext();
	try {
		const second = await other.newPage();
		await login(second, realAdmin.username, realAdmin.password);
		await second.goto(`/read/${pdf.bookID}/${pdf.fileID}`);
		await openedPdf(second);
		await jumpToPdfPage(second, 1);
		let secondPanel = await openBookmarksPanel(second);
		let saved = secondPanel.locator(`[data-bookmark-id="${offlineBookmark}"]`);
		await expect(saved).toContainText('Offline page two');
		await saved.locator('[data-bookmark-jump]').click();
		await expect(pdfPageBox(second)).toHaveValue('2');
		secondPanel = await openBookmarksPanel(second);
		saved = secondPanel.locator(`[data-bookmark-id="${offlineBookmark}"]`);
		await saved.getByRole('button', { name: 'Delete bookmark: Offline page two', exact: true }).click();
		await saved.getByRole('button', { name: 'Confirm delete bookmark: Offline page two', exact: true }).click();
		await expect(saved).toHaveCount(0);
		await page.reload();
		await openedPdf(page);
		await expect((await openBookmarksPanel(page)).locator(`[data-bookmark-id="${offlineBookmark}"]`)).toHaveCount(0);
	} finally {
		await other.close();
	}
	await page.goto('/');
	await page.screenshot({ path: info.outputPath('dashboard-before-restoration.png'), fullPage: true });
	// Restore the intentionally empty dashboard left by its persistence test.
	await page.getByRole('button', { name: 'Configure dashboard' }).click();
	const config = page.getByRole('dialog', { name: 'Configure dashboard' });
	await expect(config).toBeVisible();
	const sections = config.locator('[data-config-section]');
	let remaining = await sections.count();
	while (remaining > 0) {
		await sections.first().getByRole('button', { name: /^Remove / }).click();
		await expect(sections).toHaveCount(--remaining);
	}
	for (const label of ['Continue Reading', 'Recently Added', 'Read']) {
		await config.getByLabel('Choose a section').selectOption({ label });
		await config.getByRole('button', { name: 'Add section', exact: true }).click();
	}
	await config.getByRole('button', { name: 'Save dashboard' }).click();
	await expect(page.locator('[data-dashboard-section]')).toHaveCount(3);
	const version = await page.request.get('/api/v1/version');
	const data = await version.json() as { commit: string; commit_date: string; version: string };
	expect(data.commit).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
	expect(new Date(data.commit_date).toISOString()).toBe(new Date(execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], { encoding: 'utf8' }).trim()).toISOString());
	const compactVersion = `${data.commit_date.slice(2, 10).replaceAll('-', '')}-${data.commit.slice(0, 7)}`;
	await expect(page.locator('[data-slot="sidebar-footer"]')).toContainText(compactVersion);
	await page.screenshot({ path: info.outputPath('dashboard-desktop.png'), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: 'Open navigation menu' }).click();
	await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeVisible();
	await page.screenshot({ path: info.outputPath('dashboard-mobile.png'), fullPage: true });
	await page.keyboard.press('Escape');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('real sidebar shelves, automatic rule changes, favorites and bilingual responsive routes', async ({ page }, info) => {
	test.setTimeout(150_000);
	await signInRealAdmin(page);
	const books = await (await page.request.get('/api/v1/books?limit=100')).json() as { items: Array<{ id: number; title: string; library_id: number }> };
	const existing = books.items.find((item) => item.title === 'UXPDF');
	const imported = existing ? null : await importBook(page, 'UXPDF', pdfFixture());
	const book = existing ?? { id: imported!.bookID, title: imported!.title, library_id: imported!.libraryID };
	await page.goto(`/library/${book.library_id}`);
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	const shelfNavigation = page.getByRole('navigation', { name: 'Browse by shelf' });
	await shelfNavigation.getByRole('button', { name: 'Shelf actions' }).click();
	await shelfNavigation.getByRole('menuitem', { name: 'New shelf' }).click();
	let creator = page.getByRole('dialog', { name: 'Create shelf' });
	await creator.getByLabel('Shelf name').fill('Manual UX shelf');
	await creator.getByRole('button', { name: 'Create shelf', exact: true }).click();
	await expect(creator).toHaveCount(0);
	await expect(shelfNavigation.getByRole('button', { name: 'Shelf actions' })).toBeFocused();
	await shelfNavigation.getByRole('button', { name: 'Shelf actions' }).click();
	await shelfNavigation.getByRole('menuitem', { name: 'Manage shelves' }).click();
	await expect(page).toHaveURL('/shelves');
	await expect(page.getByRole('main').getByRole('link', { name: 'Manual UX shelf', exact: true })).toBeVisible();
	await expect(page.getByRole('main').getByRole('button', { name: 'Create shelf', exact: true })).toHaveCount(0);
	await page.goto(`/books/${book.id}`);
	await page.getByRole('button', { name: 'Add to shelf', exact: true }).click();
	await page.getByRole('dialog', { name: 'Add to shelf' })
		.getByRole('button', { name: 'Manual UX shelf Private', exact: true }).click();
	await expect(page.getByText('Added to “Manual UX shelf”.')).toBeVisible();
	await expect(sidebar.getByRole('link', { name: 'Manual UX shelf 1', exact: true })).toBeVisible();
	await sidebar.getByRole('link', { name: 'Manual UX shelf 1', exact: true }).click();
	await page.getByRole('button', { name: 'Remove “UXPDF” from this shelf' }).click();
	await expect(sidebar.getByRole('link', { name: 'Manual UX shelf 0', exact: true })).toBeVisible();
	await page.goto(`/library/${book.library_id}`);
	await shelfNavigation.getByRole('button', { name: 'Shelf actions' }).click();
	await shelfNavigation.getByRole('menuitem', { name: 'New shelf' }).click();
	creator = page.getByRole('dialog', { name: 'Create shelf' });
	await creator.getByLabel('Automatic', { exact: true }).check();
	await creator.getByLabel('Shelf name').fill('Automatic UX shelf with a deliberately long bilingual name 自动书架');
	if (await creator.getByLabel('Field', { exact: true }).count() === 0) {
		await creator.getByRole('button', { name: 'Add condition' }).click();
	}
	await creator.getByLabel('Field', { exact: true }).selectOption('title');
	await creator.getByLabel('Operator', { exact: true }).selectOption('contains');
	await creator.getByLabel('Value', { exact: true }).fill('UXPDF');
	await creator.getByRole('button', { name: 'Create shelf', exact: true }).click();
	const automatic = sidebar.getByRole('link', { name: /^Automatic UX shelf/ });
	await expect(automatic).toContainText('1');
	await automatic.click();
	const shelfBook = page.getByRole('main').locator(`a[href="/books/${book.id}"]`);
	await expect(shelfBook).toBeVisible();
	await expect(shelfBook).toHaveAttribute('title', 'UXPDF');
	expect((await page.request.patch(`/api/v1/books/${book.id}`, { data: { title: 'Changed shelf input' } })).ok()).toBe(true);
	await page.reload();
	await expect(page.getByText('This shelf has no books you can see.')).toBeVisible();
	await expect(shelfBook).toHaveCount(0);
	await expect(automatic).toContainText('0');
	expect((await page.request.patch(`/api/v1/books/${book.id}`, { data: { title: 'UXPDF' } })).ok()).toBe(true);
	const { shelf: favorites } = await (await page.request.get('/api/v1/shelves/system/favorites')).json() as { shelf: { shelf_id: number } };
	expect((await page.request.put(`/api/v1/shelves/${favorites.shelf_id}/books/${book.id}`, { data: {} })).ok()).toBe(true);
	await page.goto('/shelves/system/favorites');
	await expect(shelfBook).toBeVisible();
	await expect(shelfBook).toHaveAttribute('title', 'UXPDF');
	const { user } = await (await page.request.get('/api/v1/auth/me')).json() as { user: { id: number } };
	for (const locale of ['en', 'zh']) {
		expect((await page.request.patch(`/api/v1/admin/users/${user.id}`, { data: { locale } })).ok()).toBe(true);
		for (const route of ['/books', `/books/${book.id}`, '/shelves', '/notes', '/admin/users']) {
			await page.goto(`${locale === 'zh' ? '/zh' : ''}${route}`);
			const heading = page.getByRole('main').getByRole('heading', { level: 1 });
			if (route === `/books/${book.id}` || route === '/notes' || route === '/admin/users') {
				await expect(heading).toBeVisible();
			} else {
				await expect(heading).toHaveClass('sr-only');
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
			await page.screenshot({ path: info.outputPath(`${locale}-${route.replaceAll('/', '-')}.png`), fullPage: true });
		}
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/zh/shelves');
	await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveClass('sr-only');
	await page.screenshot({ path: info.outputPath('shelves-mobile-zh.png'), fullPage: true });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
	expect((await page.request.patch(`/api/v1/admin/users/${user.id}`, { data: { locale: 'en' } })).ok()).toBe(true);
});
