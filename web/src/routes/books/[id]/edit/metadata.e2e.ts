import { expect, test, type Page } from '@playwright/test';

function baseBook(overrides: Record<string, unknown> = {}) {
	return {
		id: 21,
		library_id: 1,
		title: 'Old Title',
		sort_title: 'Old Title',
		subtitle: 'Old subtitle',
		description: null,
		language: 'en',
		publisher: null,
		published_date: null,
		page_count: null,
		cover_url: null,
		cover_source: null,
		authors: [{ id: 4, name: 'A Writer', role: 'author', position: 0 }],
		series: null,
		tags: [],
		identifiers: [],
		files: [],
		field_sources: [],
		created_at: '2026-11-04T00:00:00Z',
		updated_at: '2026-11-04T00:00:00Z',
		...overrides
	};
}

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		provider: 'openlibrary',
		reference: '/works/OL1W',
		title: 'New Title',
		subtitle: null,
		authors: [{ name: 'First Author', role: 'author' }, { name: 'Second Person', role: 'translator' }],
		description: 'Provider description',
		publisher: 'Provider Press',
		published_date: '2020-05',
		language: 'en',
		page_count: 320,
		series: { name: 'Saga', index: null },
		tags: ['Fantasy'],
		identifiers: [{ scheme: 'isbn13', value: '9780000000002' }],
		cover_url: 'https://covers.openlibrary.org/b/id/1-L.jpg',
		...overrides
	};
}

async function authenticate(page: Page, role = 'admin', locale = 'en') {
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: role, display_name: role, role, locale } } })
	);
	await page.route('**/api/v1/shelves**', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
}

test('admin compares candidates per field, recovers from a stale key, and applies references', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: current } }));
	await page.route('**/api/v1/books/21/cover', (route) => route.fulfill({ status: 404, body: '' }));
	let lookups = 0;
	await page.route('**/api/v1/books/21/metadata/candidates', async (route) => {
		expect(route.request().method()).toBe('POST');
		expect(route.request().postData() ?? '').toBe('');
		lookups += 1;
		await route.fulfill({
			json: {
				request_key: `key-${lookups}`,
				query: { title: 'Old Title' },
				providers: [
					{ provider: 'openlibrary', candidates: [candidate()], error: null },
					{ provider: 'googlebooks', candidates: [], error: { code: 'provider_unavailable', message: 'Unavailable' } },
					{ provider: 'neodb', candidates: [candidate({ provider: 'neodb', reference: 'uuid-1', title: 'Other Title', cover_url: null })], error: null }
				]
			}
		});
	});
	const coverRequests: unknown[] = [];
	await page.route('**/api/v1/books/21/metadata/cover', async (route) => {
		coverRequests.push(route.request().postDataJSON());
		const jpeg = Buffer.from(
			'/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
			'base64'
		);
		await route.fulfill({ body: jpeg, contentType: 'image/jpeg' });
	});
	const applies: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21/metadata/apply', async (route) => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		applies.push(body);
		if (applies.length === 1) {
			await route.fulfill({
				status: 409,
				contentType: 'application/problem+json',
				body: JSON.stringify({ title: 'Conflict', status: 409 })
			});
			return;
		}
		current = baseBook({ title: 'New Title', publisher: 'Provider Press', cover_url: '/api/v1/books/21/cover', cover_source: 'openlibrary' });
		await route.fulfill({ json: { book: current } });
	});
	let externalRequests = 0;
	await page.route('https://covers.openlibrary.org/**', (route) => {
		externalRequests += 1;
		return route.abort();
	});

	await page.goto('/books/21');
	await page.getByRole('region', { name: 'Details', exact: true }).getByRole('link', { name: 'Edit metadata' }).click();
	await expect(page.getByRole('heading', { name: 'Edit metadata: Old Title' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Generate PDF covers' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Generate missing covers' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Find metadata candidates' }).click();
	await expect(page.getByText('Found 2 candidates.')).toBeVisible();
	await expect(page.getByText('googlebooks could not be searched (code: provider_unavailable).')).toBeVisible();
	await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(0);

	const title = page.getByRole('group', { name: 'Title', exact: true });
	await expect(title.getByRole('radio', { name: /^Keep current/ })).toBeChecked();
	await title.getByRole('radio', { name: 'openlibrary: New Title' }).check();
	const publisher = page.getByRole('group', { name: 'Publisher', exact: true });
	await publisher.getByRole('radio', { name: 'neodb: Other Title' }).check();
	const cover = page.getByRole('group', { name: 'Cover', exact: true });
	await expect(cover.getByRole('radio')).toHaveCount(2);
	await cover.getByRole('button', { name: 'Preview cover' }).click();
	await expect(cover.getByRole('img', { name: 'Cover preview from openlibrary' })).toHaveAttribute('src', /^blob:/);
	await cover.getByRole('radio', { name: 'openlibrary: New Title' }).check();
	expect(coverRequests).toEqual([{ request_key: 'key-1', provider: 'openlibrary', reference: '/works/OL1W' }]);

	await page.getByRole('button', { name: 'Apply selected fields (3)' }).click();
	await expect(page.getByRole('alert')).toContainText('expired or changed');
	await expect(page.getByText('Found 2 candidates.')).toBeVisible();
	expect(lookups).toBe(2);
	await expect(page.getByRole('button', { name: 'Apply selected fields (0)' })).toBeDisabled();
	await expect(title.getByRole('radio', { name: /^Keep current/ })).toBeChecked();

	await title.getByRole('radio', { name: 'openlibrary: New Title' }).check();
	await page.getByRole('group', { name: 'Publisher', exact: true }).getByRole('radio', { name: 'openlibrary: New Title' }).check();
	await page.keyboard.press('Tab');
	await page.getByRole('button', { name: 'Apply selected fields (2)' }).click();
	await expect(page.getByText('Metadata updated.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Edit metadata: New Title' })).toBeVisible();
	expect(applies[1]).toEqual({
		request_key: 'key-2',
		fields: {
			title: { provider: 'openlibrary', reference: '/works/OL1W' },
			publisher: { provider: 'openlibrary', reference: '/works/OL1W' }
		}
	});
	expect(JSON.stringify(applies)).not.toContain('covers.openlibrary.org');
	expect(externalRequests).toBe(0);
});

test('non-administrators do not see the edit entry and are refused by the edit route', async ({ page }) => {
	await authenticate(page, 'user', 'zh');
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await page.goto('/books/21');
	await expect(page.getByRole('heading', { name: 'Old Title' })).toBeVisible();
	await expect(page.getByRole('link', { name: '编辑元数据' })).toHaveCount(0);
	await page.goto('/books/21/edit');
	await expect(page.getByRole('alert')).toHaveText('只有管理员可以编辑图书元数据。');
});
