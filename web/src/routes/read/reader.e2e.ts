import { expect, test, type Frame, type Page, type Route } from '@playwright/test';
import type { View } from 'foliate-js/view.js';
import { azw3Fixture, cbzFixture, epubFixture, fb2Fixture, fbzFixture, mobiFixture, pdfFixture } from '../../lib/reader/fixtures';
import { pdfPageBox, pdfPageText } from '../../lib/real-pdf.js';
import axe from 'axe-core';
import { BACKGROUNDS } from '../../lib/reader/appearance.js';
import { resolve } from 'node:path';

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
// Reader position changes are saved on a 10 second interval; only the opening position is immediate.
const PROGRESS_SAVE = { timeout: 15_000 };

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
			{ key: `reader.${format}`, value: { font: 'serif', ...(format === 'pdf' ? { pdfLayout: 'single', pdfZoom: 'page-width' } : {}) }, updated_at: '2026-11-03T00:00:00Z', rev: 1 },
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
		delete headers['content-encoding'];
		const source = await response.text();
		const nonce = source.match(/<script[^>]*\bnonce="([^"]+)"/)?.[1] ?? 'test-reader';
		const html = source.replace('<script>', `<script nonce="${nonce}">`);
		headers['content-security-policy'] =
			`default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'nonce-${nonce}'; ` +
			"style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; " +
			"media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; " +
			"object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
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

async function expectReaderToolbarFits(page: Page) {
	const toolbar = page.locator('.pv4-toolbar');
	await expect(toolbar).toHaveCSS('height', '44px');
	expect(await toolbar.evaluate((element) => {
		const viewport = { width: document.documentElement.clientWidth, height: window.innerHeight };
		const toolbar = element.getBoundingClientRect();
		return Array.from(element.querySelectorAll('button')).flatMap((button) => {
			if (!button.getClientRects().length) return [];
			const box = button.getBoundingClientRect();
			return box.left >= 0 && box.right <= viewport.width && box.top >= 0 &&
				box.bottom <= viewport.height && box.top >= toolbar.top && box.bottom <= toolbar.bottom
				? [] : [{ label: button.getAttribute('aria-label') ?? button.textContent, x: box.x, y: box.y, width: box.width, height: box.height }];
		});
	})).toEqual([]);
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
	await expect(page).toHaveTitle('Fixture Book · PandaLibrary');
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
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
	await expect(page.getByText('A passage worth highlighting.')).toBeVisible();
	await page.getByRole('button', { name: 'Highlight selection' }).click();
	await expect.poll(() => state.highlights.length).toBe(1);
	const highlight = page.locator('.rp7-entry').filter({ hasText: 'A passage worth highlighting.' });
	await highlight.locator('.rp7-edit').click();
	await page.getByRole('dialog').getByRole('button', { name: 'Add note to highlight' }).click();
	const comment = '**Keep this** <img src=x onerror="window.top.__noteAttack=true"><script>window.top.__noteAttack=true</script>';
	await page.getByRole('textbox', { name: 'Comment', exact: true }).fill(comment);
	await expect(page.locator('.reader-note-preview')).toHaveCount(0);
	await page.getByRole('button', { name: 'Save note' }).click();
	await expect.poll(() => state.notes.length).toBe(1);
	await expect(page.getByRole('button', { name: 'Add book note' })).toHaveCount(0);
	await page.getByRole('dialog').getByLabel('Highlight color').selectOption('blue');
	await expect.poll(() => state.highlights[0]?.color).toBe('blue');
	await page.getByRole('button', { name: 'Close annotation details' }).click();

	await page.getByRole('button', { name: 'More view options' }).click();
	await page.getByRole('menuitem', { name: 'Format', exact: true }).click();
	await page.getByRole('radio', { name: 'Sans', exact: true }).click();
	await page.getByRole('radio', { name: 'Night', exact: true }).click();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect.poll(() => state.settings.find((setting) => setting.key === 'reader.book.21')?.value).toMatchObject({
		font: 'sans-serif', theme: 'dark', background: 'night', futureOption: { keep: true }
	});
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Collapse sidebar' }).click();

	await page.getByRole('button', { name: 'Next page' }).click();
	await page.getByRole('slider', { name: 'Reading position' }).evaluate((element: HTMLInputElement) => {
		element.value = '1000';
		element.dispatchEvent(new Event('change', { bubbles: true }));
	});
	frame = await bookFrame(page, 'Second section');
	await expect(frame.getByText('Second section')).toBeVisible();
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
	await expect.poll(() => state.progress?.book_file_id).toBe(31);
	await expect.poll(() => state.progress?.source).toBe('web');
	await expect.poll(() => state.progress?.percentage, PROGRESS_SAVE).toBeGreaterThan(0.9);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
	frame = await bookFrame(page, 'Second section');
	await expect(frame.getByText('Second section')).toBeVisible();
	const annotationsTab = page.getByRole('tab', { name: 'Annotations', exact: true });
	if (await annotationsTab.getAttribute('aria-selected') !== 'true') await annotationsTab.click();
	await expect(highlight.locator('.rp7-comment')).toContainText('**Keep this**');
	await expect(page.getByText('Book-level note')).toHaveCount(0);
	await expect(highlight.locator('img, script, strong')).toHaveCount(0);
	await highlight.locator('[data-panel-jump]').click();
	await expect.poll(() => page.evaluate(() => (window as Window & { __readerDraws?: number }).__readerDraws ?? 0)).toBeGreaterThan(0);
	if (await annotationsTab.getAttribute('aria-selected') !== 'true') await annotationsTab.click();
	await highlight.locator('.rp7-edit').click();
	await expect(page.getByRole('dialog').getByText(comment, { exact: true })).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Edited note');
	await page.getByRole('button', { name: 'Save note' }).click();
	await expect.poll(() => state.notes.find((note) => note.highlight_id !== null)?.body_md).toBe('Edited note');
	await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
	await expect.poll(() => state.notes.length).toBe(0);
	await page.getByRole('button', { name: 'Close annotation details' }).click();
	await highlight.locator('[data-rp7-delete]').click();
	await highlight.locator('[data-rp7-delete]').click();
	await expect.poll(() => state.highlights.length).toBe(0);
	expect(await page.evaluate(() => (window as Window & { __noteAttack?: boolean }).__noteAttack)).toBeUndefined();
	expect(externalScriptRequests).toBe(0);
});

