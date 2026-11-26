import { confirmInApp } from '#lib/shell/confirmation.e2e-helper.js';
import { expect, test, type Page, type Route } from '@playwright/test';

async function authenticate(page: Page, role = 'admin', locale = 'en') {
	await page.route('**/api/v1/sync/pull?*', (route) =>
		route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: [] } })
	);
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'admin', display_name: 'Admin', role, locale } } })
	);
	await page.route('**/api/v1/admin/users?*', (route) =>
		route.fulfill({
			json: {
				items: [1, 5, 9, 404].map((id) => ({
					id, username: `user${id}`, display_name: '', role: id === 1 ? 'admin' : 'user',
					locale: 'en', disabled: false, created_at: stamp, updated_at: stamp
				})),
				next_cursor: null
			}
		})
	);
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
}

function problem(route: Route, status: number, detail = 'server detail that must not be shown') {
	return route.fulfill({ status, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Problem', status, detail }) });
}

const stamp = '2026-11-03T08:00:00Z';
const library = (id: number, name: string, slug: string) => ({ id, name, slug, created_at: stamp, updated_at: stamp });

test('hides the admin area from readers and blocks direct navigation', async ({ page }) => {
	await authenticate(page, 'user');
	await page.goto('/');
	await expect(page.getByRole('navigation').first()).toBeVisible();
	await expect(page.getByRole('link', { name: 'Admin Panel', exact: true })).toHaveCount(0);
	await page.goto('/admin');
	await expect(page.getByText('Only administrators can open this area.')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Administration sections' })).toHaveCount(0);
});

test('Admin Panel opens the admin sidebar and Exit Admin restores the normal menu', async ({ page }) => {
	await authenticate(page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Account menu', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Admin Panel', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');

	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	const adminPanel = sidebar.getByRole('link', { name: 'Admin Panel', exact: true });
	await expect(adminPanel).toHaveAttribute('href', '/admin');
	await adminPanel.click();
	await expect(page).toHaveURL('/admin/users');
	const adminNav = page.getByRole('navigation', { name: 'Administration sections' });
	await expect(adminNav.getByRole('link', { name: 'Users', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
	await adminNav.getByRole('link', { name: 'Exit Admin', exact: true }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Administration sections' })).toHaveCount(0);
});

test('administrators reach the admin area in Chinese', async ({ page }) => {
	await authenticate(page, 'admin', 'zh');
	await page.goto('/');
	await page.getByRole('link', { name: '管理面板', exact: true }).click();
	await expect(page).toHaveURL('/admin/users');
	await expect(page.getByRole('heading', { level: 1, name: '用户', exact: true })).toHaveClass('sr-only');
	const adminNav = page.getByRole('navigation', { name: '管理分区' });
	await expect(adminNav.getByRole('link', { name: '用户', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(adminNav.getByRole('link', { name: '退出管理', exact: true })).toHaveAttribute('href', '/');
	await page.getByRole('button', { name: '用户账号', exact: true }).click();
	await expect(page.getByText('pandalibrary user create --username <name>')).toBeVisible();
});

test('Users searches all pages and exposes selection-aware actions above numbered rows', async ({ page }) => {
	await authenticate(page);
	const accounts = [
		{ id: 20, username: 'alpha', display_name: 'Alpha Person', role: 'user', locale: 'en', disabled: false, created_at: stamp, updated_at: stamp },
		{ id: 42, username: 'beta', display_name: 'Beta Person', role: 'user', locale: 'zh', disabled: true, created_at: stamp, updated_at: stamp }
	];
	const changes: number[] = [];
	const queries: URLSearchParams[] = [];
	await page.route('**/api/v1/admin/users?*', (route) => {
		const params = new URL(route.request().url()).searchParams;
		queries.push(params);
		const items = params.get('q') ? accounts.filter((user) => user.display_name.includes(params.get('q')!))
			: params.has('cursor') ? [accounts[1]] : [accounts[0]];
		return route.fulfill({ json: { items, next_cursor: params.get('q') || params.has('cursor') ? null : 'second' } });
	});
	await page.route('**/api/v1/admin/users/*', (route) => {
		const id = Number(new URL(route.request().url()).pathname.split('/').pop());
		changes.push(id);
		const user = accounts.find((item) => item.id === id)!;
		user.disabled = route.request().postDataJSON().disabled;
		return route.fulfill({ json: { user } });
	});
	await page.goto('/admin');
	await expect(page).toHaveURL('/admin/users');
	const tabs = page.getByRole('navigation', { name: 'Administration sections' });
	await expect(tabs.getByRole('link', { name: 'Overview', exact: true })).toHaveCount(0);
	await expect(tabs.getByRole('link', { name: 'Uploads', exact: true })).toBeVisible();
	await expect(tabs.getByRole('link', { name: 'Backup', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'User accounts', exact: true })).toHaveCount(0);
	await expect(page.getByText('pandalibrary user create --username <name>')).toHaveCount(0);
	await page.getByRole('button', { name: 'User accounts', exact: true }).click();
	await expect(page.getByText('pandalibrary user create --username <name>')).toBeVisible();
	await expect(page.getByRole('toolbar')).toHaveCount(0);
	const alpha = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'alpha', exact: true }) });
	await expect(alpha.getByRole('cell').first()).toHaveText('1');
	await page.getByRole('button', { name: 'Load more users' }).click();
	const beta = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'beta', exact: true }) });
	await expect(beta.getByRole('cell').first()).toHaveText('2');
	await page.getByRole('checkbox', { name: 'Select alpha', exact: true }).check();
	const toolbar = page.getByRole('toolbar');
	await expect(toolbar.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
	await expect(toolbar.getByRole('button', { name: 'Disable', exact: true })).toBeEnabled();
	await expect(toolbar.getByRole('button', { name: 'Enable', exact: true })).toHaveCount(0);
	await expect(page.getByRole('checkbox', { name: 'Select all loaded users' })).toHaveJSProperty('indeterminate', true);
	await page.getByRole('checkbox', { name: 'Select all loaded users' }).check();
	await expect(toolbar.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
	await expect(toolbar.getByRole('button', { name: 'Disable', exact: true })).toBeEnabled();
	await expect(toolbar.getByRole('button', { name: 'Enable', exact: true })).toHaveCount(0);
	await confirmInApp(page, () => toolbar.getByRole('button', { name: 'Disable', exact: true }).click());
	await expect(page.getByText('Completed for 1 account(s).')).toBeVisible();
	expect(changes).toEqual([20]);
	await expect(page.getByRole('toolbar')).toHaveCount(0);
	await page.getByRole('button', { name: 'Load more users' }).click();
	await page.getByRole('checkbox', { name: 'Select beta', exact: true }).check();
	await expect(toolbar.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
	await expect(toolbar.getByRole('button', { name: 'Disable', exact: true })).toHaveCount(0);
	await page.getByRole('checkbox', { name: 'Select beta', exact: true }).uncheck();
	await expect(page.getByRole('toolbar')).toHaveCount(0);
	const search = page.getByRole('search', { name: 'Search accounts' });
	await expect(search.getByLabel('Category')).toHaveCount(0);
	await search.getByRole('searchbox').fill('Beta');
	await search.getByRole('button', { name: 'Search accounts' }).click();
	await expect(alpha).toHaveCount(0);
	await expect(beta.getByRole('cell').first()).toHaveText('1');
	expect(queries.at(-1)?.get('q')).toBe('Beta');
	expect(queries.at(-1)?.has('category')).toBe(false);
	expect(queries.at(-1)?.has('cursor')).toBe(false);
	await page.getByRole('checkbox', { name: 'Select beta', exact: true }).check();
	await search.getByRole('searchbox').fill('Not found');
	await search.getByRole('button', { name: 'Search accounts' }).click();
	await expect(page.getByText('No users found.')).toBeVisible();
	await expect(page.getByRole('toolbar')).toHaveCount(0);
});

test('creates an encrypted server backup and stages a confirmed replacement restore', async ({ page }) => {
	await authenticate(page);
	const passphrase = 'correct horse battery staple';
	const backup = { name: 'pandalibrary-test.tar.gz.age', size_bytes: 1048576, created_at: stamp, encrypted: true };
	let created = false;
	let pending = false;
	let createBody: unknown;
	let restoreBody: unknown;
	await page.route('**/api/v1/admin/backups', (route) => {
		if (route.request().method() === 'POST') {
			createBody = route.request().postDataJSON();
			created = true;
			return route.fulfill({ status: 201, json: { backup } });
		}
		return route.fulfill({ json: { backups: created ? [backup] : [], restore_pending: pending } });
	});
	await page.route('**/api/v1/admin/backups/restore', (route) => {
		restoreBody = route.request().postDataJSON();
		pending = true;
		return route.fulfill({ status: 202, json: { status: 'staged', restore_pending: true, restart_required: true } });
	});
	await page.goto('/admin/backup');
	await expect(page.getByText('No backups saved on this server.')).toBeVisible();
	await page.getByRole('button', { name: 'Create backup', exact: true }).click();
	const createDialog = page.getByRole('dialog', { name: 'Create encrypted backup' });
	await createDialog.getByLabel('Backup passphrase').fill(passphrase);
	await createDialog.getByLabel('Confirm passphrase').fill(passphrase);
	await createDialog.getByRole('button', { name: 'Create encrypted backup' }).click();
	await expect(page.getByText(`Encrypted backup saved on the server: ${backup.name}`)).toBeVisible();
	expect(createBody).toEqual({ passphrase });
	const row = page.getByRole('row').filter({ hasText: backup.name });
	await expect(row.getByRole('cell', { name: '1.00 MiB' })).toBeVisible();
	await expect(row.getByRole('link', { name: `Download ${backup.name}` })).toHaveAttribute('href', `/api/v1/admin/backups/${backup.name}`);
	await row.getByRole('button', { name: `Restore ${backup.name}` }).click();
	const restoreDialog = page.getByRole('dialog', { name: 'Restore backup' });
	await restoreDialog.getByRole('button', { name: 'Cancel' }).click();
	expect(restoreBody).toBeUndefined();
	await row.getByRole('button', { name: `Restore ${backup.name}` }).click();
	await restoreDialog.getByLabel('Backup passphrase').fill(passphrase);
	await restoreDialog.getByRole('button', { name: 'Restore backup' }).click();
	await expect(page.getByText('Restore is staged. Restart the PandaLibrary server to apply it. Data has not been replaced yet.')).toBeVisible();
	expect(restoreBody).toEqual({ name: backup.name, confirm: true, passphrase });
	await expect(page.getByRole('button', { name: 'Create backup', exact: true })).toBeDisabled();
	await page.reload();
	await expect(page.getByText('Restore is staged. Restart the PandaLibrary server to apply it. Data has not been replaced yet.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Upload and restore', exact: true })).toBeDisabled();
});

test('uploads an encrypted backup for restore and reports invalid archives without staging', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/admin/backups', (route) =>
		route.fulfill({ json: { backups: [], restore_pending: false } }));
	const passphrase = 'correct horse battery staple';
	let multipart = '';
	await page.route('**/api/v1/admin/backups/restore', (route) => {
		multipart = route.request().postData() ?? '';
		return problem(route, 400);
	});
	await page.goto('/admin/backup');
	await page.getByRole('button', { name: 'Upload and restore', exact: true }).click();
	await expect(page.getByText('Choose a non-empty PandaLibrary .tar.gz.age or .tar.gz backup file.')).toBeVisible();
	await page.getByLabel('Backup archive (.tar.gz.age or legacy .tar.gz)').setInputFiles({
		name: 'saved.tar.gz.age', mimeType: 'application/octet-stream', buffer: Buffer.from('not a real archive')
	});
	await page.getByRole('button', { name: 'Upload and restore', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Restore backup' });
	await dialog.getByLabel('Backup passphrase').fill(passphrase);
	await dialog.getByRole('button', { name: 'Restore backup' }).click();
	await expect(page.getByRole('alert')).toContainText('This backup is invalid, damaged, incompatible, or cannot be restored safely.');
	expect(multipart).toContain('name="file"; filename="saved.tar.gz.age"');
	expect(multipart).toContain('name="confirm"\r\n\r\ntrue');
	expect(multipart).toContain('name="passphrase"\r\n\r\n' + passphrase);
	await expect(page.getByRole('button', { name: 'Create backup', exact: true })).toBeEnabled();
	await expect(page.getByText('Restore is staged.', { exact: false })).toHaveCount(0);
});

test('manages libraries and access grants with conflicts', async ({ page }) => {
	await authenticate(page);
	let libraries = [library(1, 'Main', 'main'), library(2, 'Comics', 'comics')];
	let grants = [{ user_id: 7, granted_at: stamp }];
	const requests: string[] = [];
	await page.route('**/api/v1/admin/libraries**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		requests.push(`${request.method()} ${url.pathname}`);
		if (url.pathname === '/api/v1/admin/libraries') {
			if (request.method() === 'POST') {
				const body = request.postDataJSON() as { name: string; slug: string };
				if (body.slug === 'main') return problem(route, 409);
				const created = library(3, body.name, body.slug);
				libraries = [...libraries, created];
				return route.fulfill({ status: 201, json: { library: created } });
			}
			return route.fulfill({ json: { items: libraries, next_cursor: null } });
		}
		if (url.pathname === '/api/v1/admin/libraries/1' && request.method() === 'DELETE') return problem(route, 409);
		if (url.pathname === '/api/v1/admin/libraries/2' && request.method() === 'DELETE') {
			libraries = libraries.filter((item) => item.id !== 2);
			return route.fulfill({ json: { deleted: true } });
		}
		if (url.pathname === '/api/v1/admin/libraries/1/access') return route.fulfill({ json: { items: grants, next_cursor: null } });
		if (url.pathname === '/api/v1/admin/libraries/1/access/9' && request.method() === 'PUT') {
			grants = [...grants, { user_id: 9, granted_at: stamp }];
			return route.fulfill({ json: { granted: true } });
		}
		if (url.pathname === '/api/v1/admin/libraries/1/access/1' && request.method() === 'PUT') return problem(route, 400);
		if (url.pathname === '/api/v1/admin/libraries/1/access/7' && request.method() === 'DELETE') {
			grants = grants.filter((item) => item.user_id !== 7);
			return route.fulfill({ json: { revoked: true } });
		}
		return problem(route, 404);
	});

	await page.goto('/admin/libraries');
	const createForm = page.getByRole('region', { name: 'New library' });
	await createForm.getByLabel('Name').fill('Main Copy');
	await createForm.getByLabel('Slug').fill('main');
	await createForm.getByRole('button', { name: 'Create library' }).click();
	await expect(page.getByText('Another library already uses this name or slug.')).toBeVisible();
	await expect(createForm.getByLabel('Name')).toHaveValue('Main Copy');
	await expect(page.getByText('server detail that must not be shown')).toHaveCount(0);

	await createForm.getByLabel('Slug').fill('main-copy');
	await createForm.getByRole('button', { name: 'Create library' }).click();
	await expect(page.getByText('Created “Main Copy”.')).toBeVisible();
	await expect(page.getByRole('listitem', { name: 'Main Copy' })).toBeVisible();

	await page.getByRole('button', { name: 'Delete Main', exact: true }).click();
	let deleteDialog = page.getByRole('dialog', { name: 'Delete', exact: true });
	await deleteDialog.getByLabel('Move all books to').selectOption({ label: 'Comics' });
	await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(deleteDialog.getByRole('alert')).toContainText('The library could not be deleted');
	await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();

	await page.getByRole('button', { name: 'Delete Comics', exact: true }).click();
	deleteDialog = page.getByRole('dialog', { name: 'Delete', exact: true });
	await deleteDialog.getByLabel('Move all books to').selectOption({ label: 'Main' });
	await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page.getByText('Deleted “Comics”.')).toBeVisible();
	await expect(page.getByRole('listitem', { name: 'Comics' })).toHaveCount(0);

	await page.getByRole('button', { name: 'Manage access Main', exact: true }).click();
	const accessPanel = page.getByRole('region', { name: 'Access to “Main”' });
	await expect(accessPanel.getByRole('cell', { name: '7', exact: true })).toBeVisible();
	await accessPanel.getByLabel('User ID').selectOption('1');
	await accessPanel.getByRole('button', { name: 'Grant access' }).click();
	await expect(accessPanel.getByText('Access could not be granted. Administrators already see every library.')).toBeVisible();
	await accessPanel.getByLabel('User ID').selectOption('9');
	await accessPanel.getByRole('button', { name: 'Grant access' }).click();
	await expect(accessPanel.getByText('User #9 can now see “Main”.')).toBeVisible();
	await expect(accessPanel.getByRole('cell', { name: '9', exact: true })).toBeVisible();

	await confirmInApp(page, () => accessPanel.getByRole('button', { name: 'Remove for user #7' }).click());
	await expect(accessPanel.getByText('User #7 can no longer see “Main”.')).toBeVisible();
	await expect(accessPanel.getByRole('cell', { name: '7', exact: true })).toHaveCount(0);
	expect(requests).toContain('PUT /api/v1/admin/libraries/1/access/9');
});

test('hides and unhides a book for a user', async ({ page }) => {
	await authenticate(page);
	let hidden = [{ book_id: 30, hidden_by: 1, created_at: stamp }];
	await page.route('**/api/v1/admin/users/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === '/api/v1/admin/users/404/hidden-books') return problem(route, 404);
		if (url.pathname === '/api/v1/admin/users/5/hidden-books') return route.fulfill({ json: { items: hidden, next_cursor: null } });
		if (url.pathname === '/api/v1/admin/users/5/hidden-books/41' && request.method() === 'PUT') {
			hidden = [{ book_id: 41, hidden_by: 1, created_at: stamp }, ...hidden];
			return route.fulfill({ json: { hidden: true } });
		}
		if (url.pathname === '/api/v1/admin/users/5/hidden-books/30' && request.method() === 'DELETE') {
			hidden = hidden.filter((item) => item.book_id !== 30);
			return route.fulfill({ json: { hidden: false } });
		}
		return problem(route, 404);
	});

	await page.goto('/admin/hidden-books');
	await page.getByLabel('User ID').selectOption('404');
	await page.getByRole('button', { name: 'Show hidden books' }).click();
	await expect(page.getByText('No user has this ID.')).toBeVisible();

	await page.getByLabel('User ID').selectOption('5');
	await page.getByRole('button', { name: 'Show hidden books' }).click();
	await expect(page.getByRole('heading', { name: 'Books hidden from user #5' })).toBeVisible();
	await expect(page.getByRole('cell', { name: '30', exact: true })).toBeVisible();

	await page.getByLabel('Book ID').fill('41');
	await confirmInApp(page, () => page.getByRole('button', { name: 'Hide book', exact: true }).click());
	await expect(page.getByText('Book #41 is now hidden from user #5.')).toBeVisible();
	await expect(page.getByRole('cell', { name: '41', exact: true })).toBeVisible();

	await confirmInApp(page, () => page.getByRole('button', { name: 'Unhide book #30' }).click());
	await expect(page.getByText('Book #30 is visible to user #5 again.')).toBeVisible();
	await expect(page.getByRole('cell', { name: '30', exact: true })).toHaveCount(0);
});

test('shows compact import history, search, deleted titles, and live status updates', async ({ page }) => {
	await authenticate(page);
	await page.clock.install();
	const older = {
		id: 4, source: 'drop_folder', library_id: 2, user_id: null, uploaded_by: null, original_name: 'old.cbz', sha256: 'x',
		status: 'failed', error: 'could not read [drop]/old.cbz', book_id: null, book_title: null, book_deleted: false,
		duplicate_of_book_id: null, created_at: stamp, finished_at: stamp
	};
	const removed = {
		id: 3, source: 'upload', library_id: 1, user_id: 1, uploaded_by: 'admin', original_name: 'removed.epub', sha256: null,
		status: 'imported', error: null, book_id: null, book_title: 'Removed Book', book_deleted: true,
		duplicate_of_book_id: null, created_at: stamp, finished_at: stamp
	};
	const pending = {
		id: 5, source: 'upload', library_id: 1, user_id: 1, uploaded_by: 'admin', original_name: 'Dune.epub', sha256: null,
		status: 'pending', error: null, book_id: null, book_title: null, book_deleted: false,
		duplicate_of_book_id: null, created_at: stamp, finished_at: null
	};
	let calls = 0;
	let lastSearch = '';
	await page.route('**/api/v1/imports?*', (route) => {
		const search = new URL(route.request().url()).searchParams.get('q') ?? '';
		lastSearch = search;
		if (search === 'Removed') return route.fulfill({ json: { items: [removed], next_cursor: null } });
		if (search === 'nothing') return route.fulfill({ json: { items: [], next_cursor: null } });
		calls += 1;
		const current = calls >= 2
			? { ...pending, status: 'imported', book_id: 77, book_title: 'Dune', finished_at: stamp }
			: pending;
		return route.fulfill({ json: { items: [removed, current, older], next_cursor: null } });
	});

	await page.goto('/admin/imports');
	await expect(page.getByLabel('Book file')).toHaveCount(0);
	await expect(page.getByLabel('Library', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('searchbox', { name: 'Search uploads' })).toBeVisible();
	for (const name of ['Name', 'Job', 'By', 'Status', 'Uploaded']) {
		await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
	}
	await expect(page.getByText('Drop folder')).toHaveCount(0);
	await expect(page.getByText('could not read [drop]/old.cbz')).toHaveCount(0);

	const jobRow = page.getByRole('row').filter({ hasText: '#5' });
	await expect(jobRow).toContainText('Dune.epub');
	await expect(jobRow).toContainText('admin');
	await expect(jobRow.getByText('Waiting')).toBeVisible();

	const removedRow = page.getByRole('row').filter({ hasText: 'Removed Book' });
	await expect(removedRow.locator('span.line-through')).toHaveClass(/text-red-700/);
	await expect(removedRow.getByRole('link')).toHaveCount(0);

	await page.clock.runFor(3100);
	await expect(jobRow.getByText('Uploaded')).toBeVisible();
	await expect(jobRow.getByRole('link', { name: 'Dune', exact: true })).toHaveAttribute('href', '/books/77');
	await page.clock.runFor(30_000);
	expect(calls).toBe(2);

	const main = page.getByRole('main');
	const search = main.getByRole('search');
	await search.getByRole('searchbox', { name: 'Search uploads' }).fill('Removed');
	await search.getByRole('button', { name: 'Search uploads' }).click();
	await expect.poll(() => lastSearch).toBe('Removed');
	await expect(page.getByRole('row')).toHaveCount(2);
	await expect(page.getByText('Removed Book')).toBeVisible();
	await expect(page.getByText('Dune')).toHaveCount(0);

	await search.getByRole('searchbox', { name: 'Search uploads' }).fill('nothing');
	await search.getByRole('button', { name: 'Search uploads' }).click();
	await expect(page.getByText('No uploads match your search.')).toBeVisible();
});

test('edits metadata providers without exposing tokens', async ({ page }) => {
	await authenticate(page);
	let neodb = { provider: 'neodb', enabled: true, priority: 20, base_url: null as string | null, has_token: true, updated_at: stamp };
	const openlibrary = { provider: 'openlibrary', enabled: true, priority: 10, base_url: null, has_token: false, updated_at: stamp };
	const patches: unknown[] = [];
	await page.route('**/api/v1/admin/metadata/providers**', async (route) => {
		const request = route.request();
		if (request.method() === 'GET') return route.fulfill({ json: { providers: [neodb, openlibrary] } });
		const body = request.postDataJSON() as Record<string, unknown>;
		patches.push(body);
		if (body.base_url === 'https://bad.example') return problem(route, 400);
		neodb = {
			...neodb,
			...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
			...(body.priority !== undefined ? { priority: body.priority as number } : {}),
			...(body.base_url !== undefined ? { base_url: body.base_url as string | null } : {}),
			...(body.api_token !== undefined ? { has_token: body.api_token !== null } : {})
		};
		return route.fulfill({ json: { provider: neodb } });
	});

	await page.goto('/admin/providers');
	const form = page.getByRole('form', { name: 'NeoDB' });
	await expect(form.getByText('Token stored')).toBeVisible();
	await expect(page.getByRole('form', { name: 'Open Library' }).getByRole('radio')).toHaveCount(0);

	await form.getByLabel('Priority').fill('5');
	await form.getByRole('button', { name: 'Save' }).click();
	await expect(form.getByText('Saved NeoDB.')).toBeVisible();
	expect(patches.at(-1)).toEqual({ priority: 5 });

	await form.getByLabel('Server address').fill('https://bad.example');
	await form.getByRole('button', { name: 'Save' }).click();
	await expect(form.getByText('The server rejected these provider settings.')).toBeVisible();
	await expect(form.getByLabel('Server address')).toHaveValue('https://bad.example');
	await form.getByRole('button', { name: 'Discard changes' }).click();

	await form.getByLabel('Remove the stored token').check();
	await form.getByRole('button', { name: 'Save' }).click();
	await expect(form.getByText('Set a token before enabling this provider.')).toBeVisible();
	await form.getByLabel('Enabled', { exact: true }).uncheck();
	await form.getByRole('button', { name: 'Save' }).click();
	const confirmation = page.locator('#app-confirmation');
	await expect(confirmation).toContainText('Remove the stored token for NeoDB?');
	await confirmation.locator('button').last().click();
	await expect(confirmation).toContainText('Disable NeoDB? Books will no longer get details from it.');
	await confirmation.locator('button').last().click();
	await expect(form.getByText('Saved NeoDB.')).toBeVisible();
	expect(patches.at(-1)).toEqual({ api_token: null, enabled: false });
	await expect(form.getByLabel('No token')).toBeChecked();

	await form.getByLabel('Set a token').check();
	await form.getByLabel('New token').fill('secret-token');
	await form.getByLabel('Enabled', { exact: true }).check();
	await form.getByRole('button', { name: 'Save' }).click();
	await expect(form.getByText('Saved NeoDB.')).toBeVisible();
	expect(patches.at(-1)).toEqual({ api_token: 'secret-token', enabled: true });
	await expect(form.getByLabel('New token')).toHaveCount(0);
	await expect(page.getByText('secret-token')).toHaveCount(0);
});

test('runs maintenance jobs and handles a job that is already running', async ({ page }) => {
	await authenticate(page);
	await page.clock.install();
	let backup = { name: 'backup', schedule: '24h0m0s', status: 'idle', last_run: null as unknown };
	let polls = 0;
	await page.route('**/api/v1/admin/maintenance**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === 'POST') {
			if (url.pathname.endsWith('/wal-checkpoint')) return problem(route, 409);
			backup = { ...backup, status: 'accepted', last_run: { id: 'r1', status: 'accepted', accepted_at: stamp } };
			return route.fulfill({ status: 202, json: { run: backup.last_run } });
		}
		if (backup.status !== 'idle') {
			polls += 1;
			if (polls >= 2) backup = { ...backup, status: 'completed', last_run: { id: 'r1', status: 'completed', accepted_at: stamp, completed_at: stamp } };
		}
		return route.fulfill({
			json: { jobs: [backup, { name: 'wal-checkpoint', schedule: '5m0s', status: 'idle', last_run: null }] }
		});
	});
	await page.goto('/admin/maintenance');
	const backupCard = page.getByRole('listitem').filter({ hasText: 'Database backup' });
	await expect(backupCard.getByText('Every 24 h')).toBeVisible();
	await expect(backupCard.getByText('Not since the server started')).toBeVisible();
	await expect(page.getByText('resets when the server restarts')).toBeVisible();

	await confirmInApp(page, () => page.getByRole('button', { name: 'Run Database backup now' }).click());
	await expect(backupCard.getByText('“Database backup” was started.')).toBeVisible();
	await expect(backupCard.getByRole('button', { name: 'Run Database backup now' })).toBeDisabled();
	await page.clock.runFor(2100);
	await page.clock.runFor(2100);
	await expect(backupCard.getByText('Completed').first()).toBeVisible();
	await expect(backupCard.getByRole('button', { name: 'Run Database backup now' })).toBeEnabled();

	const walCard = page.getByRole('listitem').filter({ hasText: 'Database checkpoint' });
	await expect(walCard.getByText('Every 5 min')).toBeVisible();
	await confirmInApp(page, () => page.getByRole('button', { name: 'Run Database checkpoint now' }).click());
	await expect(walCard.getByText('This job is already running. Its status will refresh automatically.')).toBeVisible();
	await expect(page.getByText('server detail that must not be shown')).toHaveCount(0);
});
