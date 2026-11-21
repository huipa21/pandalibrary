import { expect, test, type Page } from '@playwright/test';
import { confirmInApp } from '#lib/shell/confirmation.e2e-helper.js';

test.use({ serviceWorkers: 'block' });

const timestamp = '2026-11-15T00:00:00Z';

async function mockManagement(page: Page, role = 'admin') {
	let library = { id: 1, name: 'Fiction', slug: 'fiction', icon: 'bookmark', visible_book_count: 7, created_at: timestamp, updated_at: timestamp };
	const creates: Record<string, string>[] = [];
	const patches: Record<string, string>[] = [];
	const deletes: number[] = [];
	const destinations: string[] = [];
	let multipleLibraries = false;
	let deleteFails = false;
	const grants: number[] = [];
	const revokes: number[] = [];
	const searches: string[] = [];
	const unexpected: string[] = [];
	const accounts = Array.from({ length: 30 }, (_, index) => ({
		id: index + 2, username: `reader${String(index + 1).padStart(2, '0')}`, display_name: `Reader ${index + 1}`,
		role: 'user', locale: 'en', disabled: false, created_at: timestamp, updated_at: timestamp
	}));
	accounts.unshift({ ...accounts[0], id: 1, username: 'admin', display_name: 'Administrator', role: 'admin' });
	let entries: { user_id: number; granted_at: string }[] = [];
	let createFails = false;
	await page.route((url) => url.pathname.startsWith('/api/v1/'), (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: { id: 1, username: role, display_name: role, role, locale: 'en' } } });
		if (path === '/sync/pull') return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: [] } });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/version') return route.fulfill({ json: { version: 'test', commit: 'test', commit_date: timestamp, dirty: false, release: null } });
		if (path === '/wordbooks') return route.fulfill({ json: { wordbooks: [] } });
		if (path === '/shelves') return route.fulfill({ json: { items: [], next_cursor: null } });
		if (path === '/shelves/system/favorites') return route.fulfill({ json: { shelf: { key: 'favorites', name: 'Favorites', mode: 'manual', shelf_id: null, visible_book_count: 0 } } });
		if (path === '/me/notes' || path === '/admin/bookheap/items') return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
		if (path === '/books/count') return route.fulfill({ json: { count: 7 } });
		if (path === '/libraries') return route.fulfill({ json: { items: [library], next_cursor: null } });
		if (path === '/admin/libraries' && request.method() === 'GET') return route.fulfill({
			json: { items: multipleLibraries ? [library, { ...library, id: 2, name: 'Archive', slug: 'archive' }] : [library], next_cursor: null }
		});
		if (path === '/libraries/1') return route.fulfill({ json: { library } });
		if (path === '/admin/libraries' && request.method() === 'POST') {
			creates.push(request.postDataJSON());
			if (createFails) return route.fulfill({ status: 409, json: { title: 'Conflict', status: 409 } });
			return route.fulfill({ status: 201, json: { library: { ...library, ...request.postDataJSON(), id: 2 } } });
		}
		if (path === '/admin/libraries/1' && request.method() === 'PATCH') {
			patches.push(request.postDataJSON());
			library = { ...library, ...request.postDataJSON() };
			return route.fulfill({ json: { library } });
		}
		if (path === '/admin/libraries/1' && request.method() === 'DELETE') {
			deletes.push(1);
			destinations.push(url.searchParams.get('destination_library_id') ?? '');
			if (deleteFails) return route.fulfill({ status: 409, json: { title: 'Conflict', status: 409 } });
			return route.fulfill({ json: { deleted: true } });
		}
		if (path === '/admin/libraries/1/access') return route.fulfill({ json: { items: entries, next_cursor: null } });
		const access = /^\/admin\/libraries\/1\/access\/(\d+)$/.exec(path);
		if (access && request.method() === 'PUT') {
			const id = Number(access[1]);
			grants.push(id);
			entries = [...entries, { user_id: id, granted_at: timestamp }];
			return route.fulfill({ json: { granted: true } });
		}
		if (access && request.method() === 'DELETE') {
			const id = Number(access[1]);
			revokes.push(id);
			entries = entries.filter((entry) => entry.user_id !== id);
			return route.fulfill({ json: { revoked: true } });
		}
		if (path === '/admin/users') {
			const query = url.searchParams.get('q') ?? '';
			searches.push(query);
			const filtered = accounts.filter((account) => `${account.username} ${account.display_name}`.toLowerCase().includes(query.toLowerCase()));
			const offset = url.searchParams.has('cursor') ? 25 : 0;
			return route.fulfill({ json: { items: filtered.slice(offset, offset + 25), next_cursor: filtered.length > offset + 25 ? 'readers-page-2' : null } });
		}
		unexpected.push(`${request.method()} ${path}`);
		return route.fulfill({ status: 404, json: { title: 'Unexpected request', status: 404 } });
	});
	return { creates, patches, deletes, destinations, grants, revokes, searches, unexpected,
		failCreate: (value: boolean) => { createFails = value; },
		multipleLibraries: () => { multipleLibraries = true; },
		failDelete: (value: boolean) => { deleteFails = value; } };
}

