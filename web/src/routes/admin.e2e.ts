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
	await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
	await page.goto('/admin');
	await expect(page.getByText('Only administrators can open this area.')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Administration sections' })).toHaveCount(0);
});

test('administrators reach the admin area in Chinese', async ({ page }) => {
	await authenticate(page, 'admin', 'zh');
	await page.goto('/');
	await page.getByRole('link', { name: '管理', exact: true }).click();
	await expect(page).toHaveURL('/admin/users');
	await expect(page.getByRole('heading', { level: 1, name: '用户', exact: true })).toBeVisible();
	await expect(page.getByRole('navigation', { name: '管理分区' })).toBeVisible();
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
	await expect(toolbar.getByRole('button', { name: 'Enable', exact: true })).toBeDisabled();
	await expect(page.getByRole('checkbox', { name: 'Select all loaded users' })).toHaveJSProperty('indeterminate', true);
	await page.getByRole('checkbox', { name: 'Select all loaded users' }).check();
	await expect(toolbar.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
	await expect(toolbar.getByRole('button', { name: 'Reset password', exact: true })).toBeDisabled();
	await expect(toolbar.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
	await expect(toolbar.getByRole('button', { name: 'Disable', exact: true })).toBeEnabled();
	page.once('dialog', (dialog) => dialog.accept());
	await toolbar.getByRole('button', { name: 'Enable', exact: true }).click();
	await expect(page.getByText('Completed for 1 account(s).')).toBeVisible();
	expect(changes).toEqual([42]);
	await page.getByRole('checkbox', { name: 'Select all loaded users' }).uncheck();
	await expect(page.getByRole('toolbar')).toHaveCount(0);
	const search = page.getByRole('search', { name: 'Search accounts' });
	await search.getByLabel('Category').selectOption('display_name');
	await search.getByRole('searchbox').fill('Beta');
	await search.getByRole('button', { name: 'Search accounts' }).click();
	await expect(alpha).toHaveCount(0);
	await expect(beta.getByRole('cell').first()).toHaveText('1');
	expect(queries.at(-1)?.get('q')).toBe('Beta');
	expect(queries.at(-1)?.get('category')).toBe('display_name');
	expect(queries.at(-1)?.has('cursor')).toBe(false);
	await page.getByRole('checkbox', { name: 'Select beta', exact: true }).check();
	await search.getByRole('searchbox').fill('Not found');
	await search.getByRole('button', { name: 'Search accounts' }).click();
	await expect(page.getByText('No users found.')).toBeVisible();
	await expect(page.getByRole('toolbar')).toHaveCount(0);
});

test('creates a server backup and stages a confirmed replacement restore', async ({ page }) => {
	await authenticate(page);
	const backup = { name: 'pandalibrary-test.tar.gz', size_bytes: 1048576, created_at: stamp };
	let created = false;
	let pending = false;
	let restoreBody: unknown;
	await page.route('**/api/v1/admin/backups', (route) => {
		if (route.request().method() === 'POST') {
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
	await expect(page.getByText(`Backup saved on the server: ${backup.name}`)).toBeVisible();
	const row = page.getByRole('row').filter({ hasText: backup.name });
	await expect(row.getByRole('cell', { name: '1.00 MiB' })).toBeVisible();
	await expect(row.getByRole('link', { name: `Download ${backup.name}` })).toHaveAttribute('href', `/api/v1/admin/backups/${backup.name}`);
	page.once('dialog', (dialog) => dialog.dismiss());
	await row.getByRole('button', { name: `Restore ${backup.name}` }).click();
	expect(restoreBody).toBeUndefined();
	page.once('dialog', (dialog) => dialog.accept());
	await row.getByRole('button', { name: `Restore ${backup.name}` }).click();
	await expect(page.getByText('Restore is staged. Restart the PandaLibrary server to apply it. Data has not been replaced yet.')).toBeVisible();
	expect(restoreBody).toEqual({ name: backup.name, confirm: true });
	await expect(page.getByRole('button', { name: 'Create backup', exact: true })).toBeDisabled();
	await page.reload();
	await expect(page.getByText('Restore is staged. Restart the PandaLibrary server to apply it. Data has not been replaced yet.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Upload and restore', exact: true })).toBeDisabled();
});

test('uploads a backup for restore and reports invalid archives without staging', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/admin/backups', (route) =>
		route.fulfill({ json: { backups: [], restore_pending: false } }));
	let multipart = '';
	await page.route('**/api/v1/admin/backups/restore', (route) => {
		multipart = route.request().postData() ?? '';
		return problem(route, 400);
	});
	await page.goto('/admin/backup');
	await page.getByRole('button', { name: 'Upload and restore', exact: true }).click();
	await expect(page.getByText('Choose a non-empty PandaLibrary .tar.gz backup file.')).toBeVisible();
	await page.getByLabel('Backup archive (.tar.gz)').setInputFiles({
		name: 'saved.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from('not a real archive')
	});
	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Upload and restore', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('This backup is invalid, damaged, incompatible, or cannot be restored safely.');
	expect(multipart).toContain('name="file"; filename="saved.tar.gz"');
	expect(multipart).toContain('name="confirm"\r\n\r\ntrue');
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

	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Delete Main', exact: true }).click();
	await expect(page.getByText('This library cannot be deleted while it contains books')).toBeVisible();

	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Delete Comics' }).click();
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

	page.once('dialog', (dialog) => dialog.accept());
	await accessPanel.getByRole('button', { name: 'Remove for user #7' }).click();
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

	page.once('dialog', (dialog) => dialog.accept());
	await page.getByLabel('Book ID').fill('41');
	await page.getByRole('button', { name: 'Hide book', exact: true }).click();
	await expect(page.getByText('Book #41 is now hidden from user #5.')).toBeVisible();
	await expect(page.getByRole('cell', { name: '41', exact: true })).toBeVisible();

	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Unhide book #30' }).click();
	await expect(page.getByText('Book #30 is visible to user #5 again.')).toBeVisible();
	await expect(page.getByRole('cell', { name: '30', exact: true })).toHaveCount(0);
});

test('uploads a book and polls import history until it finishes', async ({ page }) => {
	await authenticate(page);
	await page.clock.install();
	await page.route('**/api/v1/admin/libraries?*', (route) =>
		route.fulfill({ json: { items: [library(1, 'Main', 'main'), library(2, 'Comics', 'comics')], next_cursor: null } })
	);
	const older = {
		id: 4, source: 'drop_folder', library_id: 2, user_id: null, original_name: 'old.cbz', sha256: 'x', status: 'failed',
		error: 'could not read [drop]/old.cbz', book_id: null, duplicate_of_book_id: null, created_at: stamp, finished_at: stamp
	};
	const pending = {
		id: 5, source: 'upload', library_id: 1, user_id: 1, original_name: 'Dune.epub', sha256: null, status: 'pending',
		error: null, book_id: null, duplicate_of_book_id: null, created_at: stamp, finished_at: null
	};
	let uploaded = false;
	let polls = 0;
	let multipart = '';
	await page.route('**/api/v1/uploads', async (route) => {
		multipart = route.request().postData() ?? '';
		if (multipart.includes('huge.epub')) return problem(route, 413);
		uploaded = true;
		return route.fulfill({ status: 202, json: { job: pending } });
	});
	await page.route('**/api/v1/imports?*', (route) => {
		if (!uploaded) return route.fulfill({ json: { items: [older], next_cursor: null } });
		polls += 1;
		const current = polls >= 2 ? { ...pending, status: 'imported', book_id: 77, finished_at: stamp } : { ...pending, status: 'processing' };
		return route.fulfill({ json: { items: [current, older], next_cursor: null } });
	});

	await page.goto('/admin/imports');
	await expect(page.getByLabel('Book visibility')).toHaveValue('public');
	await page.getByLabel('Book visibility').selectOption('private');
	await expect(page.getByText('could not read [drop]/old.cbz')).toBeVisible();
	await expect(page.getByText('Drop folder')).toBeVisible();

	await page.getByRole('main').getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(page.getByText('Choose a library.')).toBeVisible();
	await expect(page.getByText('Choose a file to upload.')).toBeVisible();

	await page.getByRole('main').getByLabel('Library', { exact: true }).selectOption({ label: 'Main' });
	await page.getByLabel('Book file').setInputFiles({ name: 'huge.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('big') });
	await page.getByRole('main').getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(page.getByText('This file is larger than the server allows.')).toBeVisible();
	await expect(page.getByLabel('Book visibility')).toHaveValue('private');

	await page.getByLabel('Book file').setInputFiles({ name: 'Dune.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('epub') });
	await page.getByRole('main').getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(page.getByText('Upload accepted as job #5 (Dune.epub): Waiting.')).toBeVisible();
	expect(multipart).toContain('name="library_id"');
	expect(multipart).toContain('name="file"; filename="Dune.epub"');
	expect(multipart).toContain('name="visibility"\r\n\r\nprivate');
	const item = page.getByRole('listitem').filter({ hasText: 'Dune.epub' });
	await expect(item.getByText('Waiting')).toBeVisible();
	await expect(page.getByText('Some uploads are still processing')).toBeVisible();

	await page.clock.runFor(3100);
	await expect(item.getByText('Processing')).toBeVisible();
	await page.clock.runFor(3100);
	await expect(item.getByText('Uploaded')).toBeVisible();
	await expect(item.getByRole('link', { name: 'Open book #77' })).toHaveAttribute('href', '/books/77');
	await expect(page.getByText('Some uploads are still processing')).toHaveCount(0);
	await page.clock.runFor(30_000);
	expect(polls).toBe(2);
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
	const dialogs: string[] = [];
	page.on('dialog', (dialog) => {
		dialogs.push(dialog.message());
		void dialog.accept();
	});
	await form.getByRole('button', { name: 'Save' }).click();
	await expect(form.getByText('Saved NeoDB.')).toBeVisible();
	expect(patches.at(-1)).toEqual({ api_token: null, enabled: false });
	expect(dialogs).toEqual(['Remove the stored token for NeoDB?', 'Disable NeoDB? Books will no longer get details from it.']);
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
	page.on('dialog', (dialog) => void dialog.accept());

	await page.goto('/admin/maintenance');
	const backupCard = page.getByRole('listitem').filter({ hasText: 'Database backup' });
	await expect(backupCard.getByText('Every 24 h')).toBeVisible();
	await expect(backupCard.getByText('Not since the server started')).toBeVisible();
	await expect(page.getByText('resets when the server restarts')).toBeVisible();

	await page.getByRole('button', { name: 'Run Database backup now' }).click();
	await expect(backupCard.getByText('“Database backup” was started.')).toBeVisible();
	await expect(backupCard.getByRole('button', { name: 'Run Database backup now' })).toBeDisabled();
	await page.clock.runFor(2100);
	await page.clock.runFor(2100);
	await expect(backupCard.getByText('Completed').first()).toBeVisible();
	await expect(backupCard.getByRole('button', { name: 'Run Database backup now' })).toBeEnabled();

	const walCard = page.getByRole('listitem').filter({ hasText: 'Database checkpoint' });
	await expect(walCard.getByText('Every 5 min')).toBeVisible();
	await page.getByRole('button', { name: 'Run Database checkpoint now' }).click();
	await expect(walCard.getByText('This job is already running. Its status will refresh automatically.')).toBeVisible();
	await expect(page.getByText('server detail that must not be shown')).toHaveCount(0);
});
