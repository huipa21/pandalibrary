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

async function setup(page: Page, options: { empty?: boolean; locale?: 'en' | 'zh'; holdProgress?: boolean } = {}) {
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
			id: 1, username: 'reader', display_name: '', role: 'user', locale: state.locale
		} } });
		if (path === '/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Family Library' } } });
		if (path === '/shelves') return route.fulfill({ json: { items: [], next_cursor: null } });
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
	await panel(page).getByRole('button', { name: `Actions for ${name}` }).click();
	await panel(page).getByRole('menuitem', { name: 'Save for offline' }).click();
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
	await expect(page.getByRole('navigation', { name: 'File location' })).toContainText('Family Library');
	await expect(page.getByRole('navigation', { name: 'File location' })).toContainText('First Author');
	await expect(page.getByRole('navigation', { name: 'File location' })).toContainText('Manual.pdf');
	await expect(page.locator('[aria-labelledby^="file-group-"] h3')).toHaveText(['Ebook', 'Document', 'Comic']);
	await expect(group(page, 'Ebook')).toContainText('3 · 1.2 KB');
	await expect(group(page, 'Document')).toContainText('1 · 4 KB');
	await expect(group(page, 'Comic')).toContainText('1 · 300 B');
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
	await expect(panel(page).getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/api/v1/books/21/files/32?v=${hash}`);

	await page.getByRole('button', { name: 'Select A.epub' }).click();
	await expect(panel(page).getByRole('heading', { name: 'A.epub' })).toBeVisible();
	await expect(panel(page).getByRole('img', { name: '21% read' })).toHaveCount(0);
	await expect(panel(page)).not.toContainText('Primary');
	await expect(panel(page).getByRole('link', { name: 'Read A.epub' })).toHaveAttribute('href', '/read/21/31');
	await expect(panel(page).getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/api/v1/books/21/files/31?v=${hash}`);

	await page.getByRole('button', { name: 'Select Manual.pdf' }).click();
	await panel(page).getByRole('link', { name: 'Resume Manual.pdf' }).click();
	await expect(page).toHaveURL('/read/21/32');
});

test('sorts only within groups and does not overflow a narrow viewport', async ({ page }) => {
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
	await page.getByLabel('Sort files').selectOption('name');
	await expect.poll(labels).toEqual([`Select ${longName}`, 'Select M.mobi', 'Select Z.epub']);
	await page.getByLabel('Sort files').selectOption('size');
	await expect.poll(labels).toEqual(['Select Z.epub', 'Select M.mobi', `Select ${longName}`]);
	await page.getByLabel('Sort files').selectOption('added');
	await expect.poll(labels).toEqual(['Select M.mobi', 'Select Z.epub', `Select ${longName}`]);
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
	await expect(panel(page).getByRole('link', { name: 'Read Archive.zip' })).toHaveCount(0);
	await expect(panel(page).getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/api/v1/books/21/files/36?v=${hash}`);

	state.progress = makeProgress(31, 0, 2);
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 21 } })));
	await expect(group(page, 'Ebook').getByText('0% read')).toBeVisible();
	await page.getByRole('button', { name: 'Select A.epub' }).click();
	await expect(panel(page)).toContainText('You are 0% through this copy');
	await expect(panel(page).getByRole('link', { name: 'Resume A.epub' })).toHaveAttribute('href', '/read/21/31');
});

test('supports clipboard and keyboard-operated file menus', async ({ page, context }) => {
	await setup(page);
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.goto('/books/21/files');
	await expect(panel(page).getByRole('heading', { name: 'Manual.pdf' })).toBeVisible();
	await panel(page).getByRole('button', { name: 'Copy file name: Manual.pdf' }).click();
	await expect(page.getByText('File name copied.')).toBeVisible();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Manual.pdf');

	const trigger = panel(page).getByRole('button', { name: 'Actions for Manual.pdf' });
	await trigger.focus();
	await page.keyboard.press('ArrowDown');
	await expect(panel(page).getByRole('menuitem', { name: 'Download' })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(panel(page).getByRole('menuitem', { name: 'Save for offline' })).toBeFocused();
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
	await panel(page).getByRole('button', { name: 'Actions for A.epub' }).click();
	await panel(page).getByRole('menuitem', { name: 'Remove offline copy' }).click();
	expect(await storedRows(page, 'files')).toHaveLength(2);
	await expect(panel(page)).toContainText('Offline');

	page.once('dialog', (dialog) => void dialog.accept());
	await panel(page).getByRole('button', { name: 'Actions for A.epub' }).click();
	await panel(page).getByRole('menuitem', { name: 'Remove offline copy' }).click();
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
	await panel(page).getByRole('button', { name: 'Actions for Manual.pdf' }).click();
	await panel(page).getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect.poll(() => state.releaseFile !== null).toBe(true);
	await expect(page.getByText('Downloading for offline…')).toBeVisible();
	await expect(panel(page).getByRole('button', { name: 'Actions for Manual.pdf' })).toBeDisabled();
	state.releaseFile?.();
	await expect(page.getByRole('alert').filter({ hasText: 'Could not download this file for offline reading.' })).toBeVisible();

	state.fileStatus = 200;
	await saveFromPanel(page, 'Manual.pdf');
	await page.getByRole('button', { name: 'Select A.epub' }).click();
	state.fileStatus = 403;
	await panel(page).getByRole('button', { name: 'Actions for A.epub' }).click();
	await panel(page).getByRole('menuitem', { name: 'Save for offline' }).click();
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
	await panel(page).getByRole('button', { name: 'Actions for Multi-format Book.pdf' }).click();
	await panel(page).getByRole('menuitem', { name: 'Remove offline copy' }).click();
	await expect(page.getByRole('alert')).toContainText('This book or file is not available offline.');
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
	await expect(panel(page).getByRole('link', { name: 'Download' })).toBeVisible();
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
