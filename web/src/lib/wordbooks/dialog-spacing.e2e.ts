import { expect, test, type Locator, type Page } from '@playwright/test';

async function mockAPI(page: Page) {
	const book = {
		id: 1, name: 'Study', description: 'Study notes', is_default: false, archived: false,
		entry_count: 0, book_count: 0, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z'
	};
	await page.route('**/api/v1/**', (route) => {
		const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: {
			user: { id: 1, username: 'test', display_name: 'Test', role: 'user', locale: 'en' }
		} });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
		} });
		if (path === '/wordbooks') return route.fulfill({ json: { wordbooks: [book] } });
		if (path === '/wordbooks/1/entries') return route.fulfill({ json: { entries: [] } });
		if (path.startsWith('/shelves/system/')) return route.fulfill({ json: {
			shelf: { id: 9, name: 'Favorites', mode: 'system', system_key: 'favorites', kind: 'private', owner_id: 1, visible_book_count: 0 }
		} });
		return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
	});
}

async function expectFocusedGap(field: Locator) {
	await field.focus();
	await expect(field).toBeFocused();
	const geometry = await field.evaluate((element) => {
		const label = element.closest('label')!.querySelector('span')!;
		const style = getComputedStyle(element);
		const gap = element.getBoundingClientRect().top - label.getBoundingClientRect().bottom;
		return {
			gap,
			clearance: gap - parseFloat(style.outlineWidth) - Math.max(0, parseFloat(style.outlineOffset)),
			focusVisible: element.matches(':focus-visible'),
			outlineStyle: style.outlineStyle,
			outlineWidth: parseFloat(style.outlineWidth)
		};
	});
	expect(geometry.focusVisible).toBe(true);
	expect(geometry.outlineStyle).not.toBe('none');
	expect(geometry.outlineWidth).toBeGreaterThan(0);
	expect(geometry.gap).toBeCloseTo(8, 0);
	expect(geometry.clearance).toBeGreaterThanOrEqual(4);
}

for (const width of [1280, 360]) {
	for (const mode of ['new', 'rename'] as const) {
		test(`${mode} wordbook labels clear focused fields and cover controls at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await mockAPI(page);
			await page.goto(mode === 'new' ? '/wordbooks' : '/wordbooks?id=1');
			const trigger = page.getByRole('button', { name: mode === 'new' ? 'New wordbook' : 'Rename', exact: true });
			await trigger.click();
			const dialog = page.getByRole('dialog', { name: mode === 'new' ? 'New wordbook' : 'Rename', exact: true });
			await expect(dialog.getByLabel('Wordbook name', { exact: true })).toBeFocused();
			await page.keyboard.press('Tab');
			for (const name of ['Wordbook name', 'Description (optional)', 'Upload image']) {
				await expectFocusedGap(dialog.getByLabel(name, { exact: true }));
			}
			await expectFocusedGap(dialog.getByRole('combobox', { name: 'Cover color', exact: true }));
			const image = await page.evaluate(() => {
				const canvas = document.createElement('canvas');
				canvas.width = 600;
				canvas.height = 900;
				canvas.getContext('2d')!.fillRect(0, 0, 600, 900);
				return canvas.toDataURL('image/png').split(',')[1];
			});
			await dialog.locator('input[type="file"]').setInputFiles({
				name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64')
			});
			const sliders = dialog.getByRole('slider');
			await expect(sliders).toHaveCount(3);
			for (const slider of await sliders.all()) await expectFocusedGap(slider);
			await page.keyboard.press('Escape');
			await expect(dialog).not.toBeVisible();
			await expect(trigger).toBeFocused();
		});
	}
}
