import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

function baseBook(overrides: Record<string, unknown> = {}) {
	return {
		id: 21,
		library_id: 1,
		owner_id: null,
		visibility: 'library',
		can_manage_visibility: false,
		title: 'Old Title',
		sort_title: 'Old Title',
		subtitle: 'Old subtitle',
		description: 'Existing description',
		language: 'en',
		publisher: 'Existing Press',
		published_date: '1999-05',
		page_count: 200,
		cover_url: null,
		cover_source: null,
		authors: [{ id: 4, name: 'A Writer', role: 'author', position: 0 }],
		series: { id: 3, name: 'Existing Saga', index: 1.5 },
		tags: [{ id: 1, name: 'Original' }],
		identifiers: [{ scheme: 'isbn13', value: '9780000000001' }],
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
	await page.route('**/api/v1/**', (route) => route.fulfill({
		status: 404, json: { title: 'Unmocked test endpoint', status: 404 }
	}));
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: role, display_name: role, role, locale } } })
	);
	await page.route('**/api/v1/shelves**', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
}

function field(page: Page, name: string) {
	return page.getByRole('form', { name: 'Book metadata' }).getByRole('group', { name, exact: true });
}

function textInput(page: Page, name: string) {
	return field(page, name).getByRole('textbox').first();
}

function previewJpeg() {
	return Buffer.from(
		'/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
		'base64'
	);
}

async function lookupFixture(page: Page) {
	await page.route('**/api/v1/books/21/metadata/cover', (route) =>
		route.fulfill({ body: previewJpeg(), contentType: 'image/jpeg' })
	);
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => route.fulfill({ json: {
		request_key: 'key-1',
		query: { title: 'Old Title' },
		providers: [
			{ provider: 'openlibrary', candidates: [
				candidate(),
				candidate({ reference: '/works/OL2W', title: 'Alternative Title', cover_url: null })
			], error: null },
			{ provider: 'googlebooks', candidates: [], error: { code: 'provider_unavailable', message: 'Unavailable' } },
			{ provider: 'hardcover', candidates: [], error: null },
			{ provider: 'neodb', candidates: [candidate({
				provider: 'neodb', reference: 'uuid-1', title: 'Other Title', publisher: 'Other Press', cover_url: null
			})], error: null }
		]
	} }));
}

