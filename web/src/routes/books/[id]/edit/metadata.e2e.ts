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
	await expect(page.getByRole('heading', { name: '编辑图书标签' })).toHaveCount(0);
});

test('manually adds, edits and removes tags including the last tag without provider lookup', async ({ page }, testInfo) => {
	await authenticate(page);
	let current = baseBook({ description: 'Preserved description', identifiers: [{ scheme: 'isbn13', value: '9780000000001' }] });
	const patches: { tags: string[] }[] = [];
	let lookups = 0;
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => {
		lookups += 1;
		return route.abort();
	});
	await page.route('**/api/v1/books/21', async (route) => {
		if (route.request().method() === 'PATCH') {
			const body = route.request().postDataJSON() as { tags: string[] };
			expect(Object.keys(body)).toEqual(['tags']);
			patches.push(body);
			current = baseBook({ ...current, tags: body.tags.map((name, index) => ({ id: index + 1, name })) });
		}
		await route.fulfill({ json: { book: current } });
	});

	await page.goto('/books/21/edit');
	const editor = page.getByRole('region', { name: 'Edit book tags' });
	await expect(editor.getByText('This book has no tags.')).toBeVisible();
	await editor.getByRole('textbox', { name: 'New tag', exact: true }).fill(' Fantasy ');
	await editor.getByRole('button', { name: 'Add tag', exact: true }).click();
	await editor.getByRole('textbox', { name: 'New tag', exact: true }).fill('Space');
	await editor.getByRole('button', { name: 'Save tags', exact: true }).click();
	await expect(editor.getByRole('status')).toHaveText('Tags saved.');
	expect(patches).toEqual([{ tags: ['Fantasy', 'Space'] }]);
	await page.reload();
	await expect(editor.getByRole('textbox', { name: 'Tag 1', exact: true })).toHaveValue('Fantasy');
	await expect(editor.getByRole('textbox', { name: 'Tag 2', exact: true })).toHaveValue('Space');

	await editor.getByRole('textbox', { name: 'Tag 1', exact: true }).fill('Epic');
	await editor.getByRole('button', { name: 'Remove tag: Space', exact: true }).click();
	await editor.getByRole('button', { name: 'Save tags', exact: true }).click();
	await expect(editor.getByRole('status')).toHaveText('Tags saved.');
	await page.reload();
	await expect(editor.getByRole('textbox', { name: 'Tag 1', exact: true })).toHaveValue('Epic');
	await expect(editor.getByRole('textbox', { name: /^Tag \d+$/ })).toHaveCount(1);

	await page.getByRole('link', { name: 'Back to book', exact: true }).click();
	await expect(page.getByRole('list', { name: 'Tags', exact: true }).getByRole('link')).toHaveText(['Epic']);
	const card = page.getByRole('region', { name: 'Details', exact: true });
	await expect(card.getByText('Epic', { exact: true })).toHaveCount(0);
	await card.getByRole('link', { name: 'Edit metadata', exact: true }).click();
	await expect(editor.getByRole('textbox', { name: 'Tag 1', exact: true })).toHaveValue('Epic');
	await page.setViewportSize({ width: 390, height: 900 });
	const dimensions = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth
	}));
	expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
	await editor.screenshot({ path: testInfo.outputPath('tags-editor.png') });

	await editor.getByRole('button', { name: 'Remove tag: Epic', exact: true }).click();
	await editor.getByRole('button', { name: 'Save tags', exact: true }).click();
	await expect(editor.getByRole('status')).toHaveText('Tags saved.');
	await page.reload();
	await expect(editor.getByText('This book has no tags.')).toBeVisible();
	expect(patches).toEqual([{ tags: ['Fantasy', 'Space'] }, { tags: ['Epic'] }, { tags: [] }]);
	expect(current.description).toBe('Preserved description');
	expect(current.identifiers).toEqual([{ scheme: 'isbn13', value: '9780000000001' }]);
	expect(lookups).toBe(0);
});

