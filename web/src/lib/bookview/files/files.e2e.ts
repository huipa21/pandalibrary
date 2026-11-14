import { expect, test, type Page } from '@playwright/test';
import type { Book, BookFile } from '../../catalog/types.js';
import { pdfFixture } from '../../reader/fixtures.js';
import type { Progress } from '../../reader/types.js';

const hash = 'a'.repeat(64);

function file(id: number, format: string, name: string, size: number, added: string): BookFile {
	return {
		id, format, original_filename: name, size_bytes: size, created_at: added,
		download_url: `/api/v1/books/21/files/${id}?v=${hash}`
	};
}

function makeBook(): Book {
	return {
		owner_id: null, visibility: 'library', can_manage_visibility: false,
		id: 21, library_id: 1, title: 'Multi-format Book', sort_title: 'Multi-format Book',
		subtitle: null, description: null, language: 'en', publisher: null, published_date: null,
		page_count: null, cover_url: null, cover_source: null,
		authors: [{ id: 1, name: 'First Author', role: 'author', position: 0 }],
		series: null, tags: [], identifiers: [], field_sources: [],
		files: [
			file(34, 'mobi', 'M.mobi', 400, '2026-05-01T00:00:00Z'),
			file(33, 'cbz', 'Comic.cbz', 300, '2026-04-01T00:00:00Z'),
			file(32, 'pdf', 'Manual.pdf', 4096, '2026-02-01T00:00:00Z'),
			file(35, 'epub', 'Z.epub', 600, '2026-03-01T00:00:00Z'),
			file(31, 'epub', 'A.epub', 200, '2026-01-01T00:00:00Z')
		],
		created_at: '2026-01-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z'
	};
}

function makeProgress(fileId = 32, percentage = 0.21, rev = 1): Progress {
	return {
		book_file_id: fileId, source: 'web', locator: null, percentage, device: 'Web',
		device_id: 'device', updated_at: '2026-11-06T12:00:00Z', rev
	};
}

interface FixtureState {
	book: Book;
	progress: Progress | null;
	progressStatus: number;
	fileStatus: number;
	online: boolean;
	locale: 'en' | 'zh';
	progressRequests: number;
	holdProgress: boolean;
	releaseProgress: (() => void) | null;
	holdFile: boolean;
	releaseFile: (() => void) | null;
}