test('the metadata form starts populated and saves direct edits and tags without a lookup', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	const patches: Record<string, unknown>[] = [];
	let lookups = 0;
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => {
		lookups += 1;
		return route.abort();
	});
	await page.route('**/api/v1/books/21', async (route) => {
		if (route.request().method() === 'PATCH') {
			const patch = route.request().postDataJSON() as Record<string, unknown>;
			patches.push(patch);
			const tags = patch.tags as string[];
			current = baseBook({ ...current, ...patch, tags: tags.map((name, index) => ({ id: index + 1, name })) });
		}
		await route.fulfill({ json: { book: current } });
	});

	await page.goto('/books/21');
	await page.getByRole('region', { name: 'Details', exact: true }).getByRole('link', { name: 'Edit metadata' }).click();
	const form = page.getByRole('form', { name: 'Book metadata' });
	await expect(form).toBeVisible();
	await expect(textInput(page, 'Title')).toHaveValue('Old Title');
	await expect(textInput(page, 'Subtitle')).toHaveValue('Old subtitle');
	await expect(textInput(page, 'Description')).toHaveValue('Existing description');
	await expect(textInput(page, 'Language')).toHaveValue('en');
	await expect(textInput(page, 'Publisher')).toHaveValue('Existing Press');
	await expect(textInput(page, 'Publication date')).toHaveValue('1999-05');
	await expect(textInput(page, 'Pages')).toHaveValue('200');
	await expect(field(page, 'Contributors').getByRole('textbox').first()).toHaveValue('A Writer');
	await expect(field(page, 'Series').getByRole('textbox').first()).toHaveValue('Existing Saga');
	await expect(field(page, 'Series').getByRole('textbox').nth(1)).toHaveValue('1.5');
	await expect(field(page, 'Identifiers').getByRole('textbox').last()).toHaveValue('9780000000001');
	await expect(field(page, 'Tags').getByRole('textbox', { name: 'Tag 1', exact: true })).toHaveValue('Original');
	await expect(page.getByRole('region', { name: 'Edit book tags' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Save tags', exact: true })).toHaveCount(0);
	const save = form.getByRole('button', { name: 'Save metadata', exact: true });
	await expect(save).toBeDisabled();
	const saveBox = await save.boundingBox();
	const coverBox = await field(page, 'Cover').boundingBox();
	expect(saveBox!.y).toBeGreaterThan(coverBox!.y + coverBox!.height);

	await textInput(page, 'Title').fill('Edited Title');
	await textInput(page, 'Publisher').fill('');
	const tags = field(page, 'Tags');
	await tags.getByRole('textbox', { name: 'Tag 1', exact: true }).fill('Epic');
	await tags.getByRole('textbox', { name: 'New tag', exact: true }).fill(' Space ');
	await save.click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(patches).toEqual([{ title: 'Edited Title', publisher: null, tags: ['Epic', 'Space'] }]);
	await expect(save).toBeDisabled();
	await page.reload();
	await expect(textInput(page, 'Title')).toHaveValue('Edited Title');
	await expect(tags.getByRole('textbox', { name: 'Tag 2', exact: true })).toHaveValue('Space');
	await tags.getByRole('button', { name: 'Remove tag: Epic', exact: true }).click();
	await tags.getByRole('button', { name: 'Remove tag: Space', exact: true }).click();
	await save.click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(patches[1]).toEqual({ tags: [] });
	await page.reload();
	await expect(tags.getByText('This book has no tags.')).toBeVisible();
	expect(current.description).toBe('Existing description');
	expect(current.identifiers).toEqual([{ scheme: 'isbn13', value: '9780000000001' }]);
	expect(lookups).toBe(0);
});

test('source tabs and alternatives compare aligned rows and preserve mixed drafts until one save', async ({ page }, testInfo) => {
	await authenticate(page);
	let current = baseBook();
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: current } }));
	await lookupFixture(page);
	const applies: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21/metadata/apply', async (route) => {
		applies.push(route.request().postDataJSON() as Record<string, unknown>);
		current = baseBook({ title: 'Alternative Title', publisher: 'Other Press', description: 'My description' });
		await route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/edit');
	await textInput(page, 'Description').fill('My description');
	const find = page.getByRole('button', { name: 'Find metadata', exact: true });
	const findBox = await find.boundingBox();
	const titleBox = await page.getByRole('heading', { name: 'Edit metadata: Old Title' }).boundingBox();
	expect(findBox!.x).toBeGreaterThan(titleBox!.x);
	expect(findBox!.y).toBeLessThan(titleBox!.y + titleBox!.height + 60);
	await find.click();
	await expect(page.getByText('Found 3 candidates.')).toBeVisible();
	await expect(page.getByRole('tab')).toHaveCount(2);
	await expect(page.getByRole('tab', { name: 'openlibrary', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('tab', { name: 'googlebooks', exact: true })).toHaveCount(0);
	await expect(page.getByRole('tab', { name: 'hardcover', exact: true })).toHaveCount(0);
	await expect(page.getByText('googlebooks could not be searched (code: provider_unavailable).')).toBeVisible();
	await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(0);
	await expect(textInput(page, 'Description')).toHaveValue('My description');
	await expect(field(page, 'Title').getByText('New Title', { exact: true })).toBeVisible();
	await page.getByRole('combobox', { name: 'Alternative', exact: true }).selectOption({ label: 'Alternative Title' });
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await expect(textInput(page, 'Title')).toHaveValue('Alternative Title');

	await page.getByRole('tab', { name: 'neodb', exact: true }).click();
	await expect(field(page, 'Title').getByText('Other Title', { exact: true })).toBeVisible();
	await expect(textInput(page, 'Title')).toHaveValue('Alternative Title');
	await field(page, 'Publisher').getByRole('button', { name: 'Use found Publisher', exact: true }).click();
	await field(page, 'Subtitle').getByRole('button', { name: 'Use found Subtitle', exact: true }).click();
	await expect(textInput(page, 'Subtitle')).toHaveValue('');
	await field(page, 'Subtitle').getByRole('button', { name: 'Restore existing Subtitle', exact: true }).click();
	await expect(textInput(page, 'Subtitle')).toHaveValue('Old subtitle');
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({ path: testInfo.outputPath('metadata-comparison.png'), fullPage: true });
	expect(applies).toHaveLength(0);
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(applies).toEqual([{
		request_key: 'key-1',
		fields: {
			title: { provider: 'openlibrary', reference: '/works/OL2W' },
			publisher: { provider: 'neodb', reference: 'uuid-1' }
		},
		patch: { description: 'My description' }
	}]);
});