test('tag validation and failed saves retain all drafts and support explicit retry', async ({ page }) => {
	await authenticate(page);
	let current = baseBook({ tags: [{ id: 1, name: 'Fantasy' }, { id: 2, name: 'Space' }] });
	const patches: { tags: string[] }[] = [];
	let finishSave: (() => void) | undefined;
	await page.route('**/api/v1/books/21', async (route) => {
		if (route.request().method() !== 'PATCH') return route.fulfill({ json: { book: current } });
		const body = route.request().postDataJSON() as { tags: string[] };
		patches.push(body);
		if (patches.length === 1) {
			await new Promise<void>((resolve) => { finishSave = resolve; });
			return route.fulfill({ status: 500, json: { title: 'Internal error' } });
		}
		current = baseBook({ ...current, tags: body.tags.map((name, index) => ({ id: index + 1, name })) });
		await route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/edit');
	const editor = page.getByRole('region', { name: 'Edit book tags' });
	await editor.getByRole('textbox', { name: 'New tag', exact: true }).fill(' fantasy ');
	await editor.getByRole('button', { name: 'Add tag', exact: true }).click();
	await expect(editor.getByRole('alert')).toContainText('Tag names must be unique');
	expect(patches).toHaveLength(0);
	await editor.getByRole('textbox', { name: 'New tag', exact: true }).fill('History');
	await editor.getByRole('button', { name: 'Add tag', exact: true }).click();
	await editor.getByRole('textbox', { name: 'Tag 1', exact: true }).fill('Epic');
	await editor.getByRole('button', { name: 'Remove tag: Space', exact: true }).click();
	await editor.getByRole('button', { name: 'Save tags', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Saving tags…' })).toBeDisabled();
	await expect(editor.getByRole('textbox', { name: 'Tag 1', exact: true })).toBeDisabled();
	await expect(editor.getByRole('button', { name: 'Remove tag: Epic', exact: true })).toBeDisabled();
	await expect.poll(() => !!finishSave).toBe(true);
	finishSave!();
	await expect(editor.getByRole('alert')).toContainText('Your edits are still here');
	await expect(editor.getByRole('textbox', { name: 'Tag 1', exact: true })).toHaveValue('Epic');
	await expect(editor.getByRole('textbox', { name: 'Tag 2', exact: true })).toHaveValue('History');
	await editor.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(editor.getByRole('status')).toHaveText('Tags saved.');
	expect(patches).toEqual([{ tags: ['Epic', 'History'] }, { tags: ['Epic', 'History'] }]);
	await page.reload();
	await expect(editor.getByRole('textbox', { name: 'Tag 1', exact: true })).toHaveValue('Epic');
	await expect(editor.getByRole('textbox', { name: 'Tag 2', exact: true })).toHaveValue('History');
});

test('manual tag drafts cannot be overwritten by provider apply and synchronize after a tag merge', async ({ page }) => {
	await authenticate(page);
	let current = baseBook({ tags: [{ id: 1, name: 'Original' }] });
	await page.route('**/api/v1/books/21', async (route) => {
		if (route.request().method() === 'PATCH') {
			const { tags } = route.request().postDataJSON() as { tags: string[] };
			current = baseBook({ ...current, tags: tags.map((name, index) => ({ id: index + 1, name })) });
		}
		await route.fulfill({ json: { book: current } });
	});
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => route.fulfill({ json: {
		request_key: 'tag-key', query: {}, providers: [{ provider: 'openlibrary', candidates: [candidate()], error: null }]
	} }));
	let finishApply: (() => void) | undefined;
	await page.route('**/api/v1/books/21/metadata/apply', async (route) => {
		expect(route.request().postDataJSON()).toEqual({
			request_key: 'tag-key', fields: { tags: { provider: 'openlibrary', reference: '/works/OL1W' } }
		});
		await new Promise<void>((resolve) => { finishApply = resolve; });
		current = baseBook({ ...current, tags: [{ id: 3, name: 'Fantasy' }] });
		await route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/edit');
	const editor = page.getByRole('region', { name: 'Edit book tags' });
	await page.getByRole('button', { name: 'Find metadata candidates' }).click();
	await page.getByRole('group', { name: 'Tags', exact: true }).getByRole('radio', { name: 'openlibrary: New Title' }).check();
	await editor.getByRole('textbox', { name: 'Tag 1', exact: true }).fill('Manual');
	const apply = page.getByRole('button', { name: 'Apply selected fields (1)' });
	await expect(apply).toBeDisabled();
	await expect(editor.getByText(/Save them before applying provider metadata/)).toBeVisible();
	await editor.getByRole('button', { name: 'Save tags', exact: true }).click();
	await expect(editor.getByRole('status')).toHaveText('Tags saved.');
	await expect(page.getByRole('group', { name: 'Tags', exact: true }).getByText('Manual', { exact: true })).toBeVisible();
	await apply.click();
	await expect(editor.getByRole('textbox', { name: 'Tag 1', exact: true })).toBeDisabled();
	await expect.poll(() => !!finishApply).toBe(true);
	finishApply!();
	await expect(page.getByText('Metadata updated.', { exact: true })).toBeVisible();
	await expect(editor.getByRole('textbox', { name: 'Tag 1', exact: true })).toHaveValue('Fantasy');
	await expect(editor.getByRole('button', { name: 'Save tags', exact: true })).toBeDisabled();
});
