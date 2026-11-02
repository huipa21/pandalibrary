import { expect, test } from '@playwright/test';

test('has expected h1', async ({ page }) => {
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({
			status: 401,
			contentType: 'application/problem+json',
			body: JSON.stringify({ title: 'Unauthorized', status: 401 })
		})
	);
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