test('direct edits preserve contributor roles and order, series positions, pages and identifiers', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	const patches: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21', (route) => {
		if (route.request().method() === 'PATCH') {
			const patch = route.request().postDataJSON() as Record<string, unknown>;
			patches.push(patch);
			current = baseBook({
				...current, ...patch,
				authors: (patch.authors as { name: string; role: string }[]).map((person, position) => ({
					...person, id: position + 1, position
				})),
				series: { id: 3, ...(patch.series as { name: string; index: number }) }
			});
		}
		return route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/edit');
	const contributors = field(page, 'Contributors');
	await contributors.getByRole('textbox', { name: 'Name 1', exact: true }).fill('Revised Writer');
	await contributors.getByRole('combobox', { name: 'Role 1', exact: true }).selectOption('editor');
	await contributors.getByRole('button', { name: 'Add contributor', exact: true }).click();
	await contributors.getByRole('textbox', { name: 'Name 2', exact: true }).fill('A Translator');
	await contributors.getByRole('combobox', { name: 'Role 2', exact: true }).selectOption('translator');
	await contributors.getByRole('button', { name: 'Move contributor 2 up', exact: true }).click();
	await textInput(page, 'Pages').fill('321');
	await field(page, 'Series').getByRole('textbox', { name: 'Series name', exact: true }).fill('Revised Saga');
	await field(page, 'Series').getByRole('textbox', { name: 'Series index', exact: true }).fill('2.5');
	await field(page, 'Identifiers').getByRole('textbox', { name: 'Scheme 1', exact: true }).fill('openlibrary');
	await field(page, 'Identifiers').getByRole('textbox', { name: 'Value 1', exact: true }).fill('/works/OL1W');
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(patches).toEqual([{
		authors: [{ name: 'A Translator', role: 'translator' }, { name: 'Revised Writer', role: 'editor' }],
		page_count: 321, series: { name: 'Revised Saga', index: 2.5 },
		identifiers: [{ scheme: 'openlibrary', value: '/works/OL1W' }]
	}]);
	await page.reload();
	await expect(contributors.getByRole('textbox', { name: 'Name 1', exact: true })).toHaveValue('A Translator');
	await expect(contributors.getByRole('combobox', { name: 'Role 1', exact: true })).toHaveValue('translator');
	await expect(contributors.getByRole('combobox', { name: 'Role 2', exact: true })).toHaveValue('editor');
	await expect(field(page, 'Series').getByRole('textbox', { name: 'Series index', exact: true })).toHaveValue('2.5');
	await expect(field(page, 'Identifiers').getByRole('textbox', { name: 'Value 1', exact: true })).toHaveValue('/works/OL1W');
	expect(current.tags).toEqual([{ id: 1, name: 'Original' }]);
});

