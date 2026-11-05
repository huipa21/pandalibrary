import { expect, test } from '@playwright/test';
import { realAdmin, signInRealAdmin } from '../real-auth.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');

test('real server persists configured shelves and an empty layout across devices', async ({ page, browser }) => {
	test.setTimeout(90_000);
	await signInRealAdmin(page);
	await expect(page.locator('[data-dashboard-section]')).toHaveCount(3);

	await page.getByRole('button', { name: 'Configure dashboard' }).click();
	const dialog = page.getByRole('dialog', { name: 'Configure dashboard' });
	await dialog.getByRole('button', { name: 'Create shelf', exact: true }).click();
	const creator = page.getByRole('dialog', { name: 'Create shelf' });
	await creator.getByLabel('Shelf name').fill('Real server shelf');
	await creator.getByRole('button', { name: 'Create shelf', exact: true }).click();
	const select = dialog.getByLabel('Choose an existing shelf');
	await expect(select.locator('option', { hasText: 'Real server shelf' })).toHaveCount(1);
	await select.selectOption({ label: 'Real server shelf' });
	await dialog.getByRole('button', { name: 'Add shelf section' }).click();
	await dialog.getByRole('button', { name: 'Move Real server shelf up' }).click();
	await dialog.getByRole('button', { name: 'Remove Read', exact: true }).click();
	await dialog.getByRole('button', { name: 'Save dashboard' }).click();
	await expect.poll(async () => page.evaluate(async () => {
		const response = await fetch('/api/v1/me/settings');
		if (!response.ok) throw new Error(`Settings request failed: ${response.status}`);
		const body = await response.json() as { settings: Array<{ key: string; value: { version: number; sections: Array<{ id: string }> } }> };
		return body.settings.find((entry) => entry.key === 'dashboard.layout.v1')?.value;
	})).toMatchObject({ version: 1, sections: [{ id: 'continue_reading' }, { id: 'recently_added' }, { id: expect.stringMatching(/^shelf:\d+$/) }] });
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Real server shelf' })).toBeVisible();

	const other = await browser.newContext();
	try {
		const otherPage = await other.newPage();
		await otherPage.goto('/login');
		await otherPage.getByLabel('Username').fill(realAdmin.username);
		await otherPage.getByLabel('Password').fill(realAdmin.password);
		await otherPage.getByRole('button', { name: 'Sign in' }).click();
		await expect(otherPage).toHaveURL('/');
		await expect(otherPage.getByRole('heading', { name: 'Real server shelf' })).toBeVisible();
		await otherPage.evaluate(async () => {
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) {
				await new Promise<void>((resolve) =>
					navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
				);
			}
		});
		await otherPage.getByRole('button', { name: 'Configure dashboard' }).click();
		const otherDialog = otherPage.getByRole('dialog', { name: 'Configure dashboard' });
		for (const name of ['Continue Reading', 'Recently Added', 'Real server shelf']) {
			await otherDialog.getByRole('button', { name: `Remove ${name}`, exact: true }).click();
		}
		await other.setOffline(true);
		await otherDialog.getByRole('button', { name: 'Save dashboard' }).click();
		await expect(otherPage.getByRole('heading', { name: 'Your dashboard has no sections.' })).toBeVisible();
		await expect(otherPage.getByText('Dashboard saved on this device and waiting to sync.')).toBeVisible();
		await otherPage.reload();
		await expect(otherPage.getByRole('heading', { name: 'Your dashboard has no sections.' })).toBeVisible();
		await other.setOffline(false);
		await expect.poll(async () => page.evaluate(async () => {
			const response = await fetch('/api/v1/me/settings');
			if (!response.ok) throw new Error(`Settings request failed: ${response.status}`);
			const body = await response.json() as { settings: Array<{ key: string; value: { sections: unknown[] } }> };
			return body.settings.find((entry) => entry.key === 'dashboard.layout.v1')?.value.sections;
		})).toEqual([]);
		await otherPage.reload();
		await expect(otherPage.getByRole('heading', { name: 'Your dashboard has no sections.' })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Your dashboard has no sections.' })).toBeVisible();
	} finally {
		await other.close();
	}
});
