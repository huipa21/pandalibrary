import { expect, test, type Page } from '@playwright/test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { build } from 'vite';

test.use({ serviceWorkers: 'block', bypassCSP: true });
let script: string;
let css: string;

test.beforeAll(async () => {
	const result = await build({
		configFile: false,
		plugins: [svelte()],
		resolve: { alias: [{ find: '#lib', replacement: resolve('src/lib') }] },
		build: {
			write: false,
			lib: { entry: resolve('src/lib/reader/toolbar/toolbar-fixture.ts'), formats: ['es'] }
		}
	});
	const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
		if (!('output' in item)) throw new Error('Unexpected fixture build result.');
		return item.output;
	});
	const chunk = outputs.find((output) => output.type === 'chunk');
	const style = outputs.find((output) => output.type === 'asset' && output.fileName.endsWith('.css'));
	if (!chunk || chunk.type !== 'chunk' || !style || style.type !== 'asset') {
		throw new Error('The toolbar fixture did not produce JavaScript and CSS.');
	}
	script = chunk.code;
	css = typeof style.source === 'string' ? style.source : Buffer.from(style.source).toString('utf8');
});

async function mount(page: Page, locale = 'en', dark = false) {
	await page.route('**/pv4-fixture*', (route) => route.fulfill({
		contentType: 'text/html',
		body: `<!doctype html><html lang="${locale}" data-theme="${dark ? 'dark' : 'light'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="pv4-test-root"></div></body></html>`
	}));
	await page.goto(`/pv4-fixture?locale=${locale}`);
	await page.addStyleTag({ content: css });
	await page.addScriptTag({ content: script, type: 'module' });
	await expect(page.getByRole('toolbar')).toBeVisible();
}

async function update(page: Page, detail: Record<string, number | boolean>) {
	await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('pv4-fixture-update', { detail })), detail);
}

async function expectLog(page: Page, action: string, value: string | number | boolean) {
	await expect.poll(() => page.evaluate(() => window.log.at(-1))).toEqual({ action, value });
}

test('page input jumps, clamps, rejects invalid values, cancels and preserves focused edits', async ({ page }) => {
	await mount(page);
	const input = page.getByRole('textbox');
	await input.focus();
	expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 2]);
	await input.fill('42');
	await input.press('Enter');
	await expectLog(page, 'jump', 42);
	await expect(input).toHaveAccessibleName('Page 42 of 240');
	await input.fill('999');
	await input.press('Tab');
	await expect(input).toHaveValue('240');
	await expectLog(page, 'jump', 240);
	await input.fill('0');
	await input.press('Enter');
	await expectLog(page, 'jump', 1);
	for (const invalid of ['no', '', '2.5', '12x']) {
		await input.fill(invalid);
		await input.press('Enter');
		await expect(input).toHaveValue('1');
	}
	await input.fill('123');
	await input.press('Escape');
	await expect(input).toHaveValue('1');
	await expect(input).not.toBeFocused();
	await input.fill('50');
	await update(page, { page: 7 });
	await expect(input).toHaveValue('50');
	await input.press('Escape');
	await expect(input).toHaveValue('7');
	await update(page, { page: 8 });
	await expect(input).toHaveValue('8');
	expect(await page.evaluate(() => window.log.filter((item) => item.action === 'jump').length)).toBe(3);
});

test('progress is bilingual and handles NaN; disabled controls emit nothing', async ({ page }) => {
	await mount(page, 'zh');
	await expect(page.getByLabel('阅读进度 10.05%')).toHaveText('10.05%');
	await expect(page.getByRole('textbox')).toHaveAccessibleName('第 12 页，共 240 页');
	await update(page, { fraction: NaN, disabled: true });
	await expect(page.getByLabel('阅读进度 0.00%')).toHaveText('0.00%');
	await expect(page.getByRole('textbox')).toBeDisabled();
	await expect(page.getByRole('button', { name: '插入文字、绘图或图片' })).toBeDisabled();
	await page.getByRole('button', { name: '缩放', exact: true }).click();
	await expect(page.getByRole('menuitemradio', { name: '自动', exact: true })).toBeChecked();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: '页面显示', exact: true }).click();
	await expect(page.getByRole('menuitemcheckbox', { name: '封面单独显示' })).toBeDisabled();
	await page.keyboard.press('Escape');
	expect(await page.evaluate(() => window.log)).toEqual([]);
});