test('use all copies available values, manual edits clear references, and restore returns saved values', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await lookupFixture(page);
	const applies: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21/metadata/apply', (route) => {
		applies.push(route.request().postDataJSON() as Record<string, unknown>);
		return route.fulfill({ json: { book: baseBook({ title: 'Handwritten Title', publisher: 'Provider Press' }) } });
	});
	await page.goto('/books/21/edit');
	await page.getByRole('button', { name: 'Find metadata', exact: true }).click();
	await page.getByRole('button', { name: 'Use all found values', exact: true }).click();
	await expect(textInput(page, 'Title')).toHaveValue('New Title');
	await expect(textInput(page, 'Subtitle')).toHaveValue('Old subtitle');
	await expect(field(page, 'Contributors').getByRole('textbox').first()).toHaveValue('First Author');
	await expect(field(page, 'Contributors').getByRole('textbox').nth(1)).toHaveValue('Second Person');
	await expect(field(page, 'Tags').getByRole('textbox', { name: 'Tag 1', exact: true })).toHaveValue('Fantasy');
	await page.getByRole('button', { name: 'Restore all existing values', exact: true }).click();
	await expect(textInput(page, 'Title')).toHaveValue('Old Title');
	await expect(field(page, 'Tags').getByRole('textbox', { name: 'Tag 1', exact: true })).toHaveValue('Original');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeDisabled();
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await textInput(page, 'Title').fill('Handwritten Title');
	await field(page, 'Publisher').getByRole('button', { name: 'Use found Publisher', exact: true }).click();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(applies).toEqual([{
		request_key: 'key-1',
		fields: { publisher: { provider: 'openlibrary', reference: '/works/OL1W' } },
		patch: { title: 'Handwritten Title' }
	}]);
});

test('failed saves keep drafts and disable mutation while pending, and tag validation does not send a request', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	const patches: Record<string, unknown>[] = [];
	let finishSave: (() => void) | undefined;
	await page.route('**/api/v1/books/21', async (route) => {
		if (route.request().method() !== 'PATCH') return route.fulfill({ json: { book: current } });
		const patch = route.request().postDataJSON() as Record<string, unknown>;
		patches.push(patch);
		if (patches.length === 1) {
			await new Promise<void>((resolve) => { finishSave = resolve; });
			return route.fulfill({ status: 500, json: { title: 'Internal error' } });
		}
		current = baseBook({ ...current, ...patch });
		await route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/edit');
	const tags = field(page, 'Tags');
	await tags.getByRole('textbox', { name: 'New tag', exact: true }).fill(' original ');
	await tags.getByRole('button', { name: 'Add tag', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Tag names must be unique');
	expect(patches).toHaveLength(0);
	await tags.getByRole('textbox', { name: 'New tag', exact: true }).fill('');
	await textInput(page, 'Title').fill('Retry Title');
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Saving metadata…', exact: true })).toBeDisabled();
	await expect(textInput(page, 'Title')).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Find metadata', exact: true })).toBeDisabled();
	await expect.poll(() => !!finishSave).toBe(true);
	finishSave!();
	await expect(page.getByRole('alert')).toBeVisible();
	await expect(textInput(page, 'Title')).toHaveValue('Retry Title');
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(patches).toEqual([{ title: 'Retry Title' }, { title: 'Retry Title' }]);
	await page.reload();
	await expect(textInput(page, 'Title')).toHaveValue('Retry Title');
});

test('stale candidate saves refresh results without losing manual edits or saving copied fields as manual', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: current } }));
	let lookups = 0;
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => {
		lookups += 1;
		return route.fulfill({ json: {
			request_key: `key-${lookups}`, query: {}, providers: [
				{ provider: 'openlibrary', candidates: [candidate({ cover_url: null })], error: null }
			]
		} });
	});
	const applies: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21/metadata/apply', (route) => {
		applies.push(route.request().postDataJSON() as Record<string, unknown>);
		if (applies.length === 1) {
			return route.fulfill({ status: 409, contentType: 'application/problem+json', body: '{"status":409,"title":"Conflict"}' });
		}
		current = baseBook({ title: 'New Title', description: 'Keep my manual text' });
		return route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/edit');
	await textInput(page, 'Description').fill('Keep my manual text');
	await page.getByRole('button', { name: 'Find metadata', exact: true }).click();
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('expired or changed');
	await expect.poll(() => lookups).toBe(2);
	await expect(textInput(page, 'Description')).toHaveValue('Keep my manual text');
	await expect(textInput(page, 'Title')).toHaveValue('Old Title');
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(applies[1]).toEqual({
		request_key: 'key-2',
		fields: { title: { provider: 'openlibrary', reference: '/works/OL1W' } },
		patch: { description: 'Keep my manual text' }
	});
});

