import { expect, test, type Page } from '@playwright/test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import axe from 'axe-core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { BACKGROUNDS } from '../appearance.js';

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

async function update(page: Page, detail: Record<string, string | number | boolean>) {
	await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('pv4-fixture-update', { detail })), detail);
}

async function expectLog(page: Page, action: string, value: string | number | boolean) {
	await expect.poll(() => page.evaluate(() => window.log.at(-1))).toEqual({ action, value });
}

async function axeViolations(page: Page, selector: string) {
	await page.addScriptTag({ content: axe.source });
	return page.evaluate(async (selector) => {
		const target = document.querySelector(selector);
		if (!target) throw new Error(`The accessibility audit target ${selector} is missing.`);
		const results = await (window as Window & { axe: typeof axe }).axe.run(target);
		return results.violations.map(({ id, impact, nodes }) => ({
			id, impact, nodes: nodes.map(({ html, failureSummary }) => ({ html, failureSummary }))
		}));
	}, selector);
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
	await expect(page.getByRole('menuitemcheckbox', { name: '封面单独显示' })).toHaveCount(0);
	await expect(page.getByRole('menuitemradio')).toHaveCount(4);
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

test('four layouts, optional OCR, rotate and toggles follow props', async ({ page }) => {
	await mount(page);
	const display = page.getByRole('button', { name: 'Page display', exact: true });
	await display.click();
	await expect(page.getByRole('menuitemradio')).toHaveCount(4);
	await expect(page.getByRole('menuitemcheckbox')).toHaveCount(1);
	await expect(page.getByRole('menuitemcheckbox')).toHaveText('Recognize text in scanned pages');
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
	await expect(page.getByRole('menuitemcheckbox', { name: 'Recognize text in scanned pages' })).toBeFocused();
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
	await expect(page.getByRole('menuitem')).toHaveText(['Zoom (125%)', 'Page display', 'Format', 'Rotate']);
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

test('RP2 Format controls work with the keyboard and emit each change once', async ({ page }) => {
	await mount(page);
	const trigger = page.getByRole('button', { name: 'Format', exact: true });
	await expect(trigger).toHaveAttribute('title', 'Format');
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	expect(await trigger.evaluate((element) => {
		const box = element.getBoundingClientRect();
		return [box.width, box.height, getComputedStyle(element).borderWidth];
	})).toEqual([36, 36, '0px']);
	await trigger.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Format' });
	await expect(dialog).toBeVisible();
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await expect(trigger).toHaveAttribute('aria-controls', await dialog.getAttribute('id') ?? '');
	expect((await dialog.boundingBox())?.width).toBe(280);

	const font = dialog.getByRole('radiogroup', { name: 'Font' });
	await expect(font.getByRole('radio', { name: 'Serif' })).toBeFocused();
	await expect(font.getByRole('radio', { name: 'Serif' })).toBeChecked();
	await page.keyboard.press('ArrowRight');
	await expect(font.getByRole('radio', { name: 'Sans' })).toBeFocused();
	await expect(font.getByRole('radio', { name: 'Sans' })).toBeChecked();
	await page.keyboard.press('ArrowDown');
	await expect(font.getByRole('radio', { name: 'System' })).toBeChecked();
	await expect(font.locator('[tabindex="0"]')).toHaveCount(1);

	await page.keyboard.press('Tab');
	await expect(dialog.getByRole('button', { name: 'Decrease font size' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(dialog.getByRole('group', { name: 'Size' }).locator('output')).toHaveText('90%');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Space');
	await expect(dialog.getByRole('group', { name: 'Size' }).locator('output')).toHaveText('100%');
	await page.keyboard.press('Tab');
	await expect(dialog.getByRole('button', { name: 'Decrease spacing' })).toBeFocused();
	await page.keyboard.press('Space');
	await expect(dialog.getByRole('group', { name: 'Spacing' }).locator('output')).toHaveText('1.4');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Enter');
	await expect(dialog.getByRole('group', { name: 'Spacing' }).locator('output')).toHaveText('1.5');

	await page.keyboard.press('Tab');
	const backgrounds = dialog.getByRole('radiogroup', { name: 'Background' });
	await expect(backgrounds.getByRole('radio', { name: 'White' })).toBeFocused();
	await expect(backgrounds.getByRole('radio')).toHaveCount(10);
	await expect(backgrounds.locator('[tabindex="0"]')).toHaveCount(1);
	const swatchBoxes = await backgrounds.getByRole('radio').evaluateAll((buttons) =>
		buttons.map((button) => {
			const rect = button.getBoundingClientRect();
			return { x: rect.x, y: rect.y };
		})
	);
	expect(new Set(swatchBoxes.slice(0, 5).map((box) => box.y)).size).toBe(1);
	expect(new Set(swatchBoxes.slice(5).map((box) => box.y)).size).toBe(1);
	expect(swatchBoxes[5].y).toBeGreaterThan(swatchBoxes[0].y);
	expect(swatchBoxes.slice(0, 5).map((box) => box.x)).toEqual(swatchBoxes.slice(5).map((box) => box.x));
	await page.keyboard.press('ArrowRight');
	await expect(backgrounds.getByRole('radio', { name: 'Cream' })).toBeFocused();
	await expect(backgrounds.getByRole('radio', { name: 'Cream' })).toBeChecked();
	await page.keyboard.press('End');
	await expect(backgrounds.getByRole('radio', { name: 'Black' })).toBeChecked();
	await page.keyboard.press('ArrowLeft');
	await expect(backgrounds.getByRole('radio', { name: 'Night' })).toBeChecked();
	await page.keyboard.press('Home');
	await expect(backgrounds.getByRole('radio', { name: 'White' })).toBeChecked();
	await expect(backgrounds.getByRole('radio', { name: 'White' })).toContainText('✓');
	await expect(backgrounds.getByRole('radio', { name: 'Wood' })).toHaveAttribute('title', 'Wood');
	expect(await backgrounds.getByRole('radio', { name: 'Wood' }).evaluate((element) => {
		const box = element.getBoundingClientRect();
		return [box.width, box.height, getComputedStyle(element).backgroundImage];
	})).toEqual([28, 28, expect.stringContaining('repeating-linear-gradient')]);
	expect(await page.evaluate(() => window.log)).toEqual([
		{ action: 'font', value: 'sans-serif' },
		{ action: 'font', value: 'system' },
		{ action: 'size', value: 90 },
		{ action: 'size', value: 100 },
		{ action: 'spacing', value: 1.4 },
		{ action: 'spacing', value: 1.5 },
		{ action: 'background', value: 'cream' },
		{ action: 'background', value: 'black' },
		{ action: 'background', value: 'night' },
		{ action: 'background', value: 'white' }
	]);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await trigger.click();
	await page.getByText('PDF page fixture').click();
	await expect(dialog).toHaveCount(0);
});

test('RP2 steppers clamp to their limits and disable the corresponding buttons', async ({ page }) => {
	await mount(page);
	await update(page, { formatSize: 50, formatSpacing: 1 });
	await page.getByRole('button', { name: 'Format', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Format' });
	const smaller = dialog.getByRole('button', { name: 'Decrease font size' });
	const larger = dialog.getByRole('button', { name: 'Increase font size' });
	const tighter = dialog.getByRole('button', { name: 'Decrease spacing' });
	const looser = dialog.getByRole('button', { name: 'Increase spacing' });
	await expect(smaller).toBeDisabled();
	await expect(tighter).toBeDisabled();
	await smaller.evaluate((button: HTMLButtonElement) => button.click());
	await tighter.evaluate((button: HTMLButtonElement) => button.click());
	expect(await page.evaluate(() => window.log)).toEqual([]);
	await larger.click();
	await looser.click();
	await expectLog(page, 'spacing', 1.1);
	await expect(dialog.getByRole('group', { name: 'Size' }).locator('output')).toHaveText('60%');
	await expect(dialog.getByRole('group', { name: 'Spacing' }).locator('output')).toHaveText('1.1');
	await update(page, { formatSize: 200, formatSpacing: 2.5 });
	await expect(larger).toBeDisabled();
	await expect(looser).toBeDisabled();
	await smaller.click();
	await tighter.click();
	await expectLog(page, 'spacing', 2.4);
	await expect(dialog.getByRole('group', { name: 'Size' }).locator('output')).toHaveText('190%');
	await update(page, { formatSize: 195, formatSpacing: 2.45 });
	await larger.click();
	await looser.click();
	await expect(dialog.getByRole('group', { name: 'Size' }).locator('output')).toHaveText('200%');
	await expect(dialog.getByRole('group', { name: 'Spacing' }).locator('output')).toHaveText('2.5');
	await expect(larger).toBeDisabled();
	await expect(looser).toBeDisabled();
	expect(await page.evaluate(() => window.log)).toEqual([
		{ action: 'size', value: 60 }, { action: 'spacing', value: 1.1 },
		{ action: 'size', value: 190 }, { action: 'spacing', value: 2.4 },
		{ action: 'size', value: 200 }, { action: 'spacing', value: 2.5 }
	]);
});

test('RP2 PDF mode hides typography, focuses its selected swatch, and localizes the hint', async ({ page }) => {
	await mount(page, 'zh');
	await update(page, { typography: false, formatBackground: 'night' });
	const trigger = page.getByRole('button', { name: '格式', exact: true });
	await trigger.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: '格式' });
	await expect(dialog.getByRole('heading', { name: '字体' })).toHaveCount(0);
	await expect(dialog.getByRole('heading', { name: '字号' })).toHaveCount(0);
	await expect(dialog.getByRole('heading', { name: '行距' })).toHaveCount(0);
	await expect(dialog.getByRole('radiogroup', { name: '背景' })).toBeVisible();
	await expect(dialog.getByText('字体选项适用于可重排的图书（EPUB、MOBI、FB2）。')).toBeVisible();
	await expect(dialog.getByRole('radio', { name: '夜间' })).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(dialog.getByRole('radio', { name: '黑色' })).toBeChecked();
	await expectLog(page, 'background', 'black');
	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();
});

test('RP2 Format remains usable inside the compact overflow menu', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 640 });
	await mount(page);
	const more = page.getByRole('button', { name: 'More view options' });
	await more.focus();
	await page.keyboard.press('Enter');
	const trigger = page.getByRole('menuitem', { name: 'Format', exact: true });
	await trigger.focus();
	await page.keyboard.press('ArrowRight');
	const dialog = page.getByRole('dialog', { name: 'Format' });
	await expect(dialog.getByRole('radio', { name: 'Serif' })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await page.keyboard.press('Enter');
	await expect(dialog.getByRole('radio', { name: 'Serif' })).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(dialog.getByRole('radio', { name: 'Sans' })).toBeChecked();
	await dialog.getByRole('button', { name: 'Increase font size' }).click();
	await expectLog(page, 'size', 110);
	await dialog.getByRole('radio', { name: 'Wood' }).click();
	await expectLog(page, 'background', 'wood');
	await expect(dialog).toBeVisible();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	expect(await axeViolations(page, '.pv4-overflow > [role="group"]')).toEqual([]);
	const box = await dialog.boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(8);
	expect(box!.x + box!.width).toBeLessThanOrEqual(352);
	expect(box!.y + box!.height).toBeLessThanOrEqual(632);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await update(page, { typography: false });
	await page.keyboard.press('Enter');
	await expect(dialog.getByRole('radio', { name: 'Wood' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog).toHaveCount(0);
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('button', { name: 'Select tool' })).toBeFocused();
	await more.click();
	await trigger.click();
	await page.getByText('PDF page fixture').click();
	await expect(dialog).toHaveCount(0);
	await expect(more).toHaveAttribute('aria-expanded', 'false');
});

test('RP2 clamps a scrollable dialog in a short viewport and closes it at the overflow breakpoint', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 160 });
	await mount(page);
	const more = page.getByRole('button', { name: 'More view options' });
	await more.click();
	await page.getByRole('menuitem', { name: 'Format', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Format' });
	await expect(dialog.getByRole('radio', { name: 'Serif' })).toBeFocused();
	const box = await dialog.boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(8);
	expect(box!.x + box!.width).toBeLessThanOrEqual(352);
	expect(box!.y).toBeGreaterThanOrEqual(8);
	expect(box!.y + box!.height).toBeLessThanOrEqual(152);
	await dialog.getByRole('radio', { name: 'Wood' }).click();
	await expectLog(page, 'background', 'wood');
	await page.setViewportSize({ width: 768, height: 160 });
	await expect(dialog).toHaveCount(0);
	const desktop = page.getByRole('button', { name: 'Format', exact: true });
	await desktop.click();
	const desktopBox = await dialog.boundingBox();
	expect(desktopBox!.y + desktopBox!.height).toBeLessThanOrEqual(152);
	await page.keyboard.press('Escape');
	await expect(desktop).toBeFocused();
});

for (const dark of [false, true]) {
	for (const typography of [false, true]) {
		test(`RP2 ${dark ? 'dark' : 'light'} ${typography ? 'typography' : 'PDF'} menu passes axe`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width: 768, height: 500 });
			await mount(page, 'en', dark);
			await update(page, { typography });
			await page.getByRole('button', { name: 'Format', exact: true }).click();
			const dialog = page.getByRole('dialog', { name: 'Format' });
			const box = await dialog.boundingBox();
			expect(box!.x).toBeGreaterThanOrEqual(8);
			expect(box!.x + box!.width).toBeLessThanOrEqual(760);
			expect(box!.y + box!.height).toBeLessThanOrEqual(492);
			expect(await axeViolations(page, '.pv4-collapsible [role="group"][aria-label="Format"]')).toEqual([]);
			const screenshot = testInfo.outputPath(`format-${dark ? 'dark' : 'light'}-${typography ? 'typography' : 'pdf'}.png`);
			await dialog.screenshot({ path: screenshot, animations: 'disabled' });
			await testInfo.attach('Format menu', { path: screenshot, contentType: 'image/png' });
		});
	}
}

test('RP2 PDF appearance overrides legacy themes and matches every preset', async ({ page }) => {
	await mount(page);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const appearance = await readFile(resolve('src', 'lib', 'reader', 'pdf', 'appearance.css'), 'utf8');
	const legacy = await readFile(resolve('src', 'lib', 'reader', 'pdf', 'pdf.css'), 'utf8');
	await page.addStyleTag({ content: `${appearance}\n${legacy}` });
	await page.evaluate(() => {
		const host = document.createElement('div');
		host.className = 'reader-pdf';
		host.innerHTML = '<div class="pdfViewer removePageBorders"><div class="page"><canvas></canvas></div></div>';
		document.body.append(host);
	});
	const viewport = page.locator('.reader-pdf');
	const sheet = viewport.locator('.page');
	const canvas = sheet.locator('canvas');
	for (const preset of BACKGROUNDS) {
		await viewport.evaluate((element, { id, tone }) => {
			element.setAttribute('data-background', id);
			element.setAttribute('data-tone', tone);
			element.setAttribute('data-theme', tone === 'light' ? 'dark' : 'sepia');
		}, preset);
		const properties = await viewport.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				page: style.getPropertyValue('--rp-page').trim(),
				text: style.getPropertyValue('--rp-text').trim(),
				grain: style.getPropertyValue('--rp-grain').trim(),
				backdrop: style.backgroundColor
			};
		});
		expect(properties.page).toBe(preset.page);
		expect(properties.text).toBe(preset.text);
		expect(properties.grain).toBe(preset.grain ?? 'none');
		expect(properties.backdrop).toBe(preset.tone === 'dark' ? 'rgb(24, 24, 27)' : 'rgb(226, 232, 240)');
		const rgb = preset.page.match(/\w\w/g)!.map((channel) => parseInt(channel, 16));
		await expect(sheet).toHaveCSS('background-color', `rgb(${rgb.join(', ')})`);
		await expect(sheet).toHaveCSS('background-image', preset.grain ? /repeating-linear-gradient/ : 'none');
		await expect(canvas).toHaveCSS('mix-blend-mode', preset.tone === 'dark' ? 'screen' : 'multiply');
		await expect(canvas).toHaveCSS('filter', preset.tone === 'dark' ? 'invert(1) hue-rotate(180deg)' : 'none');
		await expect(canvas).toHaveCSS('transition-property', 'none');
	}
});

