import { expect, test, type Page } from '@playwright/test';
import type { Library, LibraryPatch } from './types.js';

test.use({ serviceWorkers: 'block' });

async function mockLibraries(page: Page) {
	let library: Library = {
		id: 4, name: 'Fiction', slug: 'fiction', icon: 'bookmark', visible_book_count: 0,
		created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z'
	};
	const creates: Record<string, string>[] = [];
	const patches: LibraryPatch[] = [];
	await page.route((url) => url.pathname.startsWith('/api/v1/'), async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: {
			id: 1, username: 'admin', display_name: 'Admin', role: 'admin', locale: 'en'
		} } });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: []
		} });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/version') return route.fulfill({ json: {
			version: 'test', commit: 'test', commit_date: library.created_at, dirty: false, release: null
		} });
		if (path === '/admin/libraries' && request.method() === 'POST') {
			const body = request.postDataJSON();
			creates.push(body);
			return route.fulfill({ status: 201, json: { library: { ...library, ...body, id: 5 } } });
		}
		if (path === '/admin/libraries/4' && request.method() === 'PATCH') {
			const patch = request.postDataJSON() as LibraryPatch;
			patches.push(patch);
			library = { ...library, ...patch };
			return route.fulfill({ json: { library } });
		}
		if (path === '/libraries/4') return route.fulfill({ json: { library } });
		if (path === '/libraries' || path === '/admin/libraries') {
			return route.fulfill({ json: { items: [library], next_cursor: null } });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	return { creates, patches };
}

test('library creation saves the chosen icon and resets the picker', async ({ page }) => {
	const server = await mockLibraries(page);
	await page.goto('/admin/libraries?create=1');
	const name = page.locator('#create-library-name');
	await expect(name).toBeFocused();
	const form = name.locator('xpath=ancestor::form');
	await name.fill('History');
	await form.getByRole('radio', { name: 'Star', exact: true }).check();
	await form.getByRole('button', { name: 'Create library', exact: true }).click();
	await expect.poll(() => server.creates.length).toBe(1);
	expect(server.creates[0]).toEqual({ name: 'History', slug: 'history', icon: 'star' });
	await expect(form.getByRole('radio', { name: 'Automatic', exact: true })).toBeChecked();
});

test('library edits preserve the chosen icon, allow icon-only changes, and clear to automatic', async ({ page }) => {
	const server = await mockLibraries(page);
	await page.goto('/admin/libraries?edit=4');
	let form = page.locator('#linked-library-4-name').locator('xpath=ancestor::form');
	await expect(form.getByRole('radio', { name: 'Bookmark', exact: true })).toBeChecked();
	await form.getByLabel('Name', { exact: true }).fill('Novels');
	await form.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => server.patches.length).toBe(1);
	expect(server.patches[0]).toEqual({ name: 'Novels' });
	await expect(page).toHaveURL('/admin/libraries');

	for (const [label, icon] of [['Star', 'star'], ['Automatic', '']] as const) {
		await page.goto('/admin/libraries?edit=4');
		form = page.locator('#linked-library-4-name').locator('xpath=ancestor::form');
		await expect(form.getByRole('radio', { name: icon ? 'Bookmark' : 'Star', exact: true })).toBeChecked();
		await form.getByRole('radio', { name: label, exact: true }).check();
		await form.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(() => server.patches.at(-1)).toEqual({ icon });
		await expect(page).toHaveURL('/admin/libraries');
	}
});
