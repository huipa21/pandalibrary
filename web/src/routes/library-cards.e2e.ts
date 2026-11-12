import { expect, test, type Page } from '@playwright/test';

const stamp = '2026-11-03T08:00:00Z';
const library = (id: number, name: string, count = 0) => ({
	id, name, slug: name.toLowerCase(), visible_book_count: count, created_at: stamp, updated_at: stamp
});

async function authenticate(page: Page, role = 'admin') {
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'viewer', display_name: 'Viewer', role, locale: 'en' } } })
	);
	await page.route('**/api/v1/sync/pull?*', (route) =>
		route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: [] } })
	);
	await page.route('**/api/v1/libraries?*', (route) =>
		route.fulfill({ json: { items: [library(1, 'Main', 12)], next_cursor: null } })
	);
	await page.route('**/api/v1/admin/libraries?*', (route) =>
		route.fulfill({ json: { items: [library(1, 'Main', 12)], next_cursor: 'next-page' } })
	);
}

test('reader cards link the whole content and hide management controls', async ({ page }) => {
	await authenticate(page, 'user');
	await page.goto('/libraries');
	const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Main', exact: true }) });
	await expect(card.getByRole('link')).toHaveAttribute('href', '/library/1');
	await expect(card.getByRole('link')).toContainText('12 books');
	await expect(card.getByRole('link')).toContainText('main');
	await expect(card.getByRole('button')).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Edit Main', exact: true })).toHaveCount(0);
	await expect(page.locator('a[href="/admin/libraries?create=1"]')).toHaveCount(0);
});

test('admin cards open settings and deep links load targets beyond the first page', async ({ page }) => {
	await authenticate(page);
	const lookups: number[] = [];
	await page.route('**/api/v1/libraries/*', (route) => {
		const id = Number(new URL(route.request().url()).pathname.split('/').pop());
		lookups.push(id);
		return route.fulfill({ json: { library: library(id, id === 99 ? 'Archive' : 'Main', 12) } });
	});
	await page.goto('/libraries');
	await page.getByRole('link', { name: 'Edit Main', exact: true }).click();
	await expect(page.locator('#linked-library-1-name')).toHaveValue('Main');
	await page.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/admin/libraries?edit=99';
		link.textContent = 'Open Archive settings';
		document.body.append(link);
	});
	await page.getByRole('link', { name: 'Open Archive settings' }).click();
	await expect(page.locator('#linked-library-99-name')).toHaveValue('Archive');
	await expect(page.locator('#linked-library-99-slug')).toHaveValue('archive');
	await expect(page.locator('#linked-library-99-name')).toBeFocused();
	expect(lookups).toContain(99);

	await page.goto('/admin/libraries?edit=99');
	await expect(page.locator('#linked-library-99-name')).toHaveValue('Archive');
	await page.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/admin/libraries?create=1';
		link.textContent = 'Open new library';
		document.body.append(link);
	});
	await page.getByRole('link', { name: 'Open new library' }).click();
	await expect(page.locator('#create-library-name')).toBeFocused();
	await expect(page.locator('#linked-library-99-name')).toHaveCount(0);
});

test('failed deep-link lookup is visible and retryable', async ({ page }) => {
	await authenticate(page);
	let failed = true;
	await page.route('**/api/v1/libraries/99', (route) => failed
		? route.fulfill({ status: 500, json: { error: 'private server detail' } })
		: route.fulfill({ json: { library: library(99, 'Archive') } }));
	await page.goto('/admin/libraries?edit=99');
	const alert = page.getByRole('alert');
	await expect(alert).toBeVisible();
	await expect(page.getByText('private server detail')).toHaveCount(0);
	failed = false;
	await alert.getByRole('button', { name: 'Try again' }).click();
	await expect(page.locator('#linked-library-99-name')).toHaveValue('Archive');
});

test('card deletion keeps conflict localization and refreshes after success', async ({ page }) => {
	await authenticate(page);
	let conflict = true;
	let deleted = false;
	await page.route('**/api/v1/libraries?*', (route) =>
		route.fulfill({ json: { items: deleted ? [] : [library(1, 'Main', 12)], next_cursor: null } })
	);
	await page.route('**/api/v1/admin/libraries/1', (route) => {
		if (conflict) return route.fulfill({ status: 409, contentType: 'application/problem+json', json: { status: 409, title: 'Conflict' } });
		deleted = true;
		return route.fulfill({ json: { deleted: true } });
	});
	await page.goto('/libraries');
	await page.evaluate(() => {
		document.body.dataset.libraryChanges = '0';
		window.addEventListener('pandalibrary-libraries-changed', () => {
			document.body.dataset.libraryChanges = String(Number(document.body.dataset.libraryChanges) + 1);
		});
	});
	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Delete Main', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('This library cannot be deleted while it contains books');
	conflict = false;
	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Delete Main', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Main', exact: true })).toHaveCount(0);
	await expect(page.getByText('Deleted “Main”.')).toBeVisible();
	await expect(page.locator('body')).toHaveAttribute('data-library-changes', '1');
});
