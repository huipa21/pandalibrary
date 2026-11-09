import { expect, test } from '@playwright/test';
import { createServer, preview, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { ocrAssets } from '../../../../../scripts/ocr-assets.js';
import { mixedPdfFixture, scannedFixtureImage, scannedPdfFixture } from '../../fixtures.js';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
	server = await createServer({
		configFile: false, root: resolve('.'),
		plugins: [ocrAssets()],
		resolve: { alias: { '#lib': resolve('src/lib') } },
		server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/build/**', '**/.svelte-kit/**'] } }
	});
	await server.listen();
	origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.ocrHarness?.dispose());
});

test('real self-hosted Chinese/English OCR, selectable text, rotation, cache, mixed and disabled pages', async ({ page }) => {
	test.slow();
	const external: string[] = [];
	let workerStarts = 0;
	page.on('request', (request) => {
		if (!request.url().startsWith(origin) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) external.push(request.url());
		if (request.url().endsWith('/worker.min.js')) workerStarts++;
	});
	await page.goto(`${origin}/src/lib/reader/pdf/ocr/Ocr.harness.html`);
	await page.waitForFunction(() => !!window.ocrHarness);
	const image = await scannedFixtureImage(page);
	const scanned = scannedPdfFixture([image]).toString('base64');
	const start = Date.now();
	await page.evaluate((pdf) => window.ocrHarness.open(pdf), scanned);
	console.log(`OCR scanned fixture: ${Date.now() - start} ms including model initialization`);
	await expect(page.locator('[data-scanned=true]')).toHaveCount(1);
	const text = page.locator('.pv-ocr-text');
	await expect(text).toContainText('Scanned');
	await expect(text).toContainText('扫描');
	const span = text.locator('span').first();
	const box = await span.boundingBox();
	if (!box) throw new Error('Missing OCR span.');
	await page.mouse.move(box.x, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width, box.y + box.height / 2, { steps: 10 });
	await page.mouse.up();
	expect(await page.evaluate(() => document.getSelection()?.toString())).toContain('Scanned');
	const before = await span.boundingBox();
	await page.evaluate(() => window.ocrHarness.rotate());
	const rotated = await span.boundingBox();
	expect(rotated!.height).toBeCloseTo(before!.width, 0);
	expect(rotated!.width).toBeCloseTo(before!.height, 0);

	expect(workerStarts).toBe(1);
	await page.evaluate((pdf) => window.ocrHarness.open(pdf), scanned);
	await expect(text).toContainText('Scanned');
	expect(workerStarts).toBe(1);
	await page.evaluate((pdf) => window.ocrHarness.open(pdf, { enabled: false }), scanned);
	await expect(text).toHaveCount(0);
	expect(workerStarts).toBe(1);
	await page.evaluate((pdf) => window.ocrHarness.open(pdf, { active: false }), scanned);
	await expect(text).toHaveCount(0);
	expect(workerStarts).toBe(1);

	const mixed = mixedPdfFixture(image).toString('base64');
	await page.evaluate((pdf) => window.ocrHarness.open(pdf), mixed);
	await expect(page.locator('[data-page="1"] .pv-ocr-text')).toHaveCount(0);
	await expect(page.locator('[data-page="2"] .pv-ocr-text')).toContainText('Scanned');
	expect(external).toEqual([]);
});

test('live PdfReader runs OCR through its page-enhancer hook, with selection, rotation, cache and toggle', async ({ page }) => {
	test.slow();
	let workerStarts = 0;
	page.on('request', (request) => { if (request.url().endsWith('/worker.min.js')) workerStarts++; });
	await page.goto(`${origin}/src/lib/reader/pdf/ocr/Ocr.harness.html`);
	await page.waitForFunction(() => !!window.ocrHarness);
	const image = await scannedFixtureImage(page);
	const mixed = mixedPdfFixture(image).toString('base64');
	await page.evaluate((pdf) => window.ocrHarness.openLive(pdf), mixed);
	const text = page.locator('.reader-pdf-page[data-page="2"] .reader-pdf-enhancement .pv-ocr-text');
	await expect(text).toContainText('Scanned', { timeout: 30_000 });
	await expect(text).toContainText('扫描');
	await expect(page.locator('.reader-pdf-page[data-page="1"] .pv-ocr-text')).toHaveCount(0);
	await expect(page.locator('.reader-pdf-page[data-page="2"]')).toHaveAttribute('data-scanned', 'true');

	const span = text.locator('span').first();
	await span.scrollIntoViewIfNeeded();
	const box = (await span.boundingBox())!;
	await page.mouse.move(box.x + 1, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 });
	await page.mouse.up();
	await expect.poll(() => page.evaluate(() => window.ocrHarness.selection)).toMatchObject({
		text: expect.stringContaining('Scanned'), locator: { type: 'pdf', page: 2 }
	});
	expect(workerStarts).toBe(1);

	await page.evaluate(() => window.ocrHarness.removeEnhancer?.());
	await expect(page.locator('.pv-ocr-text')).toHaveCount(0);

	// Rotated reopen is served from the IndexedDB cache without recognizing again.
	await page.evaluate((pdf) => window.ocrHarness.openLive(pdf, { rotation: 90 }), mixed);
	await expect(text).toContainText('Scanned');
	const pageBox = (await page.locator('.reader-pdf-page[data-page="2"]').boundingBox())!;
	const rotated = (await text.locator('span').first().boundingBox())!;
	expect(rotated.height).toBeGreaterThan(rotated.width);
	expect(rotated.x).toBeGreaterThanOrEqual(pageBox.x - 1);
	expect(rotated.x + rotated.width).toBeLessThanOrEqual(pageBox.x + pageBox.width + 1);
	expect(workerStarts).toBe(1);
});

test('cancelled pages do not cache results and missing models expose a working retry', async ({ page }) => {
	test.slow();
	await page.goto(`${origin}/src/lib/reader/pdf/ocr/Ocr.harness.html`);
	await page.waitForFunction(() => !!window.ocrHarness);
	const scanned = scannedPdfFixture([await scannedFixtureImage(page)]).toString('base64');
	let workerStarts = 0;
	page.on('request', (request) => { if (request.url().endsWith('/worker.min.js')) workerStarts++; });
	await page.evaluate(async (pdf) => {
		const opening = window.ocrHarness.open(pdf);
		setTimeout(() => window.ocrHarness.cancel(), 200);
		await opening;
	}, scanned);
	expect(workerStarts).toBe(0);
	expect(await page.evaluate(async () => {
		if (!(await indexedDB.databases()).some((database) => database.name === 'pandalibrary-ocr')) return 0;
		return new Promise<number>((resolve, reject) => {
			const request = indexedDB.open('pandalibrary-ocr');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const count = database.transaction('pages').objectStore('pages').count();
				count.onsuccess = () => { resolve(count.result); database.close(); };
				count.onerror = () => { reject(count.error); database.close(); };
			};
		});
	})).toBe(0);
	let failed = false;
	await page.route('**/chi_sim.traineddata.gz', (route) => {
		if (!failed) { failed = true; return route.fulfill({ status: 503, body: 'Unavailable' }); }
		return route.continue();
	});
	await page.evaluate((pdf) => window.ocrHarness.open(pdf), scanned);
	expect(await page.evaluate(() => window.ocrHarness.status.state)).toBe('error');
	await page.evaluate(() => {
		const status = window.ocrHarness.status;
		if (status.state !== 'error') throw new Error('Expected an OCR failure.');
		status.retry();
	});
	await expect(page.locator('.pv-ocr-text')).toContainText('扫描', { timeout: 20_000 });
	expect(await page.evaluate(() => window.ocrHarness.status.state)).toBe('idle');
});

