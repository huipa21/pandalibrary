import { expect, test } from '@playwright/test';
import { realAdmin, signInRealAdmin } from '../real-auth.js';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');

test('real server persists configured shelves and an empty layout across devices', async ({ page, browser }) => {
	test.setTimeout(90_000);
	await signInRealAdmin(page);
	await expect(page.locator('[data-dashboard-section]')).toHaveCount(3);

	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await sidebar.getByRole('button', { name: 'Collection actions' }).click();
	await sidebar.getByRole('menuitem', { name: 'New collection' }).click();
	const creator = page.getByRole('dialog', { name: 'Create collection' });
	await creator.getByLabel('Collection name').fill('Real server shelf');
	await creator.getByRole('button', { name: 'Create collection', exact: true }).click();
	await expect(creator).toBeHidden();
	// The collection picker is gone, so seed a saved layout that already contains the new shelf.
	await page.evaluate(async () => {
		const read = async <T>(path: string) => {
			const response = await fetch(path, { cache: 'no-store' });
			if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
			return await response.json() as T;
		};
		const { user } = await read<{ user: { id: number } }>('/api/v1/auth/me');
		let shelfID: number | undefined;
		let cursor: string | null = null;
		do {
			const page: { items: Array<{ id: number; name: string }>; next_cursor: string | null } =
				await read(`/api/v1/shelves${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
			shelfID = page.items.find((item) => item.name === 'Real server shelf')?.id;
			cursor = page.next_cursor;
		} while (shelfID === undefined && cursor);
		if (shelfID === undefined) throw new Error('Created shelf not found');
		const response = await fetch('/api/v1/sync/push', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-PandaLibrary-Account': String(user.id) },
			body: JSON.stringify({ mutations: [{
				entity: 'user_settings', key: 'dashboard.layout.v1', op: 'upsert', updated_at: Date.now(),
				data: { value: { version: 1, sections: [
					{ id: 'continue_reading' }, { id: 'recently_added' }, { id: 'read' }, { id: `shelf:${shelfID}` }
				] } }
			}] })
		});
		const body = await response.json() as { results: Array<{ status: string }> };
		if (!response.ok || body.results[0]?.status !== 'applied') throw new Error(`Layout seed failed: ${response.status}`);
	});
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Real server shelf' })).toBeVisible();
	await page.getByRole('button', { name: 'Configure dashboard' }).click();
	const dialog = page.getByRole('dialog', { name: 'Configure dashboard' });
	const shelfRow = dialog.locator('li[data-config-section^="shelf:"]');
	await expect(shelfRow).toContainText('Real server shelf');
	await shelfRow.focus();
	await page.keyboard.press('Alt+ArrowUp');
	await dialog.getByRole('button', { name: 'Remove Read', exact: true }).click();
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
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
		await otherDialog.getByRole('button', { name: 'Save', exact: true }).click();
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