test('opens PDF, restores its page and paints persisted selectable highlights', async ({ page }) => {
	const state = await setupReader(page, 'pdf', pdfFixture(), {
		initialProgress: {
			book_file_id: 31, source: 'web', locator: { type: 'pdf', page: 2 }, percentage: 1,
			device: 'PandaLibrary Web', device_id: 'other', updated_at: '2026-11-03T00:00:00Z', rev: 1
		}
	});
	state.highlights = [{
		id: 'pdf-highlight', book_id: 21, book_file_id: 31,
		locator: { type: 'pdf', page: 2, rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }] },
		position: 1, text: 'Second PDF page text', color: 'yellow', chapter: null,
		created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z', deleted_at: null, rev: 1
	}];
	await useProductionCsp(page);
	await page.goto('/read/21/31');
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
	await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Second PDF page text');
	await expect(page.locator('.reader-pdf-highlight')).toHaveCount(1);
	await page.reload();
	await expect(page.locator('.reader-pdf-text')).toContainText('Second PDF page text');
	await expect(page.locator('.reader-pdf-highlight')).toHaveCount(1);
});

test('PDF layouts, zoom, rotation and exact 10.05% progress round-trip', async ({ page }) => {
	test.setTimeout(120_000);
	const state = await setupReader(page, 'pdf', pdfFixture(200), {
		initialProgress: {
			book_file_id: 31, source: 'web', locator: { type: 'pdf', page: 21 }, percentage: 20 / 199,
			device: 'PandaLibrary Web', device_id: 'other', updated_at: '2026-11-03T00:00:00Z', rev: 1
		}
	});
	await page.goto('/read/21/31');
	const surface = page.locator('.reader-pdf');
	const progress = page.locator('.pv-frame-toolbar');
	await expect(progress).toContainText('10.05%');
	await expect(pdfPageText(page, 21)).toContainText('Page 21 PDF page text');
	// Exercise persisted engine settings independently of the toolbar.
	async function settings(patch: Record<string, unknown>) {
		const previous = state.settings.find((setting) => setting.key === 'reader.book.21')?.value;
		state.rev += 1;
		state.settings = [
			...state.settings.filter((setting) => setting.key !== 'reader.book.21'),
			{ key: 'reader.book.21', value: { ...(previous as Record<string, unknown>), ...patch }, updated_at: new Date().toISOString(), rev: state.rev }
		];
		await page.reload();
		await expect(page.locator('.reader-pdf-page[data-page="21"] .reader-pdf-text')).toContainText('Page 21 PDF page text');
	}
	// pdf.js scale 1 is 4/3 CSS px per point: a 612 pt page is 816 px wide at actual size.
	const pageWidth = () => page.locator('.reader-pdf-page[data-page="21"]').evaluate((element) => element.getBoundingClientRect().width);

	await settings({ pdfZoom: 'page-actual' });
	await expect.poll(pageWidth).toBeCloseTo(816, 0);
	await settings({ pdfZoom: 1.375 });
	await expect.poll(pageWidth).toBeCloseTo(1122, 0);
	await settings({ pdfRotation: 90 });
	await expect.poll(pageWidth).toBeCloseTo(1452, 0);
	await settings({ pdfRotation: 180 });
	await expect.poll(pageWidth).toBeCloseTo(1122, 0);
	await settings({ pdfRotation: 270 });
	await expect.poll(pageWidth).toBeCloseTo(1452, 0);
	await settings({ pdfRotation: 0, pdfZoom: 'page-fit' });
	await expect.poll(async () => page.locator('.reader-pdf-page').evaluate((element) =>
		element.getBoundingClientRect().height <= (element.closest('.reader-pdf')?.clientHeight ?? 0) + 1
	)).toBe(true);
	await settings({ pdfZoom: 'auto' });
	await expect.poll(pageWidth).toBeGreaterThan(0);
	await settings({ pdfZoom: 'page-width', pdfLayout: 'split' });
	await expect(surface).toHaveAttribute('data-layout', 'split');
	await expect(page.locator('.reader-pdf-page')).toHaveCount(2);
	await expect(page.locator('.reader-pdf-page').first()).toHaveAttribute('data-page', '21');
	await expect(page.locator('.reader-pdf-page').last()).toHaveAttribute('data-page', '22');
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.locator('.reader-pdf-page').first()).toHaveAttribute('data-page', '23');
	await expect.poll(() => state.progress?.locator, PROGRESS_SAVE).toMatchObject({ type: 'pdf', page: 23 });
	await page.keyboard.press('ArrowLeft');
	await expect(progress).toContainText('10.05%');
	await expect.poll(() => state.progress?.locator, PROGRESS_SAVE).toMatchObject({ type: 'pdf', page: 21 });

	for (const value of ['single-continuous', 'split-continuous']) {
		await settings({ pdfLayout: value });
		await expect(surface).toHaveAttribute('data-layout', value);
		await expect(page.locator('.reader-pdf-page')).toHaveCount(200);
		await expect(progress).toContainText('10.05%');
		await expect.poll(() => page.locator('.reader-pdf-page canvas').count()).toBeLessThan(12);
		await surface.evaluate((element) => {
			const target = element.querySelector<HTMLElement>('.reader-pdf-page[data-page="41"]');
			if (!target) throw new Error('Missing scroll target');
			element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop;
		});
		await expect(progress).toContainText('20.10%');
		await expect(page.locator('.reader-pdf-page[data-page="41"] .reader-pdf-text')).toContainText('Page 41 PDF page text');
		await expect.poll(() => state.progress?.locator, PROGRESS_SAVE).toMatchObject({ type: 'pdf', page: 41 });
		await pdfPageBox(page).fill('21');
		await pdfPageBox(page).press('Enter');
		await expect(progress).toContainText('10.05%');
		await expect.poll(() => state.progress?.locator, PROGRESS_SAVE).toMatchObject({ type: 'pdf', page: 21 });
		await page.reload();
		await expect(progress).toContainText('10.05%');
	}
	await settings({ pdfLayout: 'single', pdfRotation: 90, pdfZoom: 1.375 });
	await expect(page.locator('.reader-pdf-page')).toHaveCount(1);
	await expect.poll(() => state.settings.find((setting) => setting.key === 'reader.book.21')?.value).toMatchObject({
		futureOption: { keep: true }, pdfLayout: 'single', pdfZoom: 1.375, pdfRotation: 90
	});
	await page.reload();
	await expect(progress).toContainText('10.05%');
	await expect.poll(pageWidth).toBeCloseTo(1452, 0);
	await expect.poll(() => state.progress?.locator).toMatchObject({ type: 'pdf', page: 21 });
});

