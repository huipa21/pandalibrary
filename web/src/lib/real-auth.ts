import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

export const realAdmin = { username: 'integration-admin', password: 'integration-test-password' };

export async function signInRealAdmin(page: Page) {
	const response = await page.request.get('/api/v1/setup');
	expect(response.ok()).toBe(true);
	const { required } = await response.json() as { required: boolean };
	await page.goto(required ? '/setup' : '/login');
	if (required) {
		const tokenFile = process.env.PANDA_E2E_SETUP_TOKEN_FILE;
		if (!tokenFile) throw new Error('Real-server setup token file is not configured.');
		await page.getByLabel('One-time setup token').fill((await readFile(tokenFile, 'utf8')).trim());
	}
	await page.getByLabel('Username', { exact: true }).fill(realAdmin.username);
	await page.getByLabel('Password', { exact: true }).fill(realAdmin.password);
	await page.getByRole('button', { name: required ? 'Create administrator' : 'Sign in', exact: true }).click();
	await expect(page).toHaveURL('/');
}