async function setup(page: Page, options: { empty?: boolean; locale?: 'en' | 'zh'; holdProgress?: boolean; admin?: boolean } = {}) {
	const state: FixtureState = {
		book: makeBook(), progress: makeProgress(), progressStatus: 200, fileStatus: 200,
		online: true, locale: options.locale ?? 'en', progressRequests: 0,
		holdProgress: options.holdProgress ?? false, releaseProgress: null,
		holdFile: false, releaseFile: null
	};
	if (options.empty) {
		state.book = { ...state.book, files: [] };
		state.progress = null;
	}
	await page.addInitScript(() => {
		Object.defineProperty(ServiceWorkerRegistration.prototype, 'sync', { value: undefined, configurable: true });
	});
	await page.route('**/api/v1/**', async (route) => {
		if (!state.online) return route.abort('internetdisconnected');
		const url = new URL(route.request().url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: {
			id: 1, username: 'reader', display_name: '', role: options.admin ? 'admin' : 'user', locale: state.locale
		} } });
		if (path === '/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Family Library' } } });
		if (path === '/libraries/2') return route.fulfill({ json: { library: { id: 2, name: 'New Library' } } });
		if (path === '/shelves') return route.fulfill({ json: { items: [], next_cursor: null } });
		if (path === '/books/21/shelves') return route.fulfill({ json: { shelves: [] } });
		if (path === '/books/21') return route.fulfill({ json: { book: state.book } });
		if (path === '/books') return route.fulfill({ json: { items: [state.book], next_cursor: null } });
		if (/^\/books\/21\/files\/\d+$/.test(path)) {
			if (state.holdFile) {
				state.holdFile = false;
				await new Promise<void>((resolve) => { state.releaseFile = resolve; });
				state.releaseFile = null;
			}
			return route.fulfill({
				status: state.fileStatus,
				contentType: path.endsWith('/32') ? 'application/pdf' : 'application/octet-stream',
				body: path.endsWith('/32') ? pdfFixture() : 'book file'
			});
		}
		if (path === '/me/books/21') {
			state.progressRequests += 1;
			if (state.holdProgress) {
				state.holdProgress = false;
				await new Promise<void>((resolve) => { state.releaseProgress = resolve; });
				state.releaseProgress = null;
			}
			if (state.progressStatus !== 200) return route.fulfill({ status: state.progressStatus, json: { title: 'Failed' } });
			return route.fulfill({ json: { user_book: null, progress: state.progress, highlights: [], bookmarks: [], notes: [] } });
		}
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/sync/pull') {
			const cursor = Number(url.searchParams.get('cursor') ?? 0);
			const revision = Math.max(cursor, state.progress?.rev ?? 0);
			return route.fulfill({ json: {
				cursor: revision, user_books: [], highlights: [], bookmarks: [], notes: [], user_settings: [],
				reading_progress: state.progress && state.progress.rev > cursor
					? [{ ...state.progress, book_id: 21 }]
					: []
			} });
		}
		if (path === '/sync/push') {
			const body = route.request().postDataJSON() as { mutations: unknown[] };
			return route.fulfill({ json: { results: body.mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ status: 404, json: { title: 'Unknown fixture endpoint', status: 404 } });
	});
	return state;
}

const panel = (page: Page) => page.getByRole('region', { name: 'This file' });
const group = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

async function saveFromPanel(page: Page, name: string) {
	await page.getByRole('button', { name: `Actions for ${name}` }).click();
	await page.getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect(page.getByText('Book file downloaded for offline reading.', { exact: true })).toBeVisible();
}

async function storedRows(page: Page, store: string): Promise<Array<Record<string, unknown>>> {
	return page.evaluate((name) => new Promise((resolve, reject) => {
		const request = indexedDB.open('pandalibrary-offline');
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const database = request.result;
			const transaction = database.transaction(name);
			const all = transaction.objectStore(name).getAll();
			transaction.oncomplete = () => { database.close(); resolve(all.result); };
			transaction.onabort = () => { database.close(); reject(transaction.error); };
		};
	}), store);
}

async function ensureServiceWorker(page: Page) {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
		}
	});
}