test('RP2 PDF canvas blending renders tinted paper and legible ink', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setContent('<!doctype html><html lang="en"><body><div class="reader-pdf"><div class="pdfViewer removePageBorders"><div class="page" style="width:60px;height:40px"><div class="canvasWrapper"><canvas role="presentation" width="60" height="40"></canvas></div></div></div></div></body></html>');
	await page.addStyleTag({ content: await readFile(resolve('node_modules', 'pdfjs-dist', 'web', 'pdf_viewer.css'), 'utf8') });
	await page.addStyleTag({ content: await readFile(resolve('src', 'lib', 'reader', 'pdf', 'pdf.css'), 'utf8') });
	await page.addStyleTag({ content: await readFile(resolve('src', 'lib', 'reader', 'pdf', 'appearance.css'), 'utf8') });
	await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas 2D context is unavailable.');
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, 60, 40);
		context.fillStyle = '#000000';
		context.fillRect(30, 0, 30, 40);
	});
	const viewport = page.locator('.reader-pdf');
	const sheet = viewport.locator('.page');
	for (const { id, tone, paper, ink } of [
		{ id: 'cream', tone: 'light', paper: [250, 246, 236], ink: [0, 0, 0] },
		{ id: 'night', tone: 'dark', paper: [28, 28, 30], ink: [255, 255, 255] }
	]) {
		await viewport.evaluate((element, { id, tone }) => {
			element.setAttribute('data-background', id);
			element.setAttribute('data-tone', tone);
		}, { id, tone });
		const screenshot = await sheet.screenshot({ animations: 'disabled' });
		const pixels = await page.evaluate(async (base64) => {
			const image = new Image();
			image.src = `data:image/png;base64,${base64}`;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('Canvas 2D context is unavailable.');
			context.drawImage(image, 0, 0);
			return [10, 50].map((x) => [...context.getImageData(x, 20, 1, 1).data].slice(0, 3));
		}, screenshot.toString('base64'));
		for (const [actual, expected] of [[pixels[0], paper], [pixels[1], ink]]) {
			for (let channel = 0; channel < 3; channel++) {
				expect(Math.abs(actual[channel] - expected[channel])).toBeLessThanOrEqual(1);
			}
		}
	}
});