async function expectSettingsLayout(container: ReturnType<Page['locator']>, heading: string, level = 1, panel = 'space-y-4 rounded-lg border border-slate-200 bg-white p-4 sm:p-6') {
	await expect(container).toContainClass(panel);
	const header = container.locator(':scope > header');
	await expect(header).toContainClass('flex items-center justify-between gap-4');
	await expect(header.getByRole('heading', { name: heading, level, exact: true })).toContainClass('text-xl font-semibold');
	const back = header.getByRole('button', { name: 'Back', exact: true }).or(header.getByRole('link', { name: 'Back', exact: true }));
	await expect(back).toContainClass('shell-icon-button');
	await expect(back).toHaveAttribute('title', 'Back');
	await expect(back).toHaveText('');
	await expect(back.locator('svg')).toHaveCount(1);
}

test('New Library is a keyboard-accessible modal with creation fields and a visible selected icon border', async ({ page }) => {
	const server = await mockManagement(page);
	await page.goto('/libraries');
	const actions = page.getByRole('button', { name: 'Library actions', exact: true });
	await actions.focus();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'New Library', exact: true });
	await expect(dialog).toContainClass('fixed inset-0 m-auto');
	await expect(dialog.getByRole('heading', { name: 'New Library', level: 2, exact: true })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
	await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
	await expect(page).toHaveURL('/libraries');
	await page.keyboard.press('Shift+Tab');
	await page.keyboard.press('Tab');
	await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
	await dialog.getByLabel('Name', { exact: true }).fill('Science');
	await expect(dialog.getByLabel('Slug', { exact: true })).toHaveValue('science');
	const star = dialog.getByRole('radio', { name: 'Star', exact: true });
	const visual = star.locator('+ span');
	const before = await visual.evaluate((element) => getComputedStyle(element).borderTopColor);
	await star.check();
	await expect(star).toBeChecked();
	const colors = await visual.evaluate((element) => {
		const reference = document.createElement('span');
		reference.style.color = 'var(--color-emerald-800)';
		element.append(reference);
		const result = { actual: getComputedStyle(element).borderTopColor, expected: getComputedStyle(reference).color };
		reference.remove();
		return result;
	});
	expect(colors.actual).not.toBe(before);
	expect(colors.actual).toBe(colors.expected);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(actions).toBeFocused();
	await actions.click();
	await page.getByRole('menuitem', { name: 'New Library', exact: true }).click();
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('');
	await expect(dialog.getByRole('radio', { name: 'Automatic', exact: true })).toBeChecked();
	await dialog.getByLabel('Name', { exact: true }).fill('History');
	await dialog.getByRole('radio', { name: 'Star', exact: true }).check();
	server.failCreate(true);
	await dialog.getByRole('button', { name: 'Create library', exact: true }).click();
	await expect(dialog.getByRole('alert')).toBeVisible();
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('History');
	server.failCreate(false);
	await dialog.getByRole('button', { name: 'Create library', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect(server.creates.at(-1)).toEqual({ name: 'History', slug: 'history', icon: 'star' });
	await expect(actions).toBeFocused();
	expect(server.unexpected).toEqual([]);
});

test('library settings save fields and access search narrows paginated, scrollable keyboard choices', async ({ page }) => {
	const server = await mockManagement(page);
	await page.goto('/libraries/1');
	const settings = page.getByRole('region', { name: 'Library settings', exact: true });
	await expectSettingsLayout(settings, 'Library settings', 1, 'card space-y-4 p-6');
	await expect(settings.getByRole('link', { name: 'Back', exact: true })).toHaveAttribute('href', '/libraries');
	await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(settings.getByLabel('Name', { exact: true })).toHaveValue('Fiction');
	await expect(settings.getByRole('radio', { name: 'Bookmark', exact: true })).toBeChecked();
	await settings.getByRole('radio', { name: 'Star', exact: true }).check();
	await settings.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => server.patches).toEqual([{ icon: 'star' }]);
	await expect(page.getByText('Saved “Fiction”.', { exact: true })).toBeVisible();
	const search = page.getByRole('combobox', { name: 'Search accounts', exact: true });
	const choices = page.getByRole('listbox', { name: 'User ID', exact: true });
	await expect(search).toHaveAttribute('aria-expanded', 'false');
	await expect(choices).toHaveCount(0);
	await search.focus();
	await expect(search).toHaveAttribute('aria-expanded', 'true');
	await expect(choices.getByRole('option')).toHaveCount(25);
	await expect(choices.getByRole('option', { name: /admin — Administrator/ })).toBeDisabled();
	expect(await choices.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
	await search.press('ArrowDown');
	await expect(search).toHaveAttribute('aria-activedescendant', 'library-grant-user-option-2');
	await expect(search).toBeFocused();
	await search.press('Escape');
	await expect(search).toHaveAttribute('aria-expanded', 'false');
	await expect(choices).toHaveCount(0);
	await expect(search).toBeFocused();
	await search.click();
	await expect(choices).toBeVisible();
	await page.getByRole('button', { name: 'Load more users', exact: true }).click();
	await expect(choices.getByRole('option')).toHaveCount(31);
	await expect(choices.getByRole('option', { name: /reader30/ })).toHaveCount(1);
	await settings.getByLabel('Name', { exact: true }).click();
	await expect(choices).toHaveCount(0);
	await search.fill('reader30');
	await expect(choices.getByRole('option')).toHaveCount(1);
	await expect(choices.getByRole('option', { name: /reader01/ })).toHaveCount(0);
	await search.press('ArrowDown');
	await expect(search).toBeFocused();
	await expect(search).toHaveAttribute('aria-activedescendant', 'library-grant-user-option-31');
	await search.press('Enter');
	await expect(search).toHaveValue('reader30 — Reader 30 (#31)');
	await expect(choices).toHaveCount(0);
	await search.fill('   ');
	await expect(page.getByRole('button', { name: 'Grant access', exact: true })).toBeDisabled();
	await expect(choices.getByRole('option')).toHaveCount(25);
	expect(server.grants).toEqual([]);
	await search.fill('reader30');
	await expect(choices.getByRole('option')).toHaveCount(1);
	await search.press('ArrowDown');
	await search.press('Enter');
	await page.getByRole('button', { name: 'Grant access', exact: true }).click();
	await expect.poll(() => server.grants).toEqual([31]);
	await expect(page.getByRole('table')).toContainText('31');
	await confirmInApp(page, () => page.getByRole('button', { name: 'Remove for user #31', exact: true }).click());
	await expect.poll(() => server.revokes).toEqual([31]);
	await expect(page.getByRole('table')).toHaveCount(0);
	await search.fill('');
	await expect(choices.getByRole('option')).toHaveCount(25);
	expect(server.searches).toContain('reader30');
	expect(server.unexpected).toEqual([]);
});

test('reader library management opens read-only settings without requesting privileged APIs', async ({ page }) => {
	const server = await mockManagement(page, 'user');
	await page.goto('/libraries');
	const actions = page.getByRole('button', { name: 'Library actions', exact: true });
	await actions.click();
	await expect(page.getByRole('menuitem', { name: 'New Library', exact: true })).toHaveCount(0);
	await expect(page.getByRole('menuitem', { name: 'All Libraries', exact: true })).toHaveAttribute('href', '/libraries');
	await page.keyboard.press('Escape');
	const cover = page.getByRole('main').getByRole('link', { name: 'Fiction', exact: true });
	await expect(cover).toHaveAttribute('href', '/libraries/1');
	await cover.click();
	await expect(page.getByRole('region', { name: 'Library settings', exact: true })).toContainText('fiction');
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Delete Fiction', exact: true })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Manage access', exact: true })).toHaveCount(0);
	await expect(page.getByRole('radio', { name: 'Bookmark', exact: true })).toBeDisabled();
	expect(server.patches).toEqual([]);
	expect(server.unexpected).toEqual([]);
});