test('PDF ignores retired cover-alone settings and odd spreads retain every page', async ({ page }) => {
	const state = await setupReader(page, 'pdf', pdfFixture(5));
	state.settings.push({ key: 'reader.book.21', value: { pdfLayout: 'split', pdfCoverAlone: true }, updated_at: new Date().toISOString(), rev: ++state.rev });
	state.settings = state.settings.filter((setting) => setting.key !== 'reader.book.21' || setting.rev === state.rev);
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await expect(page.locator('.reader-pdf-page')).toHaveCount(2);
	await page.locator('#reader-surface').focus();
	for (const first of [3, 5]) {
		await page.keyboard.press('ArrowRight');
		await expect(page.locator('.reader-pdf-page').first()).toHaveAttribute('data-page', String(first));
		await expect(page.locator('.reader-pdf-page')).toHaveCount(first === 5 ? 1 : 2);
	}
	await page.keyboard.press('ArrowLeft');
	await expect(page.locator('.reader-pdf-page').first()).toHaveAttribute('data-page', '3');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('Page 3 PDF page text');
	await page.keyboard.press('Home');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await expect.poll(() => state.progress?.locator, PROGRESS_SAVE).toMatchObject({ type: 'pdf', page: 1 });
	state.settings = [{ key: 'reader.book.21', value: { pdfLayout: 'split', pdfCoverAlone: false }, updated_at: new Date().toISOString(), rev: ++state.rev }];
	await page.reload();
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await expect(page.locator('.reader-pdf-page')).toHaveCount(1);
	await expect(page.locator('.reader-pdf-page')).toHaveAttribute('data-page', '5');
	await expect(page.locator('.pv-frame-toolbar')).toContainText('100.00%');
});

