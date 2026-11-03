import { expect, test, type Frame, type Page, type Route } from '@playwright/test';
import { azw3Fixture, cbzFixture, epubFixture, fb2Fixture, fbzFixture, mobiFixture, pdfFixture } from '../../lib/reader/fixtures';

type TestMutation = {
	entity: string;
	id?: string;
	key?: string;
	op: string;
	data: Record<string, unknown>;
	updated_at: number;
};

interface MockState {
	rev: number;
	progress: Record<string, unknown> | null;
	highlights: Record<string, unknown>[];
	notes: Record<string, unknown>[];
	settings: Array<{ key: string; value: unknown; updated_at: string; rev: number }>;
	mutations: TestMutation[];
	attempts: TestMutation[];
	failingPushes: number;
}

const hash = 'a'.repeat(64);

async function setupReader(
	page: Page,
	format: string,
	content: Buffer,
	options: { locale?: string; initialProgress?: Record<string, unknown> | null; alternateFile?: boolean } = {}
): Promise<MockState> {
	const state: MockState = {
		rev: 1,
		progress: options.initialProgress ?? null,
		highlights: [],
		notes: [],
		settings: [
			{ key: `reader.${format}`, value: { font: 'serif' }, updated_at: '2026-11-03T00:00:00Z', rev: 1 },
			{ key: 'reader.book.21', value: { futureOption: { keep: true } }, updated_at: '2026-11-03T00:00:00Z', rev: 1 }
		],
		mutations: [],
		attempts: [],
		failingPushes: 0
	};
	const file = { id: 31, format, size_bytes: content.length, download_url: `/api/v1/books/21/files/31?v=${hash}` };
	const book = {
		id: 21, library_id: 1, title: 'Fixture Book', sort_title: 'Fixture Book', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file, ...(options.alternateFile ? [{ ...file, id: 32, download_url: `/api/v1/books/21/files/32?v=${hash}` }] : [])],
		field_sources: [], created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
	};
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) => route.fulfill({
		json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: options.locale ?? 'en' } }
	}));
	await page.route('**/api/v1/books?*', (route) => route.fulfill({ json: { items: [book], next_cursor: null } }));
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book } }));
	await page.route('**/api/v1/books/21/files/*?*', (route) => route.fulfill({
		status: 200, contentType: 'application/octet-stream', body: content
	}));
	await page.route('**/api/v1/me/books/21', (route) => route.fulfill({
		json: { user_book: null, progress: state.progress, highlights: state.highlights, notes: state.notes }
	}));
	await page.route('**/api/v1/me/settings', (route) => route.fulfill({ json: { settings: state.settings } }));
	await page.route('**/api/v1/sync/pull?*', (route) => {
		const cursor = Number(new URL(route.request().url()).searchParams.get('cursor'));
		const newer = (row: Record<string, unknown>) => Number(row.rev) > cursor;
		return route.fulfill({ json: {
			cursor: state.rev, user_books: [],
			reading_progress: state.progress && newer(state.progress) ? [{ ...state.progress, book_id: 21 }] : [],
			highlights: state.highlights.filter(newer), notes: state.notes.filter(newer),
			user_settings: state.settings.filter(newer)
		} });
	});
	await page.route('**/api/v1/sync/push', async (route) => {
		const request = route.request().postDataJSON() as { mutations: TestMutation[] };
		state.attempts.push(...request.mutations);
		if (state.failingPushes > 0) {
			state.failingPushes -= 1;
			await route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ status: 503, title: 'Unavailable' }) });
			return;
		}
		for (const mutation of request.mutations) {
			state.rev += 1;
			state.mutations.push(mutation);
			const now = new Date(mutation.updated_at).toISOString();
			if (mutation.entity === 'reading_progress') {
				state.progress = { ...mutation.data, updated_at: now, rev: state.rev };
			} else if (mutation.entity === 'highlights') {
				if (mutation.op === 'delete') {
					state.highlights = state.highlights.filter((item) => item.id !== mutation.id);
					state.notes = state.notes.filter((item) => item.highlight_id !== mutation.id);
				} else {
					const old = state.highlights.find((item) => item.id === mutation.id);
					state.highlights = [
						...state.highlights.filter((item) => item.id !== mutation.id),
						{ ...mutation.data, id: mutation.id, created_at: old?.created_at ?? now, updated_at: now, deleted_at: null, rev: state.rev }
					];
				}
			} else if (mutation.entity === 'notes') {
				if (mutation.op === 'delete') {
					state.notes = state.notes.filter((item) => item.id !== mutation.id);
				} else {
					const old = state.notes.find((item) => item.id === mutation.id);
					state.notes = [
						...state.notes.filter((item) => item.id !== mutation.id),
						{ ...mutation.data, id: mutation.id, created_at: old?.created_at ?? now, updated_at: now, deleted_at: null, rev: state.rev }
					];
				}
			} else if (mutation.entity === 'user_settings') {
				state.settings = [
					...state.settings.filter((item) => item.key !== mutation.key),
					{ key: mutation.key ?? '', value: mutation.data.value, updated_at: now, rev: state.rev }
				];
			}
		}
		await route.fulfill({ json: { results: request.mutations.map((_, index) => ({ index, status: 'applied' })) } });
	});
	return state;
}

