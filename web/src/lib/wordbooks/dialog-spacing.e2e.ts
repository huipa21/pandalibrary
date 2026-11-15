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

async function expectActiveFocus(field: Locator) {
	await field.focus();
	const style = await field.evaluate((element) => {
		const computed = getComputedStyle(element);
		const probe = document.createElement('span');
		probe.style.color = 'var(--shell-active)';
		element.parentElement!.append(probe);
		const active = getComputedStyle(probe).color;
		probe.remove();
		return { color: computed.outlineColor, active, width: computed.outlineWidth, style: computed.outlineStyle };
	});
	expect(style).toEqual({ color: style.active, active: style.active, width: '2px', style: 'solid' });
}

for (const width of [1280, 360]) {
	for (const mode of ['new', 'rename'] as const) {
		test(`${mode} wordbook labels clear focused fields and cover controls at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await mockAPI(page);
			await page.goto(mode === 'new' ? '/wordbooks' : '/wordbooks?id=1');
			const trigger = page.getByRole('button', { name: mode === 'new' ? 'New wordbook' : 'Settings', exact: true });
			await trigger.click();
			const dialog = page.getByRole('dialog', { name: mode === 'new' ? 'New wordbook' : 'Settings', exact: true });
			await expect(dialog.getByLabel('Wordbook name', { exact: true })).toBeFocused();
			await page.keyboard.press('Tab');
			for (const name of ['Wordbook name', 'Description (optional)']) {
				await expectFocusedGap(dialog.getByLabel(name, { exact: true }));
			}
			for (const theme of ['light', 'dark']) {
				await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
				for (const name of ['Wordbook name', 'Description (optional)']) {
					await expectActiveFocus(dialog.getByLabel(name, { exact: true }));
				}
			}
			const swatches = dialog.getByRole('group', { name: 'Cover color', exact: true });
			await expect(swatches.getByRole('radio')).toHaveCount(20);
			await expect(swatches.getByRole('radio', { checked: true })).toHaveCount(1);
			const language = dialog.getByRole('combobox', { name: 'Language', exact: true });
			await expect(dialog.getByRole('combobox')).toHaveCount(1);
			await language.selectOption('zh');
			const selectLayout = await language.evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					height: element.getBoundingClientRect().height,
					lineHeight: parseFloat(style.lineHeight),
					padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
					border: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
					display: style.display,
					wrap: style.flexWrap,
					baseSelect: CSS.supports('appearance', 'base-select')
				};
			});
			expect(selectLayout.height).toBeLessThanOrEqual(selectLayout.lineHeight + selectLayout.padding + selectLayout.border + 1);
			if (selectLayout.baseSelect) {
				expect(selectLayout.display).toBe('flex');
				expect(selectLayout.wrap).toBe('nowrap');
			}
			const preview = await dialog.locator('.preview').boundingBox();
			const palette = await swatches.boundingBox();
			const dropzone = await dialog.getByTestId('cover-drop-zone').boundingBox();
			expect(preview).not.toBeNull();
			expect(palette).not.toBeNull();
			expect(dropzone).not.toBeNull();
			expect(palette!.x).toBeCloseTo(preview!.x, 0);
			expect(dropzone!.x).toBeCloseTo(palette!.x, 0);
			expect(preview!.y + preview!.height).toBeLessThanOrEqual(palette!.y);
			expect(palette!.y + palette!.height).toBeLessThanOrEqual(dropzone!.y);
			expect(palette!.width).toBeGreaterThan(preview!.width);
			if (width === 360) {
				expect(await dialog.locator('.cover-editor').evaluate((element) =>
					element.scrollWidth <= element.clientWidth &&
					document.documentElement.scrollWidth <= window.innerWidth
				)).toBe(true);
			}
			const crimson = swatches.getByRole('radio', { name: 'Crimson', exact: true });
			await crimson.check();
			await expect(crimson).toBeChecked();
			const navy = swatches.getByRole('radio', { name: 'Navy', exact: true });
			await navy.check();
			await expect(navy).toBeChecked();
			await expect(navy.locator('+ span')).toHaveCSS('background-color', 'rgb(31, 47, 92)');
			await navy.focus();
			await page.keyboard.press('ArrowRight');
			await expect(swatches.getByRole('radio', { name: 'Forest', exact: true })).toBeChecked();
			await expect(dialog.getByRole('button', { name: 'Upload image', exact: true })).toBeVisible();
			await expect(dialog.getByTestId('cover-drop-zone')).toHaveClass(/upload-dropzone/);
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

	test(`dropping a cover image uses the upload frame and preserves validation and cropping at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await mockAPI(page);
		await page.goto('/wordbooks');
		await page.getByRole('button', { name: 'New wordbook', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'New wordbook', exact: true });
		await dialog.getByLabel('Wordbook name', { exact: true }).fill('Dropped cover');
		const dropzone = dialog.getByTestId('cover-drop-zone');
		const invalid = await page.evaluateHandle(() => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' }));
			return transfer;
		});
		await dropzone.dispatchEvent('dragenter', { dataTransfer: invalid });
		await expect(dropzone).toHaveAttribute('data-dragging', 'true');
		await expect(dropzone).toContainText('Drop image to crop');
		await dropzone.dispatchEvent('drop', { dataTransfer: invalid });
		await expect(dropzone).not.toHaveAttribute('data-dragging');
		await expect(dialog.getByRole('alert')).toContainText('Choose a JPEG, PNG or WebP image');
		await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
		await invalid.dispose();
		const valid = await page.evaluateHandle(async () => {
			const canvas = document.createElement('canvas');
			canvas.width = 600;
			canvas.height = 900;
			const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
			const transfer = new DataTransfer();
			transfer.items.add(new File([blob], 'cover.png', { type: 'image/png' }));
			return transfer;
		});
		await dropzone.dispatchEvent('drop', { dataTransfer: valid });
		await valid.dispose();
		await expect(dialog.getByRole('alert')).toHaveCount(0);
		await expect(dialog.locator('.preview img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
		await expect(dialog.getByRole('slider')).toHaveCount(3);
		await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
	});
}