test('RP9 PDF Format applies all backgrounds, persists, and folds into mobile overflow', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const state = await setupReader(page, 'pdf', pdfFixture(2));
	state.settings[1].value = { theme: 'dark', pdfCoverAlone: true, futureOption: { keep: true } };
	await page.goto('/read/21/31');
	const surface = page.locator('#reader-surface');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await expect(surface).toHaveAttribute('data-background', 'night');
	await expect(surface).toHaveAttribute('data-tone', 'dark');
	const format = page.getByRole('button', { name: 'Format', exact: true });
	const display = page.getByRole('button', { name: 'Page display', exact: true });
	const displayBox = await display.boundingBox();
	const formatBox = await format.boundingBox();
	expect(formatBox!.x).toBeGreaterThanOrEqual(displayBox!.x + displayBox!.width);
	await display.click();
	await expect(page.getByRole('menuitemradio')).toHaveCount(4);
	await expect(page.getByRole('menuitemcheckbox')).toHaveCount(1);
	await page.keyboard.press('Escape');
	const labels = ['White', 'Cream', 'Sepia', 'Eye-care green', 'Wood', 'Gray', 'Sky', 'Blush', 'Night', 'Black'];
	for (const [index, preset] of BACKGROUNDS.entries()) {
		await format.click();
		const dialog = page.getByRole('dialog', { name: 'Format', exact: true });
		await expect(dialog.getByRole('radiogroup')).toHaveCount(1);
		await dialog.getByRole('radio', { name: labels[index], exact: true }).click();
		await expect(surface).toHaveAttribute('data-background', preset.id);
		await expect(surface).toHaveAttribute('data-tone', preset.tone);
		await expect(page.locator('.reader-pdf-page canvas').first()).toHaveCSS('filter',
			preset.tone === 'dark' ? 'invert(1) hue-rotate(180deg)' : 'none');
		await expect(page.locator('.reader-pdf-page canvas').first()).toHaveCSS('mix-blend-mode',
			preset.tone === 'dark' ? 'screen' : 'multiply');
		await expect(surface).toHaveCSS('background-color',
			preset.tone === 'dark' ? 'rgb(24, 24, 27)' : 'rgb(226, 232, 240)');
		await page.keyboard.press('Escape');
		const screenshot = resolve('..', 'docs', 'dev', 'plans', 'assets', 'rp9', `pdf-${preset.id}.png`);
		await surface.screenshot({ path: screenshot, animations: 'disabled' });
		await testInfo.attach(`PDF ${preset.id}`, { path: screenshot, contentType: 'image/png' });
	}
	await format.click();
	await page.getByRole('radio', { name: 'Eye-care green', exact: true }).click();
	await page.addScriptTag({ content: axe.source });
	const violations = await page.evaluate(async () => {
		const result = await (window as Window & { axe: typeof axe }).axe.run('[role="dialog"][aria-label="Format"]');
		return result.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ html, failureSummary }) => ({ html, failureSummary })) }));
	});
	expect(violations).toEqual([]);
	await page.keyboard.press('Escape');
	for (const key of ['reader.book.21', 'reader.pdf']) {
		await expect.poll(() => state.settings.find((setting) => setting.key === key)?.value)
			.toMatchObject({ background: 'green', theme: 'light' });
	}
	await expect.poll(() => state.settings.find((setting) => setting.key === 'reader.book.21')?.value)
		.toMatchObject({ pdfCoverAlone: true, futureOption: { keep: true } });
	await page.reload();
	await expect(surface).toHaveAttribute('data-background', 'green');
	await expect(page.locator('.reader-pdf-text').first()).toContainText('First PDF page text');
	await page.setViewportSize({ width: 375, height: 812 });
	await expect(format).not.toBeVisible();
	await page.getByRole('button', { name: 'More view options' }).click();
	await page.getByRole('menuitem', { name: 'Format', exact: true }).click();
	await page.getByRole('radio', { name: 'Night', exact: true }).click();
	await expect(surface).toHaveAttribute('data-background', 'night');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
});