test('RP1 keeps the position block and centred title stable across page counts', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await mount(page);
	await page.getByRole('toolbar').screenshot({ path: testInfo.outputPath('rp1-toolbar.png') });

	const samples = [];
	for (const [current, total, fraction, progress] of [
		[1, 9, 0, '0.00%'],
		[9, 9, 1, '100.00%'],
		[12345, 99999, .5, '50.00%']
	] as const) {
		await update(page, { page: current, pageCount: total, fraction });
		await expect(page.getByRole('textbox')).toHaveValue(String(current));
		await expect(page.locator('.pv4-progress')).toHaveText(progress);
		samples.push(await page.evaluate(() => {
			const title = document.querySelector('.pv-title')!.getBoundingClientRect();
			const left = document.querySelector('.pv4-left')!.getBoundingClientRect();
			const toolbar = document.querySelector('.pv4-toolbar')!.getBoundingClientRect();
			return { titleX: title.x, titleCentre: title.x + title.width / 2, leftWidth: left.width, toolbarCentre: toolbar.x + toolbar.width / 2 };
		}));
	}

	for (const sample of samples) {
		expect(Math.abs(sample.titleX - samples[0].titleX)).toBeLessThanOrEqual(.5);
		expect(Math.abs(sample.leftWidth - samples[0].leftWidth)).toBeLessThanOrEqual(.5);
		expect(Math.abs(sample.titleCentre - sample.toolbarCentre)).toBeLessThanOrEqual(1);
	}
});