test('groups formats, selects the progress file, updates the panel, and resumes the chosen copy', async ({ page }) => {
	await setup(page);
	await page.goto('/books/21/files');

	await expect(page.getByRole('heading', { name: 'Files', level: 1 })).toBeAttached();
	await expect(page.getByRole('region', { name: 'Library', exact: true })).toContainText('Family Library');
	await expect(page.getByRole('navigation', { name: 'File location' })).toContainText('First Author');
	await expect(page.getByRole('navigation', { name: 'File location' })).toContainText('Manual.pdf');
	await expect(page.locator('[aria-labelledby^="file-group-"] h3')).toHaveText(['Ebook', 'Document', 'Comic']);
	await expect(page.getByText('Grouped by reader', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('combobox', { name: 'Sort files' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Move book', exact: true })).toHaveCount(0);
	await expect(panel(page).getByRole('link')).toHaveCount(0);
	await expect(panel(page).getByRole('button', { name: /^Actions for / })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Select Manual.pdf' })).toHaveAttribute('aria-pressed', 'true');
	await expect(panel(page).getByRole('heading', { name: 'Manual.pdf' })).toBeVisible();
	await expect(panel(page)).toContainText('Primary');
	await expect(panel(page)).toContainText('You are 21% through this copy');
	await expect(panel(page)).toContainText('Last read');
	const added = await page.evaluate(() => new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date('2026-02-01T00:00:00Z')));
	await expect(panel(page).locator('dl')).toContainText(added);
	await expect(panel(page).getByRole('img', { name: '21% read' })).toBeVisible();
	await expect(group(page, 'Document').getByText('21% read')).toBeVisible();
	await expect(group(page, 'Ebook').getByText('21% read')).toHaveCount(0);
	await page.getByRole('button', { name: 'Actions for Manual.pdf' }).click();
	await expect(page.getByRole('menuitem', { name: 'Download' })).toHaveAttribute('href', `/api/v1/books/21/files/32?v=${hash}`);
	await page.keyboard.press('Escape');

	await page.getByRole('button', { name: 'Select A.epub' }).click();
	await expect(panel(page).getByRole('heading', { name: 'A.epub' })).toBeVisible();
	await expect(panel(page).getByRole('img', { name: '21% read' })).toHaveCount(0);
	await expect(panel(page)).not.toContainText('Primary');
	await expect(page.getByRole('link', { name: 'Read A.epub' })).toHaveAttribute('href', '/read/21/31');
	await page.getByRole('button', { name: 'Actions for A.epub' }).click();
	await expect(page.getByRole('menuitem', { name: 'Download' })).toHaveAttribute('href', `/api/v1/books/21/files/31?v=${hash}`);
	await page.keyboard.press('Escape');

	await page.getByRole('button', { name: 'Select Manual.pdf' }).click();
	await page.getByRole('link', { name: 'Resume Manual.pdf' }).click();
	await expect(page).toHaveURL('/read/21/32');
});

test('keeps fixed format ordering and does not overflow a narrow viewport', async ({ page }) => {
	const state = await setup(page);
	const longName = `${'a'.repeat(180)}.epub`;
	state.book = {
		...state.book,
		files: state.book.files.map((item) => item.id === 31 ? { ...item, original_filename: longName } : item)
	};
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/books/21/files');
	const ebook = group(page, 'Ebook');
	const labels = () => ebook.locator('button[aria-pressed]').evaluateAll((buttons) =>
		buttons.map((button) => button.getAttribute('aria-label'))
	);
	await expect.poll(labels).toEqual([`Select ${longName}`, 'Select Z.epub', 'Select M.mobi']);
	await expect(page.getByLabel('Sort files')).toHaveCount(0);
	await expect(group(page, 'Document')).toBeVisible();
	await expect(group(page, 'Comic')).toBeVisible();
	await page.getByRole('button', { name: `Select ${longName}` }).click();
	await expect(panel(page).getByRole('heading', { name: longName })).toBeVisible();
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('refreshes per-file progress on matching events without overriding a manual selection', async ({ page }) => {
	const state = await setup(page, { holdProgress: true });
	await page.goto('/books/21/files');
	await expect.poll(() => state.releaseProgress !== null).toBe(true);
	await page.getByRole('button', { name: 'Select Comic.cbz' }).click();
	state.releaseProgress?.();
	await expect(group(page, 'Document').getByText('21% read')).toBeVisible();
	await expect(panel(page).getByRole('heading', { name: 'Comic.cbz' })).toBeVisible();
	await expect(panel(page)).not.toContainText('21%');

	state.progress = makeProgress(31, 0.66, 2);
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 21 } })));
	await expect(group(page, 'Ebook').getByText('66% read')).toBeVisible();
	await expect(group(page, 'Document').getByText('21% read')).toHaveCount(0);
	await expect(panel(page).getByRole('heading', { name: 'Comic.cbz' })).toBeVisible();
	await page.getByRole('button', { name: 'Select A.epub' }).click();
	await expect(panel(page)).toContainText('Primary');
	await expect(panel(page)).toContainText('You are 66% through this copy');
});

test('keeps unsupported files visible and handles missing and zero-percent progress', async ({ page }) => {
	const state = await setup(page);
	state.book = {
		...state.book,
		files: [...state.book.files, file(36, 'zip', 'Archive.zip', 500, '2026-01-01T00:00:00Z')]
	};
	state.progress = makeProgress(999, 0.75);
	await page.goto('/books/21/files');
	await expect(page.getByRole('button', { name: 'Select A.epub' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByText('75% read')).toHaveCount(0);
	await expect(group(page, 'Other')).toContainText('Archive.zip');
	await page.getByRole('button', { name: 'Select Archive.zip' }).click();
	await expect(panel(page).getByRole('heading', { name: 'Archive.zip' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Read Archive.zip' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Actions for Archive.zip' }).click();
	await expect(page.getByRole('menuitem', { name: 'Download' })).toHaveAttribute('href', `/api/v1/books/21/files/36?v=${hash}`);
	await page.keyboard.press('Escape');

	state.progress = makeProgress(31, 0, 2);
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 21 } })));
	await expect(group(page, 'Ebook').getByText('0% read')).toBeVisible();
	await page.getByRole('button', { name: 'Select A.epub' }).click();
	await expect(panel(page)).toContainText('You are 0% through this copy');
	await expect(page.getByRole('link', { name: 'Resume A.epub' })).toHaveAttribute('href', '/read/21/31');
});

