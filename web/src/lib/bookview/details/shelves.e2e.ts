import { expect, test, type Page } from '@playwright/test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { build } from 'vite';
import type { Shelf } from '#lib/shelves/types.js';

test.use({ serviceWorkers: 'block', bypassCSP: true });

const shelf = (id: number, name: string, extra: Partial<Shelf> = {}): Shelf => ({
	id, name, kind: 'private', owner_id: 1, description: null, created_by: 1,
	visible_book_count: 1, created_at: '', updated_at: '', mode: 'manual', ...extra
});
const all = [
	shelf(1, 'Owned shelf'),
	shelf(2, 'Favorites', { system_key: 'favorites' }),
	shelf(3, 'Shared shelf', { kind: 'shared', owner_id: null }),
	shelf(4, 'New shelf')
];
let script: string;
let css: string;

// Same in-memory library build as covers.e2e.ts; no test-only application route.
test.beforeAll(async () => {
	const result = await build({
		configFile: false,
		plugins: [svelte()],
		resolve: { alias: [{ find: '#lib', replacement: resolve('src/lib') }] },
		build: {
			write: false,
			lib: { entry: resolve('src/lib/bookview/kit-fixture.ts'), formats: ['es'] }
		}
	});
	const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
		if (!('output' in item)) throw new Error('Unexpected fixture build result.');
		return item.output;
	});
	const chunk = outputs.find((output) => output.type === 'chunk');
	const style = outputs.find((output) => output.type === 'asset' && output.fileName.endsWith('.css'));
	if (!chunk || chunk.type !== 'chunk' || !style || style.type !== 'asset') {
		throw new Error('The shelf fixture did not produce JavaScript and CSS.');
	}
	script = chunk.code;
	css = typeof style.source === 'string' ? style.source : Buffer.from(style.source).toString('utf8');
});

async function mount(page: Page, locale: 'en' | 'zh' = 'en') {
	const state = {
		members: [1, 2, 3], deletes: [] as string[], puts: [] as string[],
		failDelete: false, failLoad: false, loads: 0
	};
	await page.route('**/cover-broken.png', (route) => route.fulfill({ status: 404, body: '' }));
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: {
			id: 1, username: 'reader', display_name: '', role: 'user', locale
		} } });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: []
		} });
		if (path === '/shelves') return route.fulfill({ json: { items: all, next_cursor: null } });
		if (path.startsWith('/shelves/system/')) return route.fulfill({ json: {
			shelf: all[1]
		} });
		if (/^\/books\/\d+\/shelves$/.test(path)) {
			state.loads++;
			if (state.failLoad) return route.fulfill({ status: 500, json: { status: 500, title: 'Failed' } });
			return route.fulfill({ json: { shelves: path.includes('/22/') ? [] : all.filter((s) => state.members.includes(s.id)) } });
		}
		const membership = /^\/shelves\/(\d+)\/books\/21$/.exec(path);
		if (membership && route.request().method() === 'DELETE') {
			state.deletes.push(path);
			if (state.failDelete) return route.fulfill({ status: 500, json: { status: 500, title: 'Failed' } });
			state.members = state.members.filter((id) => id !== Number(membership[1]));
			return route.fulfill({ json: { removed: true } });
		}
		if (membership && route.request().method() === 'PUT') {
			state.puts.push(path);
			state.members.push(Number(membership[1]));
			return route.fulfill({ json: { saved: true } });
		}
		if (path === '/version') return route.fulfill({ json: {
			version: 'test', commit: '0123456789abcdef', commit_date: '2026-11-08T00:00:00Z', dirty: false, release: null
		} });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/libraries') return route.fulfill({ json: { libraries: [] } });
		if (path === '/books') return route.fulfill({ json: { items: [], next_cursor: null } });
		if (/^\/(authors|series|tags)$/.test(path)) return route.fulfill({ json: { items: [], next_cursor: null } });
		return route.fulfill({ status: 404, json: { status: 404, title: 'Not found' } });
	});
	await page.goto('/books');
	await expect.poll(async () =>
		(await page.context().cookies()).find((cookie) => cookie.name === 'PARAGLIDE_LOCALE')?.value
	).toBe(locale);
	await page.evaluate(() => {
		const root = document.createElement('div');
		root.id = 'bv3-test-root';
		document.body.append(root);
	});
	await page.addStyleTag({ content: css });
	await page.addScriptTag({ content: script, type: 'module' });
	const section = page.locator('[data-test="shelf-tags"]');
	await expect(section.getByRole('link', { name: 'Owned shelf', exact: true })).toBeVisible();
	return { state, section };
}