test('RP9 EPUB Format changes live typography and background and saves both scopes', async ({ page }) => {
	const state = await setupReader(page, 'epub', epubFixture());
	await page.goto('/read/21/31');
	let frame = await bookFrame(page, 'First section');
	const initialSize = await frame.locator('body').evaluate((body) => parseFloat(getComputedStyle(body).fontSize));
	await page.getByRole('button', { name: 'Format', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Format', exact: true });
	await dialog.getByRole('radio', { name: 'System', exact: true }).click();
	await dialog.getByRole('button', { name: 'Increase font size', exact: true }).click();
	await dialog.getByRole('button', { name: 'Increase spacing', exact: true }).click();
	await dialog.getByRole('radio', { name: 'Wood', exact: true }).click();
	await expect.poll(() => frame.locator('body').evaluate((body) => ({
		font: getComputedStyle(body).fontFamily,
		color: getComputedStyle(body).color,
		background: getComputedStyle(body).backgroundColor,
		spacing: Math.round(10 * parseFloat(getComputedStyle(body.querySelector('p')!).lineHeight) / parseFloat(getComputedStyle(body.querySelector('p')!).fontSize)) / 10
	}))).toMatchObject({ font: 'system-ui', color: 'rgb(62, 44, 28)', background: 'rgb(220, 194, 155)', spacing: 1.6 });
	await expect.poll(() => frame.locator('body').evaluate((body) => parseFloat(getComputedStyle(body).fontSize)))
		.toBeCloseTo(initialSize * 1.1, 2);
	await expect(page.locator('#reader-surface')).toHaveCSS('background-image', /repeating-linear-gradient/);
	await dialog.getByRole('radio', { name: 'Night', exact: true }).click();
	await expect(frame.locator('html')).toHaveCSS('color-scheme', 'dark');
	await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(28, 28, 30)');
	await expect(page.locator('#reader-surface')).toHaveCSS('background-image', 'none');
	await page.getByRole('button', { name: 'Save settings', exact: true }).click();
	await page.getByRole('button', { name: 'Save as format default', exact: true }).click();
	for (const key of ['reader.book.21', 'reader.epub']) {
		await expect.poll(() => state.settings.find((setting) => setting.key === key)?.value)
			.toMatchObject({ font: 'system', size: 110, spacing: 1.6, background: 'night', theme: 'dark' });
	}
	await page.keyboard.press('Escape');
	await page.reload();
	frame = await bookFrame(page, 'First section');
	await expect(frame.locator('body')).toHaveCSS('font-family', 'system-ui');
	await expect(frame.locator('html')).toHaveCSS('color-scheme', 'dark');
});

test('EPUB view menus change size and flow without exposing PDF tools', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const state = await setupReader(page, 'epub', epubFixture());
	await page.goto('/read/21/31');
	const frame = await bookFrame(page, 'First section');
	const bodySize = () => frame.locator('body').evaluate((body) => parseFloat(getComputedStyle(body).fontSize));
	const initialSize = await bodySize();
	await expectReaderToolbarFits(page);
	await expect(page.getByRole('button', { name: 'Select tool', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Hand tool', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Insert text, drawing or image', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Highlight selection', exact: true })).toBeDisabled();
	await page.keyboard.press('Escape');
	await frame.evaluate(() => {
		const passage = document.querySelector('#passage');
		if (!passage) throw new Error('Missing passage');
		const range = document.createRange();
		range.selectNodeContents(passage);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	});
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Highlight selection', exact: true })).toBeEnabled();
	await page.getByRole('menuitem', { name: 'Highlight selection', exact: true }).click();
	await expect.poll(() => state.highlights.map((highlight) => highlight.text)).toEqual(['A passage worth highlighting.']);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Add book note', exact: true }).click();
	await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('A private toolbar note');
	await page.getByRole('button', { name: 'Save note', exact: true }).click();
	await expect.poll(() => state.notes.some((note) => note.highlight_id === null && note.body_md === 'A private toolbar note')).toBe(true);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Save position', exact: true }).click();
	await expect(page.getByRole('tab', { name: 'Bookmarks', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('heading', { name: 'New bookmark', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();

	const size = page.getByRole('button', { name: 'Size', exact: true });
	await size.focus();
	await size.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: '50%', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(bodySize).toBeCloseTo(initialSize * 0.5, 2);
	await expect(size).toBeFocused();
	await size.press('ArrowDown');
	await expect(page.getByRole('menuitem', { name: 'Decrease font size', exact: true })).toBeDisabled();
	await expect(page.getByRole('menuitem', { name: 'Increase font size', exact: true })).toBeEnabled();
	await page.keyboard.press('End');
	await expect(page.getByRole('menuitem', { name: 'Increase font size', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(page.getByRole('menuitemradio', { name: '200%', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(bodySize).toBeCloseTo(initialSize * 2, 2);
	await size.press('ArrowDown');
	await expect(page.getByRole('menuitem', { name: 'Increase font size', exact: true })).toBeDisabled();
	await expect(page.getByRole('menuitem', { name: 'Decrease font size', exact: true })).toBeEnabled();
	await page.getByRole('menuitemradio', { name: '100%', exact: true }).click();
	await size.click();
	await page.getByRole('menuitem', { name: 'Increase font size', exact: true }).click();
	await expect.poll(bodySize).toBeCloseTo(initialSize * 1.1, 2);
	await page.keyboard.press('Escape');
	await expect(size).toBeFocused();
	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	await expect(page.getByRole('menuitemradio', { name: 'Pages', exact: true })).toHaveAttribute('aria-checked', 'true');
	await page.getByRole('menuitemradio', { name: 'Scroll', exact: true }).click();
	await expect.poll(() => page.locator('foliate-view').evaluate((host: View) => host.renderer.getAttribute('flow'))).toBe('scrolled');
	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	await expect(page.getByRole('menuitemradio', { name: 'Scroll', exact: true })).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('menuitemcheckbox')).toHaveCount(0);
	await page.getByRole('menuitemradio', { name: 'Pages', exact: true }).click();
	await expect.poll(() => page.locator('foliate-view').evaluate((host: View) => host.renderer.getAttribute('flow'))).toBe('paginated');

	await page.setViewportSize({ width: 390, height: 844 });
	await expectReaderToolbarFits(page);
	await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
	for (const label of ['Size', 'Page display', 'Format', 'Rotate']) {
		await expect(page.getByRole('button', { name: label, exact: true })).not.toBeVisible();
		await page.getByRole('button', { name: 'More view options', exact: true }).press('ArrowDown');
		await page.getByRole('menuitem', { name: label, exact: true }).click();
		if (label === 'Size') {
			await page.getByRole('menuitem', { name: 'Decrease font size', exact: true }).click();
			await expect.poll(bodySize).toBeCloseTo(initialSize, 2);
		} else if (label === 'Page display') {
			await page.getByRole('menuitemradio', { name: 'Scroll', exact: true }).click();
			await expect.poll(() => page.locator('foliate-view').evaluate((host: View) => host.renderer.getAttribute('flow'))).toBe('scrolled');
		} else if (label === 'Format') {
			const dialog = page.getByRole('dialog', { name: 'Format', exact: true });
			await expect(dialog.getByRole('radio', { name: 'Serif', exact: true })).toBeVisible();
			await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
			await expect.poll(() => state.settings.find((setting) => setting.key === 'reader.book.21')?.value)
				.toMatchObject({ size: 100, flow: 'scrolled', futureOption: { keep: true } });
			await dialog.press('Escape');
			await expect(dialog).not.toBeVisible();
		} else {
			await page.getByRole('menuitem', { name: 'Rotate right', exact: true }).click();
			await expect(page.locator('foliate-view')).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
		}
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
	}
	await page.reload();
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
	await expect(page.locator('foliate-view')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
});

test('CBZ exposes zoom, backgrounds and session rotation without typography or PDF tools', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const state = await setupReader(page, 'cbz', cbzFixture());
	await page.goto('/read/21/31');
	await expect((await bookFrame(page)).locator('img')).toBeVisible();
	await expectReaderToolbarFits(page);
	for (const label of ['Size', 'Format', 'Select tool', 'Hand tool', 'Insert text, drawing or image']) {
		await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
	}
	await page.getByRole('button', { name: 'Zoom', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Zoom in', exact: true })).toBeVisible();
	await expect(page.getByRole('menuitemradio', { name: '100%', exact: true })).toHaveAttribute('aria-checked', 'true');
	await page.getByRole('menuitemradio', { name: '150%', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toHaveText('150%');
	await expect.poll(() => page.locator('foliate-view').evaluate((host: View) => host.renderer.getAttribute('zoom'))).toBe('1.5');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Page display', exact: true });
	await expect(dialog.getByRole('radio', { name: 'Serif', exact: true })).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: 'Increase spacing', exact: true })).toHaveCount(0);
	await expect(dialog.getByRole('menuitemradio', { name: 'Pages', exact: true })).toHaveCount(0);
	await expect(dialog.getByRole('menuitemradio', { name: 'Scroll', exact: true })).toHaveCount(0);
	await dialog.getByRole('radio', { name: 'Sepia', exact: true }).click();
	await expect(page.locator('#reader-surface')).toHaveAttribute('data-background', 'sepia');
	await expect(dialog.getByRole('button', { name: 'Save settings', exact: true })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Save as format default', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.setViewportSize({ width: 390, height: 844 });
	await expectReaderToolbarFits(page);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Highlight current page', exact: true })).toBeEnabled();
	await page.getByRole('menuitem', { name: 'Highlight current page', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(1);
	await page.getByRole('button', { name: 'More view options', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Size', exact: true })).toHaveCount(0);
	await expect(page.getByRole('menuitem', { name: 'Format', exact: true })).toHaveCount(0);
	await expect(page.getByRole('menuitem', { name: 'Zoom', exact: true })).toBeVisible();
	await page.getByRole('menuitem', { name: 'Page display', exact: true }).click();
	await expect(dialog.getByRole('radio', { name: 'Sepia', exact: true })).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'More view options', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Rotate', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Rotate left', exact: true }).click();
	await expect(page.locator('foliate-view')).toHaveCSS('transform', 'matrix(0, -1, 1, 0, 0, 0)');
	await page.keyboard.press('Escape');
	await page.reload();
	await expect((await bookFrame(page)).locator('img')).toBeVisible();
	await expect(page.locator('foliate-view')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
});

test('Chinese EPUB header keeps localized view and Add menus usable on mobile', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await setupReader(page, 'epub', epubFixture(), { locale: 'zh' });
	await page.goto('/read/21/31');
	await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeEnabled();
	await expectReaderToolbarFits(page);
	await page.getByRole('button', { name: '添加', exact: true }).click();
	await expect(page.getByRole('menuitem')).toHaveCount(3);
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: '更多视图选项', exact: true }).click();
	for (const label of ['字号', '页面显示', '格式', '旋转']) {
		await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible();
	}
	await page.getByRole('menuitem', { name: '页面显示', exact: true }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByRole('menuitemradio', { name: '翻页', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: '滚动', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => page.locator('foliate-view').evaluate((host: View) => host.renderer.getAttribute('flow'))).toBe('scrolled');
});

test('PDF free zoom preserves rotated text and highlight geometry', async ({ page }) => {
	const state = await setupReader(page, 'pdf', pdfFixture(1));
	state.settings = [{ key: 'reader.book.21', value: { pdfZoom: 'page-actual', pdfRotation: 90 }, updated_at: new Date().toISOString(), rev: ++state.rev }];
	state.highlights = [{
		id: 'rotated-highlight', book_id: 21, book_file_id: 31,
		locator: { type: 'pdf', page: 1, rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }] },
		position: 0, text: 'First PDF page text', color: 'blue', chapter: null,
		created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z', deleted_at: null, rev: 1
	}];
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await useProductionCsp(page);
	await page.goto('/read/21/31');
	const surface = page.locator('#reader-surface');
	const pdfPage = page.locator('.reader-pdf-page');
	const width = () => pdfPage.evaluate((element) => element.getBoundingClientRect().width);
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	await expect.poll(width).toBeCloseTo(1056, 0);
	const geometry = () => pdfPage.evaluate((element) => {
		const page = element.getBoundingClientRect();
		const mark = element.querySelector('.reader-pdf-highlight')?.getBoundingClientRect();
		const text = element.querySelector('.reader-pdf-text span')?.getBoundingClientRect();
		if (!mark || !text) throw new Error('Missing PDF layers');
		return {
			x: (mark.left - page.left) / page.width, y: (mark.top - page.top) / page.height,
			width: mark.width / page.width, height: mark.height / page.height,
			textInside: text.left >= page.left && text.top >= page.top && text.right <= page.right && text.bottom <= page.bottom,
			textRotated: text.height > text.width
		};
	});
	await expect(pdfPage.locator('.reader-pdf-highlight')).toBeVisible();
	const original = await geometry();
	expect(original.x).toBeCloseTo(0.88, 3);
	expect(original.y).toBeCloseTo(0.1, 3);
	expect(original.width).toBeCloseTo(0.02, 3);
	expect(original.height).toBeCloseTo(0.3, 3);
	expect(original.textInside).toBe(true);
	expect(original.textRotated).toBe(true);
	await surface.focus();
	// pdf.js floors page CSS sizes to whole pixels.
	const widthNear = (expected: number) => expect.poll(async () => Math.abs(await width() - expected)).toBeLessThan(1);
	await page.keyboard.press('Control+=');
	await widthNear(1161.6);
	await page.keyboard.press('Control+-');
	await expect.poll(width).toBeCloseTo(1056, 0);
	await surface.dispatchEvent('wheel', { deltaY: -100, ctrlKey: true });
	await widthNear(1056 * Math.exp(0.2));
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	await expect(async () => {
		const zoomed = await geometry();
		expect(zoomed.x).toBeCloseTo(original.x, 3);
		expect(zoomed.y).toBeCloseTo(original.y, 3);
		expect(zoomed.textInside).toBe(true);
	}).toPass({ timeout: 5_000 });
	await surface.evaluate((element) => {
		for (let index = 0; index < 30; index++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true }));
	});
	// At 500% the canvas is capped and pdf.js rounds the page to its output-scale grid.
	await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toHaveText('500%');
	await expect.poll(async () => Math.abs(await width() - 5280)).toBeLessThan(5280 * 0.01);
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	await surface.focus();
	await page.keyboard.press('Control+0');
	await page.setViewportSize({ width: 390, height: 844 });
	await expect.poll(width).toBeLessThanOrEqual(390);
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	await expect(page.locator('.pv-frame-toolbar')).toContainText('0.00%');
	expect(errors).toEqual([]);
});

for (const { format, fixture, locator, target, start } of [
	{ format: 'pdf', fixture: pdfFixture, locator: { type: 'pdf', page: 2 }, target: 'Second PDF page text', start: 'First PDF page text' },
	{ format: 'epub', fixture: epubFixture, locator: { type: 'cfi', value: 'epubcfi(/6/4!/4/2/1:0)' }, target: 'Another page of the fixture.', start: 'A passage worth highlighting.' }
]) {
	test(`opens ${format.toUpperCase()} at a ?highlight= target and reports unknown IDs`, async ({ page }) => {
		const state = await setupReader(page, format, fixture());
		state.highlights = [{
			id: 'hl-target', book_id: 21, book_file_id: 31, locator, position: 0.75, text: target, color: 'blue',
			chapter: null, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z', deleted_at: null, rev: 1
		}];
		const visibleText = async (text: string) => {
			if (format === 'pdf') await expect(page.locator('.reader-pdf-text')).toContainText(text);
			else await expect((await bookFrame(page, text)).getByText(text, { exact: true })).toBeVisible();
		};
		await page.goto('/read/21/31?highlight=missing-highlight');
		if (format !== 'pdf') await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
		await visibleText(start);
		await expect(page.getByRole('alert').filter({ hasText: "This bookmark's file or position is unavailable on this device." })).toBeVisible();
		await page.goto('/read/21/31?highlight=hl-target');
		if (format !== 'pdf') await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
		await visibleText(target);
	});
}

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
		await expect(page.locator('.pv-frame')).toBeVisible();
		await expect(page.locator('.shell-header-band')).toHaveCount(0);
		await expect(page.getByRole('tab', { name: 'Contents', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Bookmarks', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Pages', exact: true })).toHaveCount(0);
		const frame = await bookFrame(page);
		if (format === 'cbz') {
			await expect(frame.locator('img')).toBeVisible();
			await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
			await page.getByRole('button', { name: 'Highlight current page' }).click();
			await expect.poll(() => state.highlights.length).toBe(1);
			await page.reload();
			await expect(page.locator(`[data-panel-entry="${state.highlights[0].id}"]`)).toBeVisible();
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
	await page.bringToFront();
	await expect.poll(() => page.evaluate(() => document.hidden)).toBe(false);
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
