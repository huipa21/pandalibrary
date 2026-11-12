import { expect, test, type Frame, type Locator, type Page } from '@playwright/test';
import { cbzFixture, epubFixture, pngFixture } from './fixtures';

test.use({ serviceWorkers: 'block' });

async function setup(page: Page, format: 'epub' | 'cbz') {
	const bytes = format === 'epub' ? epubFixture() : cbzFixture(pngFixture(600, 900, [120, 180, 90]));
	const timestamp = '2026-11-03T00:00:00Z';
	const file = {
		id: 31, format, size_bytes: bytes.length,
		download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}`
	};
	const book = {
		id: 21, library_id: 1, title: 'Rotation fixture', sort_title: 'Rotation fixture',
		subtitle: null, description: null, language: 'en', publisher: null, published_date: null,
		page_count: null, cover_url: null, cover_source: null, authors: [], series: null, tags: [],
		identifiers: [], files: [file], field_sources: [], created_at: timestamp, updated_at: timestamp
	};
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') {
			return route.fulfill({ json: { user: { id: 1, username: 'reader', role: 'user', locale: 'en' } } });
		}
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') {
			return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		}
		if (path === '/api/v1/me/books/21') {
			return route.fulfill({ json: {
				user_book: null, progress: null, highlights: [], notes: [], bookmarks: [], page_annotations: []
			} });
		}
		if (path === '/api/v1/me/settings') {
			return route.fulfill({ json: { settings: [
				{ key: `reader.${format}`, value: { font: 'serif' }, updated_at: timestamp, rev: 1 }
			] } });
		}
		if (path === '/api/v1/sync/pull') {
			return route.fulfill({ json: {
				cursor: 1, user_books: [], reading_progress: [], user_settings: [],
				highlights: [], notes: [], bookmarks: [], page_annotations: []
			} });
		}
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON() as { mutations: unknown[] };
			return route.fulfill({ json: { results: mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto('/read/21/31');
	await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
}

async function bookFrame(page: Page, text?: string): Promise<Frame> {
	let frame: Frame | undefined;
	await expect(async () => {
		frame = undefined;
		for (const candidate of page.frames().filter((item) => item.url().startsWith('blob:'))) {
			const content = text ? candidate.getByText(text, { exact: true }) : candidate.locator('img');
			if (await content.isVisible()) {
				frame = candidate;
				break;
			}
		}
		expect(frame).toBeDefined();
	}).toPass({ timeout: 10_000 });
	if (!frame) throw new Error('Missing Foliate book frame');
	return frame;
}

async function rotate(page: Page, direction: 'left' | 'right') {
	const button = page.getByRole('button', { name: 'Rotate', exact: true });
	if (await button.isVisible()) await button.click();
	else {
		await page.getByRole('button', { name: 'More view options', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Rotate', exact: true }).click();
	}
	await page.getByRole('menuitem', { name: `Rotate ${direction}`, exact: true }).click();
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
}

async function expectInsideSurface(page: Page, content: Locator) {
	await expect(async () => {
		const surface = await page.locator('#reader-surface').boundingBox();
		const box = await content.boundingBox();
		if (!surface || !box) throw new Error('Missing visible reader bounds');
		expect(box.width).toBeGreaterThan(0);
		expect(box.height).toBeGreaterThan(0);
		expect(box.x).toBeGreaterThanOrEqual(surface.x - 1);
		expect(box.y).toBeGreaterThanOrEqual(surface.y - 1);
		expect(box.x + box.width).toBeLessThanOrEqual(surface.x + surface.width + 1);
		expect(box.y + box.height).toBeLessThanOrEqual(surface.y + surface.height + 1);
	}).toPass({ timeout: 5_000 });
}

for (const direction of ['right', 'left'] as const) {
	test(`EPUB quarter-turn ${direction} fits, paginates, resizes and positions native selection actions`, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await setup(page, 'epub');
		await rotate(page, direction);
		await expectInsideSurface(page, page.locator('foliate-view'));
		let frame = await bookFrame(page, 'A passage worth highlighting.');
		await expectInsideSurface(page, frame.locator('#passage'));
		const rotatedText = await frame.locator('#passage').boundingBox();
		if (!rotatedText) throw new Error('Missing rotated text');
		expect(rotatedText.height).toBeGreaterThan(rotatedText.width);
		await page.getByRole('button', { name: 'Next page', exact: true }).click();
		frame = await bookFrame(page, 'Second section');
		await expectInsideSurface(page, frame.getByText('Another page of the fixture.', { exact: true }));
		await page.getByRole('button', { name: 'Previous page', exact: true }).click();
		frame = await bookFrame(page, 'A passage worth highlighting.');
		await page.setViewportSize({ width: 700, height: 1000 });
		await expectInsideSurface(page, page.locator('foliate-view'));
		await expectInsideSurface(page, frame.locator('#passage'));
		await frame.locator('#passage').evaluate((element) => {
			window.focus();
			const node = element.firstChild;
			if (!node) throw new Error('Missing passage text');
			const range = document.createRange();
			range.setStart(node, 0);
			range.setEnd(node, node.textContent!.length);
			const selection = document.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			document.dispatchEvent(new Event('selectionchange'));
		});
		const toolbar = page.getByRole('toolbar', { name: 'Selection actions', exact: true });
		await expect(toolbar).toBeVisible();
		await expectInsideSurface(page, toolbar);
		const text = await frame.locator('#passage').boundingBox();
		const bar = await toolbar.boundingBox();
		if (!text || !bar) throw new Error('Missing selection or toolbar bounds');
		expect(bar.x).toBeLessThanOrEqual(text.x + text.width);
		expect(bar.x + bar.width).toBeGreaterThanOrEqual(text.x);
	});

	test(`CBZ quarter-turn ${direction} keeps the fitted image inside the surface after resize`, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await setup(page, 'cbz');
		await rotate(page, direction);
		let frame = await bookFrame(page);
		await expect.poll(() => frame.locator('img').evaluate((image: HTMLImageElement) =>
			image.complete && image.naturalWidth > 0)).toBe(true);
		await expectInsideSurface(page, page.locator('foliate-view'));
		await expectInsideSurface(page, frame.locator('img'));
		const image = await frame.locator('img').boundingBox();
		if (!image) throw new Error('Missing rotated comic image');
		expect(image.width / image.height).toBeCloseTo(900 / 600, 2);
		await page.setViewportSize({ width: 390, height: 844 });
		frame = await bookFrame(page);
		await expectInsideSurface(page, page.locator('foliate-view'));
		await expectInsideSurface(page, frame.locator('img'));
	});
}