test('tags respect permissions; Cancel keeps a tag, OK sends one DELETE and moves focus', async ({ page }) => {
	const { state, section } = await mount(page);
	const chips = section.locator('li[data-shelf-id]');
	await expect(chips.locator('a')).toHaveText(['Favorites', 'Owned shelf', 'Shared shelf']);
	await expect(section.getByRole('link', { name: 'Favorites', exact: true })).toHaveAttribute('href', '/shelves/system/favorites');
	await expect(section.getByRole('button', { name: 'Remove from Shared shelf', exact: true })).toHaveCount(0);
	const remove = section.getByRole('button', { name: 'Remove from Owned shelf', exact: true });
	await section.getByRole('link', { name: 'Owned shelf', exact: true }).hover();
	const corner = await remove.boundingBox();
	const chip = await chips.filter({ hasText: 'Owned shelf' }).boundingBox();
	expect(corner!.y).toBeLessThan(chip!.y);
	expect(corner!.x + corner!.width).toBeGreaterThan(chip!.x + chip!.width);
	page.once('dialog', async (dialog) => {
		expect(dialog.message()).toBe('Remove “Shelf Book 21” from “Owned shelf”?');
		await dialog.dismiss();
	});
	await remove.click();
	await expect(section.getByRole('link', { name: 'Owned shelf', exact: true })).toBeVisible();
	expect(state.deletes).toEqual([]);
	page.once('dialog', (dialog) => dialog.accept());
	await remove.click();
	await expect(section.getByRole('status')).toHaveText('Removed from Owned shelf');
	await expect(section.getByRole('link', { name: 'Shared shelf', exact: true })).toBeFocused();
	expect(state.deletes).toEqual(['/shelves/1/books/21']);
	expect(state.loads).toBe(1);
});

test('button picker opens downward, disables members, and adds a tag via the change event', async ({ page }) => {
	const { state, section } = await mount(page);
	const trigger = section.getByRole('button', { name: 'Add to shelf', exact: true });
	await trigger.click();
	const dialog = section.getByRole('dialog', { name: 'Add to shelf' });
	const option = dialog.getByRole('button', { name: /New shelf/ });
	await expect(option).toBeVisible();
	await expect(dialog.getByRole('button', { name: /Owned shelf/ })).toHaveAttribute('aria-disabled', 'true');
	await expect(dialog.getByRole('button', { name: /Shared shelf/ })).toHaveCount(0);
	const buttonBox = await trigger.boundingBox();
	const panelBox = await dialog.boundingBox();
	expect(panelBox!.y).toBeGreaterThanOrEqual(buttonBox!.y + buttonBox!.height);
	await option.click();
	await expect(section.getByRole('link', { name: 'New shelf', exact: true })).toBeVisible();
	await expect(trigger).toBeFocused();
	expect(state.puts).toEqual(['/shelves/4/books/21']);
});