test('a failed conflict refresh blocks saving until existing values can be refreshed safely', async ({ page }) => {
	await authenticate(page);
	let getRequests = 0;
	await page.route('**/api/v1/books/21', (route) => {
		getRequests += 1;
		return getRequests === 2
			? route.fulfill({ status: 500, json: { title: 'Refresh failed', status: 500 } })
			: route.fulfill({ json: { book: baseBook({ title: getRequests > 2 ? 'Latest saved title' : 'Old Title' }) } });
	});
	let lookups = 0;
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => {
		lookups += 1;
		return route.fulfill({ json: {
			request_key: `key-${lookups}`, query: {}, providers: [
				{ provider: 'openlibrary', candidates: [candidate({ cover_url: null })], error: null }
			]
		} });
	});
	let applies = 0;
	await page.route('**/api/v1/books/21/metadata/apply', (route) => {
		applies += 1;
		return route.fulfill({ status: 409, json: { title: 'Conflict', status: 409 } });
	});
	await page.goto('/books/21/edit');
	await textInput(page, 'Description').fill('Manual text survives recovery');
	await page.getByRole('button', { name: 'Find metadata', exact: true }).click();
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Saving is blocked');
	await expect(textInput(page, 'Title')).toHaveValue('New Title');
	await expect(textInput(page, 'Description')).toHaveValue('Manual text survives recovery');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeDisabled();
	expect(applies).toBe(1);
	await page.getByRole('button', { name: 'Retry refreshing existing values', exact: true }).click();
	await expect(textInput(page, 'Title')).toHaveValue('Latest saved title');
	await expect(textInput(page, 'Description')).toHaveValue('Manual text survives recovery');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeEnabled();
	expect(lookups).toBe(2);
	expect(applies).toBe(1);
});

test('repeating lookup reconciles selected fields without converting them into manual edits', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	const patches: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21', (route) => {
		if (route.request().method() === 'PATCH') {
			const patch = route.request().postDataJSON() as Record<string, unknown>;
			patches.push(patch);
			current = baseBook({ ...current, ...patch });
		}
		return route.fulfill({ json: { book: current } });
	});
	let lookups = 0;
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => {
		lookups += 1;
		return route.fulfill({ json: {
			request_key: `key-${lookups}`, query: {}, providers: [
				{ provider: 'openlibrary', candidates: lookups < 3 ? [
					candidate({ publisher: lookups === 1 ? 'First Press' : 'Refreshed Press', cover_url: null })
				] : [], error: null }
			]
		} });
	});
	const applies: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21/metadata/apply', (route) => {
		applies.push(route.request().postDataJSON() as Record<string, unknown>);
		current = baseBook({ publisher: 'Refreshed Press', description: 'Manual draft' });
		return route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/edit');
	await textInput(page, 'Description').fill('Manual draft');
	const find = page.getByRole('button', { name: 'Find metadata', exact: true });
	await find.click();
	await field(page, 'Publisher').getByRole('button', { name: 'Use found Publisher', exact: true }).click();
	await expect(textInput(page, 'Publisher')).toHaveValue('First Press');
	await find.click();
	await expect(textInput(page, 'Publisher')).toHaveValue('Refreshed Press');
	await expect(textInput(page, 'Description')).toHaveValue('Manual draft');
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(applies).toEqual([{
		request_key: 'key-2',
		fields: { publisher: { provider: 'openlibrary', reference: '/works/OL1W' } },
		patch: { description: 'Manual draft' }
	}]);
	await textInput(page, 'Description').fill('Still manual');
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await find.click();
	await expect(page.getByRole('tab')).toHaveCount(0);
	await expect(textInput(page, 'Title')).toHaveValue('Old Title');
	await expect(textInput(page, 'Description')).toHaveValue('Still manual');
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(patches).toEqual([{ description: 'Still manual' }]);
});

