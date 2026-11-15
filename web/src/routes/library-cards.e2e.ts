import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const stamp = '2026-11-03T08:00:00Z';
const library = (id: number, name: string, count = 0) => ({
	id, name, slug: name.toLowerCase(), visible_book_count: count, created_at: stamp, updated_at: stamp
});

async function authenticate(page: Page, role = 'admin') {
	await page.route((url) => url.pathname.startsWith('/api/v1/'), (route) => {
		const path = new URL(route.request().url()).pathname.slice('/api/v1'.length);
		if (path === '/shelves') return route.fulfill({ json: { items: [], next_cursor: null } });
		if (path === '/shelves/system/favorites') return route.fulfill({ json: { shelf: { key: 'favorites', name: 'Favorites', mode: 'manual', shelf_id: null, visible_book_count: 0 } } });
		if (path === '/me/notes' || path === '/admin/bookheap/items') return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
		if (path === '/wordbooks') return route.fulfill({ json: { wordbooks: [] } });
		if (path === '/books/count') return route.fulfill({ json: { count: 12 } });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/version') return route.fulfill({ json: { version: 'test', commit: 'test', commit_date: stamp, dirty: false, release: null } });
		return route.fallback();
	});
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
	await page.route('**/api/v1/admin/libraries/*/access?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route('**/api/v1/admin/users?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
}

test('reader covers open read-only settings and hide management controls', async ({ page }) => {
	await authenticate(page, 'user');
	await page.goto('/libraries');
	const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Main', exact: true }) });
	await expect(card.getByRole('link')).toHaveAttribute('href', '/libraries/1');
	await expect(card).toContainText('12 books');
	await expect(card).toContainText('main');
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
	await page.route('**/api/v1/admin/libraries/*/access?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route('**/api/v1/admin/users?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.goto('/libraries');
	await page.getByRole('main').getByRole('link', { name: 'Main', exact: true }).click();
	await expect(page.locator('#library-settings-1-name')).toHaveValue('Main');
	await page.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/libraries/99';
		link.textContent = 'Open Archive settings';
		document.body.append(link);
	});
	await page.getByRole('link', { name: 'Open Archive settings' }).click();
	await expect(page.locator('#library-settings-99-name')).toHaveValue('Archive');
	await expect(page.locator('#library-settings-99-slug')).toHaveValue('archive');
	await expect(page.getByRole('heading', { name: 'Manage access', exact: true })).toBeVisible();
	expect(lookups).toContain(99);

	await page.goto('/libraries/99');
	await expect(page.locator('#library-settings-99-name')).toHaveValue('Archive');
	await page.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/libraries';
		link.textContent = 'Open all libraries';
		document.body.append(link);
	});
	await page.getByRole('link', { name: 'Open all libraries' }).click();
	await expect(page.getByRole('heading', { name: 'All Libraries', exact: true })).toBeVisible();
	await expect(page.locator('#library-settings-99-name')).toHaveCount(0);
});

test('failed deep-link lookup is visible and retryable', async ({ page }) => {
	await authenticate(page);
	let failed = true;
	await page.route('**/api/v1/libraries/99', (route) => failed
		? route.fulfill({ status: 500, json: { error: 'private server detail' } })
		: route.fulfill({ json: { library: library(99, 'Archive') } }));
	await page.goto('/libraries/99');
	const alert = page.getByRole('alert');
	await expect(alert).toBeVisible();
	await expect(page.getByText('private server detail')).toHaveCount(0);
	failed = false;
	await alert.getByRole('button', { name: 'Try again' }).click();
	await expect(page.locator('#library-settings-99-name')).toHaveValue('Archive');
});

test('library deletion lives in settings and keeps confirmation, conflict localization and refresh', async ({ page }) => {
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
	await page.route('**/api/v1/libraries/1', (route) =>
		route.fulfill({ json: { library: library(1, 'Main', 12) } })
	);
	await page.goto('/libraries');
	const main = page.getByRole('main');
	await expect(main.getByRole('button', { name: 'Delete Main', exact: true })).toHaveCount(0);
	await main.getByRole('link', { name: 'Main', exact: true }).click();
	await page.evaluate(() => {
		document.body.dataset.libraryChanges = '0';
		window.addEventListener('pandalibrary-libraries-changed', () => {
			document.body.dataset.libraryChanges = String(Number(document.body.dataset.libraryChanges) + 1);
		});
	});
	page.once('dialog', (dialog) => dialog.accept());
	await main.getByRole('button', { name: 'Delete Main', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('This library cannot be deleted while it contains books');
	conflict = false;
	page.once('dialog', (dialog) => dialog.accept());
	await main.getByRole('button', { name: 'Delete Main', exact: true }).click();
	await expect(page).toHaveURL('/libraries');
	await expect(page.getByRole('heading', { name: 'Main', exact: true })).toHaveCount(0);
	await expect(page.locator('body')).toHaveAttribute('data-library-changes', '1');
});

for (const width of [1280, 390]) {
	test(`library and collection listings share the cover layout without visibility or deletion at ${width}px`, async ({ page }) => {
		await authenticate(page);
		await page.setViewportSize({ width, height: 900 });
		await page.route('**/api/v1/shelves?*', (route) => route.fulfill({ json: {
			items: [{
				id: 11, name: 'Weekend', kind: 'private', mode: 'manual', system_key: null,
				owner_id: 1, description: null, created_by: 1, visible_book_count: 12,
				created_at: stamp, updated_at: stamp
			}], next_cursor: null
		} }));
		const layouts = [];
		for (const destination of [
			{ path: '/libraries', heading: 'All Libraries', name: 'Main', href: '/libraries/1' },
			{ path: '/shelves', heading: 'All Collections', name: 'Weekend', href: '/shelves/11?manage=1' }
		]) {
			await page.goto(destination.path);
			const main = page.getByRole('main');
			const heading = main.getByRole('heading', { name: destination.heading, level: 1, exact: true });
			await expect(heading).toBeVisible();
			const card = main.getByRole('listitem').filter({ has: page.getByRole('heading', { name: destination.name, exact: true }) });
			await expect(card.getByRole('link')).toHaveAttribute('href', destination.href);
			await expect(card).toContainText('12 books');
			await expect(card.getByRole('button')).toHaveCount(0);
			await expect(card.getByText(/^(Private|Shared)$/)).toHaveCount(0);
			layouts.push(await heading.evaluate((element) => {
				const headingRect = element.getBoundingClientRect();
				const grid = document.querySelector('main .book-grid');
				const cover = grid?.querySelector('li > a');
				if (!grid || !cover) throw new Error('Management cover grid is missing');
				const coverRect = cover.getBoundingClientRect();
				return {
					fontSize: getComputedStyle(element).fontSize,
					gap: getComputedStyle(grid).columnGap,
					width: coverRect.width, height: coverRect.height,
					headingGap: coverRect.top - headingRect.bottom
				};
			}));
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
		}
		expect(layouts[1]).toEqual(layouts[0]);
	});
}