test('library deletion requires confirmation and cancellation preserves the entry and access', async ({ page }) => {
	const server = await mockManagement(page);
	server.multipleLibraries();
	const browserDialogs: string[] = [];
	page.on('dialog', async (dialog) => { browserDialogs.push(dialog.message()); await dialog.dismiss(); });
	await page.goto('/libraries/1');
	const remove = page.getByRole('button', { name: 'Delete Fiction', exact: true });
	await expect(remove).toBeVisible();
	await remove.click();
	const dialog = page.getByRole('dialog', { name: 'Delete', exact: true });
	await expect(dialog).toContainText('Delete the library “Fiction”? This cannot be undone.');
	await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
	await expect(dialog).toContainText('including hidden and private books');
	await dialog.getByLabel('Move all books to').selectOption('2');
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(remove).toBeFocused();
	await expect(page).toHaveURL('/libraries/1');
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Fiction');
	await expect(page.getByRole('heading', { name: 'Manage access', exact: true })).toBeVisible();
	await expect(remove).toBeEnabled();
	expect(server.deletes).toEqual([]);
	expect(browserDialogs).toEqual([]);
	expect(server.unexpected).toEqual([]);
});

test('the last library cannot be deleted and never sends a deletion request', async ({ page }) => {
	const server = await mockManagement(page);
	await page.goto('/libraries/1');
	await page.getByRole('button', { name: 'Delete Fiction', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Delete', exact: true });
	await expect(dialog.getByRole('alert')).toContainText('This is the last library.');
	await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
	await expect(dialog.getByLabel('Move all books to')).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(server.deletes).toEqual([]);
	expect(server.unexpected).toEqual([]);
});

test('deletion requires a destination, keeps failures in the dialog, and refreshes after success', async ({ page }) => {
	const server = await mockManagement(page);
	server.multipleLibraries();
	server.failDelete(true);
	await page.goto('/libraries/1');
	await page.getByRole('button', { name: 'Delete Fiction', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Delete', exact: true });
	const destination = dialog.getByLabel('Move all books to');
	await expect(destination.locator('option')).toHaveCount(2);
	await expect(destination.locator('option[value="1"]')).toHaveCount(0);
	await destination.selectOption('2');
	await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(dialog.getByRole('alert')).toContainText('The library could not be deleted.');
	await expect(destination).toHaveValue('2');
	await expect(page).toHaveURL('/libraries/1');
	expect(server.destinations).toEqual(['2']);
	server.failDelete(false);
	await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL('/libraries');
	expect(server.destinations).toEqual(['2', '2']);
	expect(server.unexpected).toEqual([]);
});

test('creation links open the library modal and dismiss without retaining the creation query', async ({ page }) => {
	await mockManagement(page);
	await page.goto('/libraries?create=1');
	const dialog = page.getByRole('dialog', { name: 'New Library', exact: true });
	await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page).toHaveURL('/libraries');
	await page.reload();
	await expect(page.getByRole('heading', { name: 'All Libraries', exact: true })).toBeVisible();
	await expect(dialog).toHaveCount(0);
});