test('RP1 uses fixed tabular number boxes and keeps status after the position', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await mount(page);
	await update(page, { page: 12345, pageCount: 99999, fraction: 1 });
	await expect(page.locator('.pv4-total')).toHaveText('99999');
	await expect(page.locator('.pv4-progress')).toHaveText('100.00%');
	const metrics = await page.evaluate(() => {
		const input = document.querySelector<HTMLInputElement>('.pv4-page')!;
		const total = document.querySelector<HTMLElement>('.pv4-total')!;
		const progress = document.querySelector<HTMLElement>('.pv4-progress')!;
		const status = document.querySelector<HTMLElement>('.status')!;
		const left = document.querySelector<HTMLElement>('.pv4-left')!;
		const probe = document.createElement('span');
		probe.style.cssText = 'display:inline-block;position:absolute;width:1ch;visibility:hidden;font:inherit;font-variant-numeric:tabular-nums';
		progress.append(probe);
		const ch = probe.getBoundingClientRect().width;
		probe.remove();
		const textRange = document.createRange();
		textRange.selectNodeContents(progress);
		const text = textRange.getBoundingClientRect();
		const progressBox = progress.getBoundingClientRect();
		const inputStyle = getComputedStyle(input);
		const totalStyle = getComputedStyle(total);
		const progressStyle = getComputedStyle(progress);
		return {
			inputWidth: parseFloat(inputStyle.width) / ch,
			totalWidth: total.getBoundingClientRect().width / ch,
			progressWidth: progressBox.width / ch,
			inputMode: input.inputMode,
			inputAlign: inputStyle.textAlign,
			totalAlign: totalStyle.textAlign,
			progressAlign: progressStyle.textAlign,
			inputNumeric: inputStyle.fontVariantNumeric,
			totalNumeric: totalStyle.fontVariantNumeric,
			progressNumeric: progressStyle.fontVariantNumeric,
			gap: progressBox.left - total.getBoundingClientRect().right,
			expectedGap: parseFloat(getComputedStyle(left).fontSize) / 2,
			whiteSpace: getComputedStyle(left).whiteSpace,
			statusWhiteSpace: getComputedStyle(status).whiteSpace,
			textLeft: text.left,
			textRight: text.right,
			progressLeft: progressBox.left,
			statusX: status.getBoundingClientRect().x,
			progressRight: progressBox.right
		};
	});

	expect(metrics.inputWidth).toBeCloseTo(5, 1);
	expect(metrics.totalWidth).toBeCloseTo(5, 1);
	expect(metrics.progressWidth).toBeCloseTo(7, 1);
	expect(metrics.inputMode).toBe('numeric');
	expect([metrics.inputAlign, metrics.totalAlign, metrics.progressAlign]).toEqual(['right', 'left', 'right']);
	for (const value of [metrics.inputNumeric, metrics.totalNumeric, metrics.progressNumeric]) {
		expect(value).toContain('tabular-nums');
	}
	expect(metrics.gap).toBeCloseTo(metrics.expectedGap, 1);
	expect(metrics.whiteSpace).toBe('nowrap');
	expect(metrics.statusWhiteSpace).toBe('normal');
	expect(metrics.textLeft).toBeGreaterThanOrEqual(metrics.progressLeft - .5);
	expect(metrics.textRight).toBeLessThanOrEqual(metrics.progressRight + .5);
	expect(metrics.statusX).toBeGreaterThanOrEqual(metrics.progressRight);

	await page.locator('.status').evaluate((element) => element.remove());
	const emptyStatus = await page.evaluate(() => {
		const left = document.querySelector('.pv4-left')!.getBoundingClientRect();
		const counter = document.querySelector('.pv4-counter')!.getBoundingClientRect();
		const progress = document.querySelector('.pv4-progress')!.getBoundingClientRect();
		return left.width - (progress.right - counter.left);
	});
	expect(Math.abs(emptyStatus)).toBeLessThanOrEqual(.5);
});