test('keyboard reaches corner X and a failed DELETE restores the tag with an alert', async ({ page }) => {
	const { state, section } = await mount(page);
	state.failDelete = true;
	await section.getByRole('link', { name: 'Owned shelf', exact: true }).focus();
	await page.keyboard.press('Tab');
	const remove = section.getByRole('button', { name: 'Remove from Owned shelf', exact: true });
	await expect(remove).toBeFocused();
	await expect(remove).toHaveCSS('opacity', '1');
	page.once('dialog', (dialog) => dialog.accept());
	await page.keyboard.press('Enter');
	await expect(section.getByRole('alert')).toBeVisible();
	await expect(section.getByRole('link', { name: 'Owned shelf', exact: true })).toBeVisible();
	expect(state.deletes).toHaveLength(1);
});

test('offline chips are read-only and the factory reloads on book changes', async ({ page }) => {
	const { section } = await mount(page);
	await section.getByRole('checkbox', { name: 'Offline shelves' }).check();
	await expect(section.getByRole('link', { name: 'Owned shelf', exact: true })).toBeVisible();
	await expect(section.getByRole('button', { name: /^Remove from/ })).toHaveCount(0);
	await section.getByRole('button', { name: 'Switch shelf book' }).click();
	await expect(section).toContainText('Not on any shelf');
	await expect(section.locator('li[data-shelf-id]')).toHaveCount(0);
});

test('membership load failures expose Retry', async ({ page }) => {
	const { state, section } = await mount(page);
	state.failLoad = true;
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed')));
	await expect(section.getByRole('alert')).toBeVisible();
	state.failLoad = false;
	await section.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(section.getByRole('alert')).toHaveCount(0);
	await expect(section.getByRole('link', { name: 'Owned shelf', exact: true })).toBeVisible();
});

test('removing the final chip focuses the label and shows the empty state', async ({ page }) => {
	const { state, section } = await mount(page);
	state.members = [1];
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed')));
	await expect(section.locator('li[data-shelf-id]')).toHaveCount(1);
	await section.getByRole('link', { name: 'Owned shelf', exact: true }).hover();
	page.once('dialog', (dialog) => dialog.accept());
	await section.getByRole('button', { name: 'Remove from Owned shelf', exact: true }).click();
	await expect(section).toContainText('Not on any shelf');
	await expect(section.locator('p[tabindex="-1"]')).toBeFocused();
});

test('localizes shelf labels, removal confirmation, and notices in Chinese', async ({ page }) => {
	const { section } = await mount(page, 'zh');
	await expect(section.getByRole('link', { name: '收藏', exact: true })).toHaveAttribute('href', '/shelves/system/favorites');
	await section.getByRole('link', { name: 'Owned shelf', exact: true }).hover();
	page.once('dialog', async (dialog) => {
		expect(dialog.message()).toBe('确定将《Shelf Book 21》从“Owned shelf”移除吗？');
		await dialog.accept();
	});
	await section.getByRole('button', { name: '从Owned shelf移除', exact: true }).click();
	await expect(section.getByRole('status')).toHaveText('已从Owned shelf移除');
});

test('downward picker is clamped near the viewport edge, including after resize', async ({ page }) => {
	const { section } = await mount(page);
	await section.locator('[data-test="shelf-picker"]').evaluate((element) => {
		element.style.display = 'flex';
		element.style.justifyContent = 'flex-end';
	});
	await section.getByRole('button', { name: 'Add to shelf', exact: true }).click();
	const dialog = section.getByRole('dialog');
	await expect(dialog.getByRole('button', { name: /New shelf/ })).toBeVisible();
	for (const width of [620, 400, 800]) {
		await page.setViewportSize({ width, height: 900 });
		await expect.poll(async () => {
			const box = await dialog.boundingBox();
			return box !== null && box.x >= 15 && box.x + box.width <= width - 15 &&
				box.y >= 0 && box.y + box.height <= 885;
		}).toBe(true);
	}
});

test.describe('touch controls', () => {
	test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
	test('corner X is visible without hover', async ({ page }) => {
		const { section } = await mount(page);
		expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
		await expect(section.getByRole('button', { name: 'Remove from Owned shelf', exact: true })).toHaveCSS('opacity', '1');
	});
});