test('an unavailable cover preview does not discard the metadata form and can be retried', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await lookupFixture(page);
	let unavailable = true;
	await page.route('**/api/v1/books/21/metadata/cover', (route) => unavailable
		? route.fulfill({ status: 404, json: { title: 'Cover not found', status: 404 } })
		: route.fulfill({ body: previewJpeg(), contentType: 'image/jpeg' })
	);
	await page.goto('/books/21/edit');
	await textInput(page, 'Title').fill('Retained title');
	await page.getByRole('button', { name: 'Find metadata', exact: true }).click();
	await expect(field(page, 'Cover').getByRole('alert')).toContainText('preview could not be loaded');
	await expect(textInput(page, 'Title')).toHaveValue('Retained title');
	unavailable = false;
	await field(page, 'Cover').getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(field(page, 'Cover').getByRole('img', { name: 'Cover preview from openlibrary' })).toHaveAttribute('src', /^blob:/);
	await expect(textInput(page, 'Title')).toHaveValue('Retained title');
});

test('covers are previewed through the server and source tabs work with keyboard and small screens', async ({ page }, testInfo) => {
	await authenticate(page);
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await lookupFixture(page);
	const coverRequests: unknown[] = [];
	await page.route('**/api/v1/books/21/metadata/cover', (route) => {
		coverRequests.push(route.request().postDataJSON());
		return route.fulfill({ body: previewJpeg(), contentType: 'image/jpeg' });
	});
	let externalRequests = 0;
	await page.route('https://covers.openlibrary.org/**', (route) => {
		externalRequests += 1;
		return route.abort();
	});
	await page.goto('/books/21/edit');
	await page.getByRole('button', { name: 'Find metadata', exact: true }).click();
	const cover = field(page, 'Cover');
	await expect(cover.getByRole('img', { name: 'Cover preview from openlibrary' })).toHaveAttribute('src', /^blob:/);
	expect(coverRequests).toEqual([{ request_key: 'key-1', provider: 'openlibrary', reference: '/works/OL1W' }]);
	expect(externalRequests).toBe(0);
	await page.getByRole('tab', { name: 'openlibrary', exact: true }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByRole('tab', { name: 'neodb', exact: true })).toBeFocused();
	await expect(page.getByRole('tab', { name: 'neodb', exact: true })).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Home');
	await expect(page.getByRole('tab', { name: 'openlibrary', exact: true })).toBeFocused();
	await expect(page.getByRole('tab', { name: 'openlibrary', exact: true })).toHaveAttribute('aria-selected', 'true');
	const accessibility = await new AxeBuilder({ page }).include('form[aria-label="Book metadata"]').analyze();
	expect(accessibility.violations).toEqual([]);
	await page.setViewportSize({ width: 390, height: 900 });
	const dimensions = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth
	}));
	expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
	await expect(textInput(page, 'Title')).toBeVisible();
	await expect(field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true })).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({ path: testInfo.outputPath('metadata-mobile.png'), fullPage: true });
});

test('sources with no candidates have no tabs and direct editing remains available', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => route.fulfill({ json: {
		request_key: 'empty-key', query: {}, providers: [{ provider: 'openlibrary', candidates: [], error: null }]
	} }));
	await page.goto('/books/21/edit');
	await page.getByRole('button', { name: 'Find metadata', exact: true }).click();
	await expect(page.getByRole('tab')).toHaveCount(0);
	await expect(page.getByText('No provider returned candidates for this book.')).toBeVisible();
	await expect(textInput(page, 'Title')).toHaveValue('Old Title');
	await textInput(page, 'Title').fill('Still editable');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeEnabled();
});

test('non-administrators do not see the edit entry and are refused by the edit route', async ({ page }) => {
	await authenticate(page, 'user', 'zh');
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await page.goto('/books/21');
	await expect(page.getByRole('heading', { name: 'Old Title' })).toBeVisible();
	await expect(page.getByRole('link', { name: '编辑元数据' })).toHaveCount(0);
	await page.goto('/books/21/edit');
	await expect(page.getByRole('alert')).toHaveText('只有管理员可以编辑图书元数据。');
	await expect(page.locator('form.metadata-form')).toHaveCount(0);
});