test('RP1 fits the mobile toolbar with a full-width status control', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 640 });
	await mount(page);
	await update(page, { page: 12345, pageCount: 99999, fraction: 1 });
	await page.locator('.status').evaluate((element: HTMLElement) => { element.style.width = '36px'; });
	const metrics = await page.evaluate(() => {
		const counter = document.querySelector('.pv4-counter')!.getBoundingClientRect();
		const progress = document.querySelector('.pv4-progress')!.getBoundingClientRect();
		const status = document.querySelector('.status')!.getBoundingClientRect();
		const right = document.querySelector('.pv4-right')!.getBoundingClientRect();
		const probe = document.createElement('span');
		probe.style.cssText = 'display:inline-block;position:absolute;width:22ch;visibility:hidden;font:inherit;font-variant-numeric:tabular-nums';
		document.querySelector('.pv4-progress')!.append(probe);
		const maxWidth = probe.getBoundingClientRect().width;
		probe.remove();
		return { blockWidth: progress.right - counter.left, maxWidth, statusRight: status.right, rightX: right.x, rightEdge: right.right, scrollWidth: document.documentElement.scrollWidth };
	});

	expect(metrics.blockWidth).toBeLessThanOrEqual(metrics.maxWidth);
	expect(metrics.statusRight).toBeLessThanOrEqual(metrics.rightX);
	expect(metrics.rightEdge).toBeLessThanOrEqual(360);
	expect(metrics.scrollWidth).toBe(360);
	await expect(page.locator('.pv-title')).not.toBeVisible();
	await page.getByRole('button', { name: 'More view options' }).click();
	await expect(page.getByRole('menuitem', { name: 'Zoom', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');

	await page.setViewportSize({ width: 320, height: 640 });
	await page.locator('.status').evaluate((element: HTMLElement) => { element.style.display = 'none'; });
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
	const close = await page.getByRole('button', { name: 'Close reader' }).boundingBox();
	expect(close!.x + close!.width).toBeLessThanOrEqual(320);
});

test('RP1 truncates a long title without colliding with desktop controls', async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 900 });
	await mount(page);
	await page.locator('.pv-title').evaluate((element) => { element.textContent = 'A very long book title '.repeat(30); });
	const measure = () => page.evaluate(() => {
		const title = document.querySelector<HTMLElement>('.pv-title')!;
		const left = document.querySelector('.pv4-left')!.getBoundingClientRect();
		const right = document.querySelector('.pv4-right')!.getBoundingClientRect();
		const titleBox = title.getBoundingClientRect();
		const toolbar = document.querySelector('.pv4-toolbar')!.getBoundingClientRect();
		return {
			titleX: titleBox.x, titleRight: titleBox.right, titleWidth: titleBox.width, titleCentre: titleBox.x + titleBox.width / 2,
			toolbarCentre: toolbar.x + toolbar.width / 2, leftRight: left.right, rightX: right.x,
			clipped: title.scrollWidth > title.clientWidth, overflow: getComputedStyle(title).textOverflow
		};
	});
	const expectClearance = async () => {
		await expect.poll(async () => {
			const metrics = await measure();
			return Math.max(
				Math.abs(metrics.titleCentre - metrics.toolbarCentre) - 1,
				metrics.leftRight - metrics.titleX,
				metrics.titleRight - metrics.rightX
			);
		}).toBeLessThanOrEqual(0);
	};

	for (const width of [1024, 1280, 2560]) {
		await page.setViewportSize({ width, height: 900 });
		await expectClearance();
		const metrics = await measure();
		expect(metrics.clipped).toBe(true);
		expect(metrics.overflow).toBe('ellipsis');
		expect(metrics.titleWidth).toBeLessThanOrEqual(Math.min(width * .48, 640) + .5);
	}

	await page.setViewportSize({ width: 1024, height: 900 });
	await expectClearance();
	const originalWidth = (await measure()).titleWidth;
	await page.locator('.status').evaluate((element: HTMLElement) => { element.style.width = '340px'; });
	await expectClearance();
	const expandedStatusWidth = (await measure()).titleWidth;
	expect(expandedStatusWidth).toBeLessThan(originalWidth);
	await page.locator('.status').evaluate((element: HTMLElement) => { element.style.width = '5px'; });
	await expect.poll(async () => (await measure()).titleWidth).toBeGreaterThan(expandedStatusWidth + 100);
	await expectClearance();

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.locator('.pv4-toolbar').evaluate((element: HTMLElement) => { element.style.width = '900px'; });
	await expectClearance();
});

test('RP1 switches the title and overflow at the specified breakpoints', async ({ page }) => {
	await page.setViewportSize({ width: 639, height: 900 });
	await mount(page);
	for (const width of [639, 640, 1023, 1024]) {
		await page.setViewportSize({ width, height: 900 });
		const title = page.locator('.pv-title');
		const overflow = page.locator('.pv4-overflow');
		const collapsible = page.locator('.pv4-collapsible');
		if (width < 1024) await expect(title).not.toBeVisible();
		else await expect(title).toBeVisible();
		if (width < 640) {
			await expect(overflow).toBeVisible();
			await expect(collapsible).not.toBeVisible();
		} else {
			await expect(overflow).not.toBeVisible();
			await expect(collapsible).toBeVisible();
		}
		const metrics = await page.evaluate(() => ({
			columns: getComputedStyle(document.querySelector('.pv4-toolbar')!).gridTemplateColumns.split(/\s+/).length,
			scrollWidth: document.documentElement.scrollWidth
		}));
		expect(metrics.columns).toBe(width < 1024 ? 2 : 3);
		expect(metrics.scrollWidth).toBe(width);
	}
});
