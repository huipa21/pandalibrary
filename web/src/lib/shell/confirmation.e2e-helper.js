import { expect } from '@playwright/test';

/**
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<unknown>} action
 * @param {boolean} accepted
 * @param {(message: string) => void | Promise<void>} [check]
 */
export async function confirmInApp(page, action, accepted = true, check) {
	await action();
	const dialog = page.locator('#app-confirmation');
	await expect(dialog).toBeVisible();
	if (check) await check(await dialog.locator('#app-confirmation-message').innerText());
	await dialog.locator('button').nth(accepted ? 1 : 0).click();
	await expect(dialog).toHaveCount(0);
}

/** @param {import('@playwright/test').Page} page */
export async function autoConfirmInApp(page) {
	await page.addLocatorHandler(page.locator('#app-confirmation'), async (dialog) => {
		await dialog.locator('button').last().click();
	});
}
