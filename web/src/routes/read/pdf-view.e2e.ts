import { expect, test, type Page } from '@playwright/test';
import { pdfFixture } from '../../lib/reader/fixtures';

type Mutation = {
	entity: string; key?: string;
	data: { value?: Record<string, unknown>; locator?: { page: number; offset?: number }; percentage?: number };
};

async function setup(page: Page, initial: Record<string, unknown> = {}, pages = 160) {
	const bytes = pdfFixture(pages);
	const file = {
		id: 31, format: 'pdf', size_bytes: bytes.length, original_filename: 'Assembly.pdf',
		created_at: '2026-11-03T00:00:00Z', download_url: `/api/v1/books/21/files/31?v=${'c'.repeat(64)}`
	};
	const book = {
		id: 21, library_id: 1, title: 'Assembly', sort_title: 'Assembly', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: null, cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: file.created_at, updated_at: file.created_at
	};
	const settings: Array<{ key: string; value: Record<string, unknown>; updated_at: string; rev: number }> = [
		{ key: 'reader.book.21', value: { futureBook: { keep: true }, ...initial }, updated_at: file.created_at, rev: 1 },
		{ key: 'reader.pdf', value: { futureFormat: true }, updated_at: file.created_at, rev: 1 }
	];
	const pushes: Mutation[] = [];
	let progress: Record<string, unknown> | null = null;
	let revision = 1;
	let online = true;
	await page.route('**/api/v1/**', async (route) => {
		if (!online) return route.abort('internetdisconnected');
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } });
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		if (path === '/api/v1/me/books/21') return route.fulfill({ json: { user_book: null, progress, highlights: [], notes: [], bookmarks: [], page_annotations: [] } });
		if (path === '/api/v1/me/settings') return route.fulfill({ json: { settings } });
		if (path === '/api/v1/sync/pull') {
			const cursor = Number(new URL(route.request().url()).searchParams.get('cursor'));
			return route.fulfill({ json: {
				cursor: revision, user_books: [],
				reading_progress: progress && Number(progress.rev) > cursor ? [{ ...progress, book_id: 21 }] : [],
				highlights: [], notes: [], bookmarks: [], page_annotations: [],
				user_settings: settings.filter((row) => row.rev > cursor)
			} });
		}
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON() as { mutations: Mutation[] };
			pushes.push(...mutations);
			for (const mutation of mutations) {
				revision += 1;
				if (mutation.entity === 'user_settings') {
					const row = settings.find((row) => row.key === mutation.key);
					if (row && mutation.data.value) {
						row.value = mutation.data.value;
						row.rev = revision;
						row.updated_at = new Date().toISOString();
					}
				}
				if (mutation.entity === 'reading_progress') {
					progress = { ...mutation.data, updated_at: new Date().toISOString(), rev: revision };
				}
			}
			return route.fulfill({ json: { results: mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		if (path.endsWith('/reading-summary')) return route.fulfill({ json: { reading_summary: { total_active_seconds: 0, session_count: 0, first_read_at: null, last_read_at: null } } });
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	return {
		pushes,
		bookSettings: () => settings[0].value,
		formatSettings: () => settings[1].value,
		progress: () => progress,
		offline: () => { online = false; }
	};
}

async function open(page: Page) {
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-page[data-page="1"] .reader-pdf-text')).toContainText('First PDF page text');
	await expect(page.getByRole('textbox', { name: /^Page \d+ of \d+$/ })).toBeEnabled();
}

test('page 120, all layouts, scoped debounced saves and reopening', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	const state = await setup(page);
	await open(page);
	const surface = page.locator('#reader-surface');
	await expect(surface).toHaveAttribute('data-layout', 'single-continuous');
	const counter = page.getByRole('textbox', { name: /^Page \d+ of \d+$/ });
	await counter.fill('120');
	await counter.press('Enter');
	await expect(page.getByLabel('Progress 74.84%')).toBeVisible();
	for (const [label, layout, columns] of [
		['Single page', 'single', 1], ['Split', 'split', 2],
		['Split continuous', 'split-continuous', 2], ['Single page continuous', 'single-continuous', 1]
	] as const) {
		const before = state.pushes.filter((row) => row.entity === 'user_settings').length;
		await page.getByRole('button', { name: 'Page display', exact: true }).click();
		await page.getByRole('menuitemradio', { name: label, exact: true }).click();
		await expect(surface).toHaveAttribute('data-layout', layout);
		// pdf.js wraps split layouts in `.spread` rows; single layouts place pages directly in the viewer.
		if (columns === 2) await expect(page.locator('.pdfViewer .spread').first().locator('.reader-pdf-page')).toHaveCount(2);
		else await expect(page.locator('.pdfViewer .spread')).toHaveCount(0);
		await expect.poll(state.bookSettings).toMatchObject({ pdfLayout: layout });
		await expect.poll(() => state.pushes.filter((row) => row.entity === 'user_settings').length).toBe(before + 2);
		expect(state.formatSettings()).toMatchObject({ futureFormat: true, pdfLayout: layout });
	}
	await page.getByRole('button', { name: 'Zoom', exact: true }).click();
	await page.getByRole('menuitemradio', { name: 'Actual size' }).click();
	await surface.focus();
	await page.keyboard.press('r');
	await expect.poll(state.bookSettings).toMatchObject({ pdfRotation: 90, pdfZoom: 'page-actual', futureBook: { keep: true } });
	expect(state.formatSettings()).toMatchObject({ pdfZoom: 'page-actual' });
	expect(state.formatSettings()).not.toHaveProperty('pdfRotation');
	await page.reload();
	await expect(surface).toHaveAttribute('data-layout', 'single-continuous');
	await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toHaveText('100%');
	await expect(counter).toHaveValue('120');
	// Actual size is pdf.js scale 1 (4/3 CSS px per point); the 612×792 pt page is rotated.
	await expect(page.locator('.reader-pdf-page[data-page="120"]')).toHaveCSS('width', '1056px');
});

test('wheel zoom keeps its pointer anchor and numeric zoom stays per book', async ({ page }) => {
	await page.setViewportSize({ width: 1000, height: 740 });
	const state = await setup(page, { pdfZoom: 1.5, pdfLayout: 'single-continuous' }, 3);
	await open(page);
	const surface = page.locator('#reader-surface');
	await surface.evaluate((element) => { element.scrollTop = 200; });
	const point = { x: 500, y: 400 };
	const anchor = () => page.locator('.reader-pdf-page[data-page="1"]').evaluate((element, point) => {
		const rect = element.getBoundingClientRect();
		return { x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height };
	}, point);
	const before = await anchor();
	await page.mouse.move(point.x, point.y);
	await page.keyboard.down('Control');
	await page.mouse.wheel(0, -100);
	await page.keyboard.up('Control');
	await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toHaveText('183%');
	await expect.poll(async () => Math.abs((await anchor()).y - before.y)).toBeLessThan(0.005);
	await expect.poll(async () => Math.abs((await anchor()).x - before.x)).toBeLessThan(0.005);
	await expect.poll(state.bookSettings).toMatchObject({ pdfZoom: 1.5 * Math.exp(0.2) });
	expect(state.formatSettings()).not.toHaveProperty('pdfZoom');
});

test('keys, edge paging lockout, tools, OCR preference and editable/menu guards', async ({ page }) => {
	await setup(page, { pdfLayout: 'single', pdfZoom: 'page-fit' }, 5);
	await open(page);
	const surface = page.locator('#reader-surface');
	const counter = page.getByRole('textbox', { name: /^Page \d+ of \d+$/ });
	await surface.focus();
	for (const [key, expected] of [['End', '5'], ['Home', '1'], ['PageDown', '2'], ['PageUp', '1'], ['Space', '2'], ['Shift+Space', '1']]) {
		await page.keyboard.press(key);
		await expect(counter).toHaveValue(expected);
	}
	await surface.dispatchEvent('wheel', { deltaY: 100 });
	await expect(counter).toHaveValue('2');
	await surface.dispatchEvent('wheel', { deltaY: 100 });
	await expect(counter).toHaveValue('2');
	await surface.focus();
	for (const [key, expected] of [['h', 'hand'], ['i', 'insert'], ['Escape', 'hand'], ['v', 'select']]) {
		await page.keyboard.press(key);
		await expect(surface).toHaveAttribute('data-tool', expected);
	}
	await counter.focus();
	await page.keyboard.press('h');
	await expect(surface).toHaveAttribute('data-tool', 'select');
	await counter.press('Escape');
	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	await page.keyboard.press('i');
	await expect(surface).toHaveAttribute('data-tool', 'select');
	const ocr = page.getByRole('menuitemcheckbox', { name: 'Recognize text in scanned pages' });
	await expect(ocr).toHaveAttribute('aria-checked', 'true');
	await ocr.click();
	expect(await page.evaluate(() => localStorage.getItem('pandalibrary.pdf-ocr'))).toBe('false');
	await page.reload();
	await page.getByRole('button', { name: 'Page display', exact: true }).click();
	await expect(ocr).toHaveAttribute('aria-checked', 'false');
});

test('continuous scrolling updates fractional progress and X flushes and restores the offset', async ({ page }) => {
	const state = await setup(page, { pdfZoom: 1.5 }, 3);
	await open(page);
	const surface = page.locator('#reader-surface');
	await surface.evaluate((element) => { element.scrollTop = 300; });
	await expect(page.getByLabel(/^Progress /)).not.toHaveAccessibleName('Progress 0.00%');
	await page.getByRole('button', { name: 'Close reader', exact: true }).click();
	await expect(page).toHaveURL('/books/21');
	const saved = state.progress()?.locator as { page: number; offset?: number } | undefined;
	expect(saved).toMatchObject({ type: 'pdf', page: 1 });
	// 150% of a 792 pt page is 1584 CSS px in pdf.js.
	expect(saved?.offset).toBeCloseTo(300 / 1584, 3);
	await page.goto('/read/21/31');
	await expect(page.locator('.reader-pdf-page[data-page="1"] .reader-pdf-text')).toContainText('First PDF page text');
	await expect.poll(() => surface.evaluate((element) => element.scrollTop)).toBeCloseTo(300, 0);
});

test('two-touch pinch zooms while one touch retains native scrolling', async ({ page, context }) => {
	await page.setViewportSize({ width: 1000, height: 740 });
	await setup(page, { pdfZoom: 1, pdfLayout: 'single-continuous' }, 3);
	await open(page);
	const cdp = await context.newCDPSession(page);
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchStart', touchPoints: [{ x: 400, y: 300, id: 1 }, { x: 600, y: 300, id: 2 }]
	});
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchMove', touchPoints: [{ x: 350, y: 300, id: 1 }, { x: 650, y: 300, id: 2 }]
	});
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toHaveText('150%');
	const surface = page.locator('#reader-surface');
	await surface.evaluate((element) => { element.scrollTop = 0; });
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 600, id: 3 }] });
	for (const y of [570, 530, 490, 450, 400]) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 500, y, id: 3 }] });
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await expect.poll(() => surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(50);
	await cdp.detach();
});

test('saved PDF opens from IndexedDB offline and retains the toolbar', async ({ page, context }) => {
	const state = await setup(page, { pdfLayout: 'single', pdfZoom: 'page-fit' }, 3);
	await page.goto('/books/21/files');
	await page.getByRole('button', { name: 'Actions for Assembly.pdf' }).click();
	await page.getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect(page.getByText('Book file downloaded for offline reading.', { exact: true })).toBeVisible();
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
	});
	await open(page);
	state.offline();
	await context.setOffline(true);
	await page.reload();
	await expect(page.locator('.reader-pdf-text')).toContainText('First PDF page text');
	await page.locator('#reader-surface').focus();
	await page.keyboard.press('End');
	await expect(page.getByRole('textbox', { name: /^Page \d+ of \d+$/ })).toHaveValue('3');
	await expect(page.getByRole('button', { name: 'Reader sync status' })).toBeVisible();
});