test('zoom keyboard, radio checks, step buttons and pointer dismissal', async ({ page }) => {
	await mount(page);
	const zoom = page.getByRole('button', { name: 'Zoom', exact: true });
	await expect(zoom).toHaveText('125%');
	await zoom.focus();
	await zoom.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: 'Automatic', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: 'Actual size' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expectLog(page, 'zoom', 'page-actual');
	await expect(zoom).toBeFocused();
	await zoom.press('Space');
	await expect(page.getByRole('menuitemradio', { name: 'Actual size' })).toBeChecked();
	await page.keyboard.press('End');
	await expect(page.getByRole('menuitem', { name: 'Zoom in' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expectLog(page, 'step', 1);
	await expect(zoom).toHaveText('135%');
	await expect(page.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(0);
	await page.getByRole('menuitem', { name: 'Zoom out' }).click();
	await expectLog(page, 'step', -1);
	await expect(page.getByText('Ctrl + scroll to zoom')).toBeVisible();
	await page.keyboard.press('Home');
	await expect(page.getByRole('menuitemradio', { name: 'Automatic', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(page.getByRole('menuitem', { name: 'Zoom in' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(zoom).toBeFocused();
	await zoom.click();
	await page.getByText('PDF page fixture').click();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await zoom.click();
	await page.keyboard.press('Tab');
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Page display', exact: true })).toBeFocused();
	for (const [label, value] of [['Automatic', 'auto'], ['Fit page', 'page-fit'], ['Page width', 'page-width']]) {
		await zoom.click();
		await page.getByRole('menuitemradio', { name: label, exact: true }).click();
		await expectLog(page, 'zoom', value);
		await zoom.click();
		await expect(page.getByRole('menuitemradio', { name: label, exact: true })).toBeChecked();
		await page.keyboard.press('Escape');
	}
});

test('layout, cover, theme, optional OCR, rotate and toggles follow props', async ({ page }) => {
	await mount(page);
	const display = page.getByRole('button', { name: 'Page display', exact: true });
	await display.click();
	await expect(page.getByRole('menuitemcheckbox', { name: 'Show cover alone' })).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(display).toBeFocused();
	for (const [label, value] of [
		['Split', 'split'], ['Split continuous', 'split-continuous'],
		['Single page', 'single'], ['Single page continuous', 'single-continuous']
	]) {
		await display.press('Enter');
		await page.getByRole('menuitemradio', { name: label, exact: true }).click();
		await expectLog(page, 'layout', value);
		await display.click();
		await expect(page.getByRole('menuitemradio', { name: label, exact: true })).toBeChecked();
		await page.keyboard.press('Escape');
	}
	await display.click();
	await page.getByRole('menuitemradio', { name: 'Split', exact: true }).click();
	await display.click();
	await page.getByRole('menuitemcheckbox', { name: 'Show cover alone' }).click();
	await expectLog(page, 'cover', true);
	await display.click();
	await expect(page.getByRole('menuitemcheckbox', { name: 'Show cover alone' })).toBeChecked();
	await page.getByRole('menuitemradio', { name: 'Sepia' }).click();
	await expectLog(page, 'theme', 'sepia');
	await display.click();
	await expect(page.getByRole('menuitemradio', { name: 'Sepia' })).toBeChecked();
	await page.keyboard.press('Escape');
	for (const [label, value] of [['Dark', 'dark'], ['Light', 'light']]) {
		await display.click();
		await page.getByRole('menuitemradio', { name: label, exact: true }).click();
		await expectLog(page, 'theme', value);
	}
	await display.click();
	await page.getByRole('menuitemcheckbox', { name: 'Recognize text in scanned pages' }).click();
	await expectLog(page, 'ocr', false);
	await display.click();
	await expect(page.getByRole('menuitemcheckbox', { name: 'Recognize text in scanned pages' })).not.toBeChecked();
	await page.keyboard.press('Escape');
	await update(page, { showOcr: false });
	await display.click();
	await expect(page.getByRole('menuitemcheckbox', { name: 'Recognize text in scanned pages' })).toHaveCount(0);
	await page.keyboard.press('Escape');
	const rotate = page.getByRole('button', { name: 'Rotate', exact: true });
	await rotate.focus();
	await rotate.press('ArrowUp');
	await expect(page.getByRole('menuitem', { name: 'Rotate right' })).toBeFocused();
	await page.keyboard.press('Home');
	await page.keyboard.press('Enter');
	await expectLog(page, 'rotate', -90);
	await rotate.click();
	await page.getByRole('menuitem', { name: 'Rotate right' }).click();
	await expectLog(page, 'rotate', 90);
	const select = page.getByRole('button', { name: 'Select tool' });
	const originalIcon = await select.locator('svg').innerHTML();
	await select.click();
	const hand = page.getByRole('button', { name: 'Hand tool' });
	await expect(hand).toHaveAttribute('aria-pressed', 'true');
	expect(await hand.locator('svg').innerHTML()).not.toBe(originalIcon);
	await hand.click();
	await expect(select).toHaveAttribute('aria-pressed', 'false');
	await page.getByRole('button', { name: 'Insert text, drawing or image' }).click();
	await expectLog(page, 'insert', true);
	await expect(page.getByRole('button', { name: 'Insert text, drawing or image' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('button', { name: 'Annotations', exact: true })).toHaveCount(0);
});

test('only one desktop menu stays open and Mac hint uses the command key', async ({ page }) => {
	await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }));
	await mount(page);
	await page.getByRole('button', { name: 'Zoom', exact: true }).click();
	await expect(page.getByText('⌘ + scroll to zoom')).toBeVisible();
	await page.getByRole('button', { name: 'Rotate', exact: true }).click();
	await expect(page.getByRole('menu')).toHaveCount(1);
	await expect(page.getByRole('menu', { name: 'Rotate' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Rotate', exact: true })).toBeFocused();
});

test('menus skip disabled items and remain usable in short viewports', async ({ page }) => {
	await page.setViewportSize({ width: 768, height: 240 });
	await mount(page);
	const display = page.getByRole('button', { name: 'Page display', exact: true });
	await display.focus();
	await display.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: 'Single page', exact: true })).toBeFocused();
	for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: 'Light', exact: true })).toBeFocused();
	await page.keyboard.press('End');
	await expect(page.getByRole('menuitemcheckbox', { name: 'Recognize text in scanned pages' })).toBeFocused();
	const box = await page.getByRole('menu').boundingBox();
	expect(box!.y + box!.height).toBeLessThanOrEqual(232);
	await page.keyboard.press('Escape');
	await expect(display).toBeFocused();
});

test('360px overflow contains working nested menus with independent keyboard focus', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 640 });
	await mount(page);
	const more = page.getByRole('button', { name: 'More view options' });
	await more.focus();
	await more.press('Enter');
	const zoom = page.getByRole('menuitem', { name: 'Zoom', exact: true });
	await expect(zoom).toBeFocused();
	await expect(page.getByRole('menuitem')).toHaveText(['Zoom (125%)', 'Page display', 'Rotate']);
	await zoom.press('ArrowRight');
	await expect(page.getByRole('menuitemradio', { name: 'Automatic', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Escape');
	await expect(zoom).toBeFocused();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await zoom.press('ArrowRight');
	await page.getByRole('menuitemradio', { name: 'Fit page' }).click();
	await expectLog(page, 'zoom', 'page-fit');
	await expect(more).toBeFocused();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await more.click();
	await page.getByRole('menuitem', { name: 'Page display', exact: true }).click();
	await page.getByRole('menuitemradio', { name: 'Split', exact: true }).click();
	await expectLog(page, 'layout', 'split');
	await more.click();
	await page.getByRole('menuitem', { name: 'Rotate', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Rotate right' }).click();
	await expectLog(page, 'rotate', 90);
	await more.click();
	await zoom.press('ArrowRight');
	await page.keyboard.press('Tab');
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Select tool' })).toBeFocused();
	await more.click();
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(more).not.toBeVisible();
	await expect(page.getByRole('menu')).toHaveCount(0);
});

for (const width of [360, 768, 1440, 2560]) {
	for (const dark of [false, true]) {
		test(`${width}px ${dark ? 'dark' : 'light'} stays 44px, named, borderless and viewport-clamped`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: 900 });
			await mount(page, 'en', dark);
			const toolbar = page.getByRole('toolbar');
			expect((await toolbar.boundingBox())?.height).toBe(44);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
			const title = page.getByText('A book-like PDF reader with a very long title that truncates');
			if (width >= 1024) await expect(title).toBeVisible();
			else await expect(title).not.toBeVisible();
			await expect(toolbar.locator('button:not([aria-label]):not(:has(span))')).toHaveCount(0);
			for (const button of await toolbar.getByRole('button').all()) {
				if (!(await button.isVisible())) continue;
				expect(await button.evaluate((element) => getComputedStyle(element).borderWidth)).toBe('0px');
				const box = await button.boundingBox();
				expect(box?.height).toBe(36);
				expect(box?.y).toBe(4);
			}
			if (width < 640) {
				await page.getByRole('button', { name: 'More view options' }).click();
				await page.getByRole('menuitem', { name: 'Page display', exact: true }).click();
			} else await page.getByRole('button', { name: 'Page display', exact: true }).click();
			for (const menu of await page.getByRole('menu').all()) {
				const box = await menu.boundingBox();
				expect(box!.x).toBeGreaterThanOrEqual(8);
				expect(box!.x + box!.width).toBeLessThanOrEqual(width - 8);
				expect(box!.y + box!.height).toBeLessThanOrEqual(892);
			}
			if (width !== 2560) {
				const screenshot = resolve(`../docs/dev/plans/assets/pv4/toolbar-${width}-${dark ? 'dark' : 'light'}.png`);
				await page.screenshot({ path: screenshot });
				await testInfo.attach('Toolbar and display menu', { path: screenshot, contentType: 'image/png' });
			}
		});
	}
}