test('text layer uses percentages, joins CJK, rescales and is removed on abort', async ({ page }) => {
	await page.goto(`${origin}/src/lib/reader/pdf/ocr/Ocr.harness.html`);
	await page.waitForFunction(() => !!window.ocrHarness);
	await page.evaluate(() => { window.ocrHarness.textFixture(); });
	const span = page.locator('.pv-ocr-text span');
	await expect(span).toHaveText('扫描 sample');
	const styles = await span.evaluate((element) => ({
		left: element.style.left, top: element.style.top, width: element.style.width,
		height: element.style.height, transform: element.style.transform, size: element.style.fontSize
	}));
	expect(styles).toMatchObject({ left: '10%', top: '20%', height: '10%', size: '30px' });
	expect(styles.width).toMatch(/%$/);
	expect(styles.transform).toMatch(/^scaleX\(/);
	const before = await span.boundingBox();
	expect(before!.width).toBeCloseTo(300, 0);
	await page.locator('#pages > div').evaluate((element) => {
		element.style.width = '300px'; element.style.height = '150px';
	});
	await expect.poll(() => span.evaluate((element) => element.style.fontSize)).toBe('15px');
	expect((await span.boundingBox())!.width).toBeCloseTo(150, 0);
	await page.evaluate(() => window.ocrHarness.cancel());
	await expect(span).toHaveCount(0);
});

test('production service worker excludes OCR from install and runtime-caches it for offline use', async ({ page, context }) => {
	test.slow();
	const production = await preview({ logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
	try {
		const url = production.resolvedUrls!.local[0];
		await page.route('**/api/**', (route) => route.fulfill({
			status: 200, json: new URL(route.request().url()).pathname.endsWith('/setup') ? { required: false } : { user: null }
		}));
		await page.goto(`${url}login`);
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
		});
		const directory = readdirSync(resolve('build', '_app', 'immutable', 'ocr'))[0];
		const asset = `/_app/immutable/ocr/${directory}/eng.traineddata.gz`;
		const before = await page.evaluate(async () => {
			const keys = await caches.keys();
			const paths = await Promise.all(keys.map(async (key) => (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname)));
			return { keys, paths: paths.flat() };
		});
		expect(before.keys.some((key) => key.startsWith('pandalibrary-shell-'))).toBe(true);
		expect(before.paths.some((path) => path.startsWith('/_app/immutable/ocr/'))).toBe(false);
		const bytes = await page.evaluate(async (asset) => {
			const response = await fetch(asset);
			if (!response.ok) throw new Error('Failed to fetch the OCR model.');
			return (await response.arrayBuffer()).byteLength;
		}, asset);
		expect(bytes).toBeGreaterThan(1_000_000);
		const cached = await page.evaluate(async (asset) => {
			const keys = (await caches.keys()).filter((key) => key.startsWith('pandalibrary-ocr-'));
			return Promise.all(keys.map(async (key) => !!await (await caches.open(key)).match(asset)));
		}, asset);
		expect(cached).toEqual([true]);
		await context.setOffline(true);
		expect(await page.evaluate(async (asset) => (await (await fetch(asset)).arrayBuffer()).byteLength, asset)).toBe(bytes);
	} finally {
		await context.setOffline(false);
		await new Promise<void>((resolve, reject) => production.httpServer.close((error) => error ? reject(error) : resolve()));
	}
});
