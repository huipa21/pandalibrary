import { expect, test } from '@playwright/test';

const user = {
	id: 1,
	username: 'admin',
	display_name: 'Library Admin',
	role: 'admin',
	locale: 'en'
};

test('setup, manage an app password, sign out, and sign in', async ({ page }) => {
	let setupRequired = true;
	let authenticated = false;
	let passwords: Array<{ id: number; kind: string; label: string; created_at: string }> = [];
	let nextPasswordID = 1;

	await page.route('**/api/v1/setup', async (route) => {
		if (route.request().method() === 'POST') {
			setupRequired = false;
			authenticated = true;
			await route.fulfill({ json: { user } });
			return;
		}
		await route.fulfill({ json: { required: setupRequired } });
	});
	await page.route('**/api/v1/auth/me', async (route) => {
		if (authenticated) {
			await route.fulfill({ json: { user } });
			return;
		}
		await route.fulfill({
			status: 401,
			contentType: 'application/problem+json',
			body: JSON.stringify({ title: 'Unauthorized', status: 401 })
		});
	});
	await page.route('**/api/v1/auth/login', async (route) => {
		authenticated = true;
		await route.fulfill({ json: { user } });
	});
	await page.route('**/api/v1/auth/logout', async (route) => {
		authenticated = false;
		await route.fulfill({ json: { logged_out: true } });
	});
	await page.route('**/api/v1/me/profile', async (route) => {
		if (route.request().method() === 'PATCH') {
			await route.fulfill({ json: { user } });
			return;
		}
		await route.fulfill({ json: { user } });
	});
	await page.route('**/api/v1/me/app-passwords', async (route) => {
		if (route.request().method() === 'POST') {
			const body = route.request().postDataJSON() as { kind: string; label: string };
			const created = {
				id: nextPasswordID++,
				kind: body.kind,
				label: body.label,
				created_at: new Date().toISOString(),
				secret: 'ABCD-EFGH-JKLM-NPQR'
			};
			passwords = [...passwords, created];
			await route.fulfill({ json: { app_password: created } });
			return;
		}
		await route.fulfill({ json: { app_passwords: passwords } });
	});
	await page.route('**/api/v1/me/app-passwords/*', async (route) => {
		const id = Number(route.request().url().split('/').at(-1));
		passwords = passwords.filter((password) => password.id !== id);
		await route.fulfill({ json: { revoked: true } });
	});

	await page.goto('/setup');
	await page.getByLabel('One-time setup token').fill('setup-token');
	await page.getByLabel('Username').fill('admin');
	await page.getByLabel('Password').fill('correct horse battery');
	await page.getByRole('button', { name: 'Create administrator' }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();

	await page.getByRole('link', { name: 'Settings' }).click();
	await page.getByLabel('Service').selectOption('kosync');
	await page.getByLabel('Device label').fill('E-reader');
	await page.getByRole('button', { name: 'Create password' }).click();
	await expect(page.getByText('ABCD-EFGH-JKLM-NPQR')).toBeVisible();
	await page.getByRole('button', { name: 'Revoke' }).click();
	await expect(page.getByText('E-reader')).toHaveCount(0);

	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL('/login');
	await page.getByLabel('Username').fill('admin');
	await page.getByLabel('Password').fill('correct horse battery');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
});