test('supports clipboard and keyboard-operated file menus', async ({ page, context }) => {
	await setup(page);
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.goto('/books/21/files');
	await expect(panel(page).getByRole('heading', { name: 'Manual.pdf' })).toBeVisible();
	await panel(page).getByRole('button', { name: 'Copy file name: Manual.pdf' }).click();
	await expect(page.getByText('File name copied.')).toBeVisible();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Manual.pdf');

	const trigger = page.getByRole('button', { name: 'Actions for Manual.pdf' });
	await trigger.focus();
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('menuitem', { name: 'Download' })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('menuitem', { name: 'Save for offline' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');

	await group(page, 'Ebook').getByRole('button', { name: 'Actions for A.epub' }).click();
	await group(page, 'Ebook').getByRole('menuitem', { name: 'Copy file name' }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('A.epub');
});

test('saves files, confirms removal of all downloaded copies, and preserves them on cancel', async ({ page }) => {
	await setup(page);
	await page.goto('/books/21/files');
	await saveFromPanel(page, 'Manual.pdf');
	await expect(panel(page)).toContainText('Offline');
	await page.getByRole('button', { name: 'Select A.epub' }).click();
	await saveFromPanel(page, 'A.epub');
	await expect.poll(async () => (await storedRows(page, 'files')).length).toBe(2);

	page.once('dialog', (dialog) => {
		expect(dialog.message()).toBe('Remove this book and its downloaded files from this device? Queued reading changes are kept.');
		void dialog.dismiss();
	});
	await page.getByRole('button', { name: 'Actions for A.epub' }).click();
	await page.getByRole('menuitem', { name: 'Remove offline copy' }).click();
	expect(await storedRows(page, 'files')).toHaveLength(2);
	await expect(panel(page)).toContainText('Offline');

	page.once('dialog', (dialog) => void dialog.accept());
	await page.getByRole('button', { name: 'Actions for A.epub' }).click();
	await page.getByRole('menuitem', { name: 'Remove offline copy' }).click();
	await expect(page.getByText('Downloaded book data removed.')).toBeVisible();
	await expect.poll(async () => (await storedRows(page, 'files')).length).toBe(0);
	await expect(panel(page)).not.toContainText('Offline');
});

test('reports progress and download failures, including revoked access, and shows busy state', async ({ page }) => {
	const state = await setup(page);
	const sync: { release: (() => void) | null } = { release: null };
	await page.route('**/api/v1/sync/pull**', async (route) => {
		await new Promise<void>((resolve) => { sync.release = resolve; });
		await route.fallback();
	}, { times: 1 });
	state.progressStatus = 503;
	try {
		await page.goto('/books/21/files');
		await expect.poll(() => sync.release !== null).toBe(true);
		await expect(page.getByRole('alert').filter({ hasText: 'Could not load reading progress.' })).toBeVisible();
		state.progressStatus = 200;
		await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
		await expect(panel(page)).toContainText('You are 21% through this copy');
	} finally {
		sync.release?.();
	}

	state.holdFile = true;
	state.fileStatus = 503;
	await page.getByRole('button', { name: 'Actions for Manual.pdf' }).click();
	await page.getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect.poll(() => state.releaseFile !== null).toBe(true);
	await expect(page.getByText('Downloading for offline…')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Actions for Manual.pdf' })).toBeDisabled();
	state.releaseFile?.();
	await expect(page.getByRole('alert').filter({ hasText: 'Could not download this file for offline reading.' })).toBeVisible();

	state.fileStatus = 200;
	await saveFromPanel(page, 'Manual.pdf');
	await page.getByRole('button', { name: 'Select A.epub' }).click();
	state.fileStatus = 403;
	await page.getByRole('button', { name: 'Actions for A.epub' }).click();
	await page.getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Could not download this file for offline reading.' })).toBeVisible();
	await expect.poll(async () => (await storedRows(page, 'files')).length).toBe(0);
});

test('loads synchronized progress and legacy metadata offline, then reloads after removal', async ({ page, context }) => {
	const state = await setup(page);
	await page.goto('/books/21/files');
	await saveFromPanel(page, 'Manual.pdf');
	await ensureServiceWorker(page);
	await page.evaluate(() => new Promise<void>((resolve, reject) => {
		const request = indexedDB.open('pandalibrary-offline');
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const database = request.result;
			const transaction = database.transaction('books', 'readwrite');
			const store = transaction.objectStore('books');
			const get = store.get([1, 21]);
			get.onsuccess = () => {
				const value = get.result;
				for (const item of value.book.files) {
					delete item.original_filename;
					delete item.created_at;
				}
				store.put(value);
			};
			transaction.oncomplete = () => { database.close(); resolve(); };
			transaction.onabort = () => { database.close(); reject(transaction.error); };
		};
	}));
	state.online = false;
	await context.setOffline(true);
	await page.reload();
	await expect(panel(page).getByRole('heading', { name: 'Multi-format Book.pdf' })).toBeVisible();
	await expect(panel(page)).toContainText('Unknown');
	await expect(panel(page)).toContainText('You are 21% through this copy');
	await expect(panel(page)).toContainText('Offline');
	await expect(panel(page).getByRole('link', { name: 'Download' })).toHaveCount(0);
	await expect(group(page, 'Ebook')).toHaveCount(0);
	page.once('dialog', (dialog) => void dialog.accept());
	await page.getByRole('button', { name: 'Actions for Multi-format Book.pdf' }).click();
	await page.getByRole('menuitem', { name: 'Remove offline copy' }).click();
	await expect(page.getByRole('main').getByRole('alert').filter({ hasText: 'This book or file is not available offline.' })).toBeVisible();
	await expect.poll(async () => (await storedRows(page, 'files')).length).toBe(0);
});

test('refreshes the book and progress after reconnecting from an offline load', async ({ page, context }) => {
	const state = await setup(page);
	await page.goto('/books/21/files');
	await saveFromPanel(page, 'Manual.pdf');
	await ensureServiceWorker(page);
	state.online = false;
	await context.setOffline(true);
	await page.reload();
	await expect(panel(page)).toContainText('You are 21% through this copy');
	await expect(group(page, 'Ebook')).toHaveCount(0);

	state.progress = makeProgress(31, 0.66, 2);
	state.online = true;
	await context.setOffline(false);
	await expect(group(page, 'Ebook')).toBeVisible();
	await expect(panel(page).getByRole('heading', { name: 'A.epub' })).toBeVisible();
	await expect(panel(page)).toContainText('You are 66% through this copy');
	await expect(page.getByRole('button', { name: 'Actions for A.epub' })).toBeVisible();
});

test('shows an empty state and localizes the files view', async ({ page }) => {
	await setup(page, { empty: true });
	await page.goto('/books/21/files');
	await expect(page.getByRole('heading', { name: 'No files' })).toBeVisible();
	await expect(panel(page)).toHaveCount(0);
});

test('shows translated file groups and progress', async ({ page }) => {
	await setup(page, { locale: 'zh' });
	await page.goto('/books/21/files');
	await expect(page.getByRole('region', { name: '电子书' })).toBeVisible();
	await expect(page.getByRole('region', { name: '此文件' })).toContainText('此副本已读 21%');
});

test('places book actions beside the cover and toggles the selected default file in the panel header', async ({ page }, testInfo) => {
	const state = await setup(page, { admin: true });
	let defaultStatus = 200;
	await page.route('**/api/v1/books/21/default-file', async (route) => {
		if (defaultStatus !== 200) return route.fulfill({ status: defaultStatus, json: { title: 'Failed' } });
		const { file_id } = route.request().postDataJSON() as { file_id: number | null };
		state.book = { ...state.book, files: state.book.files.map((file) => ({ ...file, is_default: file.id === file_id })) };
		await route.fulfill({ json: { book: state.book } });
	});
	await page.goto('/books/21/files');
	const identity = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Multi-format Book', exact: true }) });
	await expect(identity.getByRole('button', { name: 'Move book', exact: true })).toBeVisible();
	await expect(identity.getByRole('button', { name: 'Add to collection', exact: true })).toBeVisible();
	await expect(identity.getByRole('button', { name: 'Add file', exact: true })).toBeVisible();
	const summary = page.locator('section.card').filter({ has: page.getByRole('region', { name: 'Library', exact: true }) });
	await expect(summary.locator('dl')).toContainText('Formats');
	await expect(summary).toContainText('Family Library');
	await expect(identity.locator('dl')).toHaveCount(0);
	await expect(panel(page).getByRole('link')).toHaveCount(0);
	const toggle = panel(page).getByRole('button', { name: 'Set as default', exact: true });
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await toggle.click();
	await expect(panel(page).getByRole('button', { name: 'Clear default', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(panel(page).getByText('Primary', { exact: true })).toHaveCount(1);
	await expect(page.getByText('Default', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Manual.pdf is now the default file.', { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Select A.epub', exact: true }).click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await toggle.click();
	await expect(panel(page).getByRole('button', { name: 'Clear default', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(panel(page).getByText('Primary', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Default', { exact: true })).toHaveCount(0);
	await expect(page.getByText('A.epub is now the default file.', { exact: true })).toHaveCount(0);
	await page.reload();
	await page.getByRole('button', { name: 'Select A.epub', exact: true }).click();
	await expect(panel(page).getByRole('button', { name: 'Clear default', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await panel(page).getByRole('button', { name: 'Clear default', exact: true }).click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByText('Default', { exact: true })).toHaveCount(0);
	await expect(page.getByText('The default file was cleared.', { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Select Manual.pdf', exact: true }).click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(panel(page).getByText('Primary', { exact: true })).toHaveCount(1);
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 900 });
		const left = await identity.boundingBox();
		const right = await summary.boundingBox();
		const selected = await panel(page).boundingBox();
		const star = await toggle.boundingBox();
		const heading = await panel(page).getByRole('heading', { name: 'This file', exact: true }).boundingBox();
		if (!left || !right || !selected || !star || !heading) throw new Error('Missing Files card layout.');
		if (width >= 1024) {
			expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
			expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
			expect(left.width).toBeGreaterThan(right.width);
			expect(Math.abs(right.x - selected.x)).toBeLessThanOrEqual(1);
			expect(Math.abs(right.width - selected.width)).toBeLessThanOrEqual(1);
		} else {
			expect(right.y).toBeGreaterThanOrEqual(left.y + left.height);
		}
		expect(Math.abs(star.y + star.height / 2 - heading.y - heading.height / 2)).toBeLessThanOrEqual(1);
		expect(selected.x + selected.width - star.x - star.width).toBeLessThanOrEqual(25);
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		await page.screenshot({ path: testInfo.outputPath(`files-${width}.png`), fullPage: true });
	}
	defaultStatus = 503;
	await toggle.click();
	await expect(page.getByRole('alert').filter({ hasText: 'Could not change the default file.' })).toBeVisible();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(panel(page).getByText('Primary', { exact: true })).toHaveCount(1);
});

test('moves all book files, updates the library tag, and reports load and destination conflicts without losing files', async ({ page }) => {
	const state = await setup(page, { admin: true });
	let loadStatus = 503;
	let moveStatus = 409;
	const patches: unknown[] = [];
	await page.route('**/api/v1/libraries?*', async (route) => {
		await route.fulfill({ status: loadStatus, json: { items: [
			{ id: 1, name: 'Family Library' }, { id: 2, name: 'New Library' }
		], next_cursor: null } });
	});
	await page.route('**/api/v1/books/21', async (route) => {
		if (route.request().method() === 'PATCH') {
			patches.push(route.request().postDataJSON());
			if (moveStatus !== 200) return route.fulfill({ status: moveStatus, contentType: 'application/problem+json', json: {
				detail: "Destination library already contains this book's file"
			} });
			state.book = { ...state.book, library_id: 2 };
		}
		await route.fulfill({ json: { book: state.book } });
	});
	await page.goto('/books/21/files');
	await page.getByRole('button', { name: 'Move book', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Move book', exact: true });
	await expect(dialog.getByRole('alert')).toHaveText('Could not load libraries. Please try again.');
	loadStatus = 200;
	await dialog.getByRole('button', { name: 'Try again' }).click();
	const destination = dialog.getByRole('combobox', { name: 'Destination library' });
	await expect(destination.locator('option')).toHaveText(['Choose a library', 'New Library']);
	await destination.selectOption('2');
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	expect(patches).toHaveLength(0);
	await page.getByRole('button', { name: 'Move book', exact: true }).click();
	await destination.selectOption('2');
	await dialog.getByRole('button', { name: 'Move book', exact: true }).click();
	await expect(dialog.getByRole('alert')).toHaveText("Destination library already contains this book's file");
	await expect(page.getByRole('region', { name: 'Library', exact: true })).toContainText('Family Library');
	moveStatus = 200;
	await dialog.getByRole('button', { name: 'Move book', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Library', exact: true }).getByRole('link')).toHaveAttribute('href', '/library/2');
	await expect(page.getByText('Book moved to New Library.', { exact: true })).toBeVisible();
	expect(patches).toEqual([{ library_id: 2 }, { library_id: 2 }]);
	await page.reload();
	await expect(page.getByRole('region', { name: 'Library', exact: true })).toContainText('New Library');
	expect(state.book.files).toHaveLength(5);
	await expect(page.locator('button[aria-label^="Select "]')).toHaveCount(5);
});

test('disables moving when there are no destination libraries or the connection is offline', async ({ page, context }) => {
	await setup(page, { admin: true });
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: {
		items: [{ id: 1, name: 'Family Library' }], next_cursor: null
	} }));
	await page.goto('/books/21/files');
	await page.getByRole('button', { name: 'Move book', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Move book', exact: true });
	await expect(dialog.getByText('No other libraries are available.')).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Move book', exact: true })).toBeDisabled();
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await context.setOffline(true);
	await expect(page.getByRole('button', { name: 'Move book', exact: true })).toBeDisabled();
	await expect(panel(page).getByRole('button', { name: 'Set as default', exact: true })).toBeDisabled();
});