async function useProductionCsp(page: Page) {
	await page.route('**/read/21/31', async (route) => {
		const response = await route.fetch();
		const headers = response.headers();
		delete headers['content-length'];
		headers['content-security-policy'] =
			"default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'nonce-test-reader'; " +
			"style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; " +
			"media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; " +
			"object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
		const html = (await response.text()).replace('<script>', '<script nonce="test-reader">');
		await route.fulfill({ response, headers, body: html });
	});
}

async function bookFrame(page: Page, text?: string): Promise<Frame> {
	let frame: Frame | undefined;
	await expect(async () => {
		frame = undefined;
		for (const candidate of page.frames().filter((item) => item.url().startsWith('blob:'))) {
			if (!text || await candidate.getByText(text, { exact: true }).count()) {
				frame = candidate;
				break;
			}
		}
		expect(frame).toBeDefined();
	}).toPass({ timeout: 5000 });
	if (!frame) throw new Error('Book frame was not created.');
	return frame;
}

test('isolates EPUB scripts and round-trips progress, highlights, notes and settings', async ({ page }) => {
	const state = await setupReader(page, 'epub', epubFixture());
	await useProductionCsp(page);
	let externalScriptRequests = 0;
	await page.route('**/evil.js', async (route) => {
		externalScriptRequests += 1;
		await route.fulfill({ contentType: 'text/javascript', body: 'window.top.__epubExternal = true' });
	});
	await page.addInitScript(() => {
		const original = EventTarget.prototype.dispatchEvent;
		EventTarget.prototype.dispatchEvent = function (event) {
			if (event.type === 'draw-annotation') {
				const host = window as Window & { __readerDraws?: number };
				host.__readerDraws = (host.__readerDraws ?? 0) + 1;
			}
			return original.call(this, event);
		};
	});
	page.on('dialog', (dialog) => dialog.accept());
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/read/21/31');
	await expect(page.getByRole('heading', { name: 'Fixture Book' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
	let frame = await bookFrame(page);
	await expect(frame.locator('#passage')).toBeVisible();
	const isolation = await frame.evaluate(() => {
		const passage = document.querySelector('#passage');
		passage?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		passage?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return {
			scripts: document.querySelectorAll('script, iframe, object, embed').length,
			handlers: Array.from(document.querySelectorAll('*')).flatMap((element) =>
				Array.from(element.attributes).filter((attribute) => attribute.name.toLowerCase().startsWith('on'))
			).length,
			policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')
		};
	});
	expect(isolation.scripts).toBe(0);
	expect(isolation.handlers).toBe(0);
	expect(isolation.policy).toContain("script-src 'none'");
	expect(externalScriptRequests).toBe(0);
	expect(await page.evaluate(() => {
		const host = window as Window & {
			__epubInline?: boolean; __epubExternal?: boolean; __epubClick?: boolean;
			__epubHover?: boolean; __epubLoad?: boolean; __epubLink?: boolean;
		};
		return [host.__epubInline, host.__epubExternal, host.__epubClick, host.__epubHover, host.__epubLoad, host.__epubLink].some(Boolean);
	})).toBe(false);
	const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
	expect(widths.content).toBeLessThanOrEqual(widths.viewport);

	await frame.evaluate(() => {
		const passage = document.querySelector('#passage');
		if (!passage) throw new Error('Missing passage');
		const range = document.createRange();
		range.selectNodeContents(passage);
		const selected = window.getSelection();
		selected?.removeAllRanges();
		selected?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	});
	await expect(page.getByText('A passage worth highlighting.')).toBeVisible();
	await page.getByRole('button', { name: 'Highlight selection' }).click();
	await expect.poll(() => state.highlights.length).toBe(1);
	const highlight = page.locator('blockquote').filter({ hasText: 'A passage worth highlighting.' }).locator('..');
	await highlight.getByRole('button', { name: 'Add note to highlight' }).click();
	await page.getByRole('textbox', { name: 'Note in Markdown' }).fill('**Keep this** <img src=x onerror="window.top.__noteAttack=true"><script>window.top.__noteAttack=true</script>');
	await expect(page.locator('.reader-note-preview strong')).toHaveText('Keep this');
	await expect(page.locator('.reader-note-preview img, .reader-note-preview script')).toHaveCount(0);
	await page.getByRole('button', { name: 'Save note' }).click();
	await expect.poll(() => state.notes.length).toBe(1);
	await page.getByRole('button', { name: 'Add book note' }).click();
	await page.getByRole('textbox', { name: 'Note in Markdown' }).fill('Book-level note');
	await page.getByRole('button', { name: 'Save note' }).click();
	await expect.poll(() => state.notes.length).toBe(2);
	await highlight.getByLabel('Highlight color').selectOption('blue');
	await expect.poll(() => state.highlights[0]?.color).toBe('blue');

	await page.getByText('Reader settings', { exact: true }).click();
	await page.getByRole('combobox', { name: 'Font', exact: true }).selectOption('sans-serif');
	await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect.poll(() => state.settings.find((setting) => setting.key === 'reader.book.21')?.value).toMatchObject({
		font: 'sans-serif', theme: 'dark', futureOption: { keep: true }
	});

	await page.getByRole('button', { name: 'Next page' }).click();
	await page.getByRole('slider', { name: 'Reading position' }).evaluate((element: HTMLInputElement) => {
		element.value = '1000';
		element.dispatchEvent(new Event('change', { bubbles: true }));
	});
	frame = await bookFrame(page, 'Second section');
	await expect(frame.getByText('Second section')).toBeVisible();
	await expect.poll(() => state.progress?.book_file_id).toBe(31);
	await expect.poll(() => state.progress?.source).toBe('web');
	await expect.poll(() => state.progress?.percentage).toBeGreaterThan(0.9);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
	frame = await bookFrame(page, 'Second section');
	await expect(frame.getByText('Second section')).toBeVisible();
	await expect(page.locator('.reader-markdown strong')).toHaveText('Keep this');
	await expect(page.getByText('Book-level note')).toBeVisible();
	await expect(page.locator('.reader-markdown img, .reader-markdown script')).toHaveCount(0);
	await page.getByRole('button', { name: 'Go to highlight' }).click();
	await expect.poll(() => page.evaluate(() => (window as Window & { __readerDraws?: number }).__readerDraws ?? 0)).toBeGreaterThan(0);
	await highlight.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('textbox', { name: 'Note in Markdown' }).fill('Edited note');
	await page.getByRole('button', { name: 'Save note' }).click();
	await expect.poll(() => state.notes.find((note) => note.highlight_id !== null)?.body_md).toBe('Edited note');
	await highlight.getByRole('button', { name: 'Delete', exact: true }).last().click();
	await expect.poll(() => state.notes.length).toBe(1);
	await expect(highlight.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(1);
	await highlight.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(0);
	expect(await page.evaluate(() => (window as Window & { __noteAttack?: boolean }).__noteAttack)).toBeUndefined();
	expect(externalScriptRequests).toBe(0);
});

test('opens PDF, restores its page and persists selectable highlights', async ({ page }) => {
	const state = await setupReader(page, 'pdf', pdfFixture(), {
		initialProgress: {
			book_file_id: 31, source: 'web', locator: { type: 'pdf', page: 2 }, percentage: 1,
			device: 'PandaLibrary Web', device_id: 'other', updated_at: '2026-11-03T00:00:00Z', rev: 1
		}
	});
	await useProductionCsp(page);
	await page.goto('/read/21/31');
	await expect(page.getByRole('button', { name: 'Previous page' })).toBeEnabled();
	await expect(page.locator('.reader-pdf-text')).toContainText('Second PDF page text');
	await page.evaluate(() => {
		const span = document.querySelector('.reader-pdf-text span');
		if (!span) throw new Error('Missing PDF text layer');
		const range = document.createRange();
		range.selectNodeContents(span);
		const selected = window.getSelection();
		selected?.removeAllRanges();
		selected?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	});
	await expect(page.getByText('Second PDF page text', { exact: true }).last()).toBeVisible();
	await page.getByRole('button', { name: 'Highlight selection' }).click();
	await expect.poll(() => state.highlights.length).toBe(1);
	await expect(page.locator('.reader-pdf-highlight')).toHaveCount(1);
	await page.reload();
	await expect(page.locator('.reader-pdf-text')).toContainText('Second PDF page text');
	await expect(page.locator('.reader-pdf-highlight')).toHaveCount(1);
});

for (const [format, fixture] of [
	['mobi', mobiFixture],
	['azw3', azw3Fixture],
	['fb2', fb2Fixture],
	['fbz', fbzFixture],
	['cbz', cbzFixture]
] as const) {
	test(`opens a generated ${format.toUpperCase()} book through Foliate`, async ({ page }) => {
		const state = await setupReader(page, format, fixture(), format === 'fb2' ? {
			initialProgress: {
				book_file_id: null, source: 'koreader', locator: null, percentage: 1,
				device: 'KOReader', device_id: 'other', updated_at: '2026-11-03T00:00:00Z', rev: 1
			}
		} : {});
		await useProductionCsp(page);
		await page.goto('/read/21/31');
		await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
		const frame = await bookFrame(page);
		if (format === 'cbz') {
			await expect(frame.locator('img')).toBeVisible();
			await page.getByRole('button', { name: 'Highlight current page' }).click();
			await expect.poll(() => state.highlights.length).toBe(1);
			await page.reload();
			await expect(page.getByText('Highlighted page')).toBeVisible();
		} else {
			await expect(frame.getByText('A passage worth highlighting.')).toBeVisible();
			if (format === 'mobi') await expect(frame.getByRole('link', { name: 'Start' })).toHaveAttribute('href', 'filepos:0');
			if (format === 'azw3') await expect(frame.getByRole('link', { name: 'Start' })).toHaveAttribute('href', 'kindle:pos:fid:0000:off:0000000000');
		}
	});
}

test('offers a localized reader entry point', async ({ page }) => {
	await setupReader(page, 'fb2', fb2Fixture(), { locale: 'zh' });
	await page.goto('/read');
	await expect(page.getByRole('heading', { name: '选择要阅读的图书' })).toBeVisible();
	await page.getByRole('link', { name: '阅读 FB2' }).click();
	await expect(page.getByRole('button', { name: '下一页' })).toBeEnabled();
});

test('retains failed progress across file changes and retries every unsaved writer', async ({ page }) => {
	const state = await setupReader(page, 'fb2', fb2Fixture(), { alternateFile: true });
	state.failingPushes = 100;
	await page.goto('/read/21/31');
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Retry unsaved changes' })).toBeVisible();
	await page.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/read/21/32';
		link.textContent = 'Alternate file';
		document.querySelector('main')?.append(link);
	});
	await page.getByRole('link', { name: 'Alternate file' }).click();
	await expect(page).toHaveURL('/read/21/32');
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
	await expect.poll(() => state.attempts.some((mutation) => mutation.data.book_file_id === 32)).toBe(true);
	state.failingPushes = 0;
	await page.getByRole('button', { name: 'Retry unsaved changes' }).click();
	await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
	expect(state.mutations.some((mutation) => mutation.data.book_file_id === 31)).toBe(true);
	expect(state.mutations.some((mutation) => mutation.data.book_file_id === 32)).toBe(true);
});

test('counts active reading time and flushes a session on deliberate close', async ({ page }) => {
	await page.clock.install();
	const state = await setupReader(page, 'fb2', fb2Fixture());
	await page.goto('/read/21/31');
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
	await page.clock.fastForward(31_000);
	await page.getByRole('button', { name: 'Close reader' }).click();
	await expect(page).toHaveURL('/books/21');
	const sessions = state.mutations.filter((mutation) => mutation.entity === 'reading_sessions');
	expect(sessions).toHaveLength(1);
	expect(sessions[0].data).toMatchObject({ book_id: 21, source: 'web', device: 'PandaLibrary Web' });
	expect(sessions[0].data.active_seconds).toBeGreaterThanOrEqual(31);
});

test('shows an API error and opens the book after retry', async ({ page }) => {
	await setupReader(page, 'fb2', fb2Fixture());
	const fail = (route: Route) => route.fulfill({ status: 503, json: { title: 'Unavailable', status: 503 } });
	await page.route('**/api/v1/books/21', fail);
	await page.goto('/read/21/31');
	await expect(page.getByRole('alert')).toContainText('The reader request failed. Please try again.');
	await page.unroute('**/api/v1/books/21', fail);
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
});

test('reports missing files and unsupported formats without downloading them', async ({ page }) => {
	await setupReader(page, 'txt', Buffer.from('Not a supported format'));
	let downloads = 0;
	page.on('request', (request) => { if (request.url().includes('/files/')) downloads += 1; });
	await page.goto('/read/21/99');
	await expect(page.getByRole('alert')).toContainText('This file is unavailable for the selected book.');
	await page.goto('/read/21/31');
	await expect(page.getByRole('alert')).toContainText('This file format is not supported');
	expect(downloads).toBe(0);
});
