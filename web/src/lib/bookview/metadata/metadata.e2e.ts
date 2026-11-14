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
		series: { id: 3, name: 'Existing Saga', index: 1.5, total: 4 },
		tags: [{ id: 1, name: 'Original' }],
		genres: ['Fiction'],
		moods: [],
		age_rating: null,
		content_rating: null,
		ratings: [{ provider: 'goodreads', rating: 4.25, count: 12 }],
		identifiers: [{ scheme: 'isbn13', value: '9780000000001' }],
		files: [],
		field_sources: [{ field: 'title', source: 'manual', source_ref: null, chosen_by: 1, chosen_at: '2026-11-04T00:00:00Z' }],
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
		series: { name: 'Saga', index: null, total: null },
		tags: ['Fantasy'],
		genres: ['Epic Fantasy'],
		moods: ['Dark'],
		age_rating: 16,
		content_rating: 'mature',
		rating: 3.9,
		rating_count: 120,
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

function tab(page: Page) {
	return page.locator('.metadata-tab');
}

function form(page: Page) {
	return page.getByRole('form', { name: 'Book metadata' });
}

function field(page: Page, name: string) {
	return form(page).getByRole('group', { name, exact: true });
}

function textInput(page: Page, name: string) {
	return field(page, name).getByRole('textbox').first();
}

/** The read-only draft column of a Search view comparison row. */
function draft(page: Page, name: string) {
	return field(page, name).locator('.draft-value');
}

function edit(page: Page) {
	return page.getByRole('button', { name: 'Edit', exact: true });
}

function restore(page: Page) {
	return page.getByRole('button', { name: 'Restore all existing values', exact: true });
}

function metadata(page: Page) {
	return page.getByRole('button', { name: 'Metadata', exact: true });
}

function searchMetadata(page: Page) {
	return page.getByRole('button', { name: 'Search metadata', exact: true });
}

async function expectClean(page: Page) {
	await expect(edit(page)).toBeEnabled();
	await expect(restore(page)).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toHaveCount(0);
	await expect(textInput(page, 'Title')).toBeEnabled();
	await expect(form(page).locator('input:disabled, textarea:disabled, select:disabled')).toHaveCount(0);
	await expect(form(page).locator('.save-controls')).toHaveCount(0);
}

async function search(page: Page) {
	await page.getByRole('button', { name: 'Search providers', exact: true }).click();
}

function previewJpeg() {
	return Buffer.from(
		'/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
		'base64'
	);
}

async function lookupFixture(page: Page, bodies: unknown[] = []) {
	await page.route('**/api/v1/books/21/metadata/cover', (route) =>
		route.fulfill({ body: previewJpeg(), contentType: 'image/jpeg' })
	);
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => {
		bodies.push(route.request().postDataJSON());
		return route.fulfill({ json: {
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
		} });
	});
}

test('the metadata tab sits between Details and Files and the old edit route redirects to it', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await page.goto('/books/21');
	const tabs = page.getByRole('navigation', { name: 'Book sections' }).getByRole('link')
		.filter({ hasText: /^\s*(Details|Metadata|Files|Activities|Annotations)\b/ });
	await expect(tabs).toHaveText([/Details/, /Metadata/, /Files/, /Activities/, /Annotations/]);
	await page.getByRole('region', { name: 'Details', exact: true }).getByRole('link', { name: 'Edit metadata' }).click();
	await expect(page).toHaveURL(/\/books\/21\/metadata$/);
	await expect(textInput(page, 'Title')).toHaveValue('Old Title');
	await expectClean(page);
	await page.goto('/books/21/edit?view=search');
	await expect(page).toHaveURL(/\/books\/21\/metadata\?view=search$/);
	await expect(page.getByRole('form', { name: 'Search metadata' })).toBeVisible();
	await expect(metadata(page)).toBeEnabled();
});

test('metadata is immediately editable and the icon row saves changed fields without a lookup', async ({ page }) => {
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
			const tags = (patch.tags ?? current.tags.map((tag) => tag.name)) as string[];
			current = baseBook({ ...current, ...patch, tags: tags.map((name, index) => ({ id: index + 1, name })) });
		}
		await route.fulfill({ json: { book: current } });
	});

	await page.goto('/books/21/metadata');
	await expectClean(page);
	await expect(page.getByRole('navigation', { name: 'Metadata view' })).toHaveCount(0);
	await expect(searchMetadata(page)).toBeEnabled();
	const icons = form(page).locator('.cover-actions').getByRole('button');
	await expect(icons).toHaveCount(3);
	await expect(icons.nth(0)).toHaveAccessibleName('Edit');
	await expect(icons.nth(1)).toHaveAccessibleName('Restore all existing values');
	await expect(icons.nth(2)).toHaveAccessibleName('Search metadata');
	await expect(textInput(page, 'Title')).toHaveValue('Old Title');
	await expect(field(page, 'Title').getByText('Manual', { exact: true })).toBeVisible();
	await expect(textInput(page, 'Subtitle')).toHaveValue('Old subtitle');
	await expect(textInput(page, 'Description')).toHaveValue('Existing description');
	await expect(textInput(page, 'Language')).toHaveValue('en');
	await expect(textInput(page, 'Publisher')).toHaveValue('Existing Press');
	await expect(textInput(page, 'Publication date')).toHaveValue('1999-05');
	await expect(textInput(page, 'Pages')).toHaveValue('200');
	await expect(textInput(page, 'ISBN-13')).toHaveValue('9780000000001');
	await expect(textInput(page, 'ISBN-10')).toHaveValue('');
	await expect(field(page, 'Contributors').getByRole('textbox').first()).toHaveValue('A Writer');
	await expect(field(page, 'Series').getByRole('textbox', { name: 'Series name' })).toHaveValue('Existing Saga');
	await expect(field(page, 'Series').getByRole('textbox', { name: 'Series index' })).toHaveValue('1.5');
	await expect(field(page, 'Series').getByRole('textbox', { name: 'Series total' })).toHaveValue('4');
	await expect(field(page, 'Tags').getByText('Original', { exact: true })).toBeVisible();
	await expect(field(page, 'Genres').getByText('Fiction', { exact: true })).toBeVisible();
	await expect(field(page, 'Moods').getByText('No moods')).toBeVisible();
	await expect(field(page, 'Ratings')).toContainText('goodreads');
	await expect(field(page, 'Ratings')).toContainText('4.25');
	await expect(field(page, 'Identifiers').getByRole('combobox', { name: 'Scheme 1' })).toHaveValue('isbn13');
	await expect(field(page, 'Identifiers').getByRole('combobox', { name: 'Scheme 1' })).toBeEnabled();
	await expect(textInput(page, 'Title')).toBeEnabled();
	const save = page.getByRole('button', { name: 'Save metadata', exact: true });
	await expect(save).toHaveCount(0);
	await expect(form(page).locator('.save-controls')).toHaveCount(0);
	await expect(restore(page)).toBeDisabled();

	await textInput(page, 'Title').fill('Edited Title');
	await expect(edit(page)).toHaveCount(0);
	await expect(save).toBeEnabled();
	await textInput(page, 'Publisher').fill('');
	await field(page, 'Tags').getByRole('textbox', { name: 'New tag', exact: true }).fill(' Space ');
	await field(page, 'Tags').getByRole('textbox', { name: 'New tag', exact: true }).press('Enter');
	await field(page, 'Genres').getByRole('button', { name: 'Remove genre: Fiction', exact: true }).click();
	await field(page, 'Moods').getByRole('textbox', { name: 'New mood', exact: true }).fill('Hopeful');
	await field(page, 'Moods').getByRole('button', { name: 'Add mood', exact: true }).click();
	await field(page, 'Age rating').getByRole('combobox').selectOption({ label: '13+' });
	await field(page, 'Content rating').getByRole('combobox').selectOption({ label: 'Teen' });
	await field(page, 'Series').getByRole('textbox', { name: 'Series total' }).fill('5');
	await expect(restore(page)).toBeEnabled();
	await save.click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	expect(patches).toEqual([{
		title: 'Edited Title', publisher: null, tags: ['Original', 'Space'], genres: [], moods: ['Hopeful'],
		age_rating: 13, content_rating: 'teen', series: { name: 'Existing Saga', index: 1.5, total: 5 }
	}]);
	await expectClean(page);
	await page.reload();
	await expect(textInput(page, 'Title')).toHaveValue('Edited Title');
	await expect(field(page, 'Tags').getByText('Space', { exact: true })).toBeVisible();
	await expect(field(page, 'Age rating').getByRole('combobox')).toHaveValue('13');
	expect(current.description).toBe('Existing description');
	expect(lookups).toBe(0);
});

test('reverted and semantically unchanged inputs keep the edit icon and do not warn on navigation', async ({ page }) => {
	await authenticate(page);
	const patches: unknown[] = [];
	await page.route('**/api/v1/books/21', (route) => {
		if (route.request().method() === 'PATCH') patches.push(route.request().postDataJSON());
		return route.fulfill({ json: { book: baseBook() } });
	});
	await page.goto('/books/21/metadata');
	await expectClean(page);
	await edit(page).click();
	await expect(textInput(page, 'Title')).toBeFocused();
	await expectClean(page);

	await textInput(page, 'Title').fill('Changed');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeEnabled();
	await textInput(page, 'Title').fill('Old Title');
	await expectClean(page);

	await textInput(page, 'Title').fill(' Old Title ');
	await textInput(page, 'Publisher').fill(' Existing Press ');
	await textInput(page, 'Pages').fill('0200');
	await field(page, 'Series').getByRole('textbox', { name: 'Series index' }).fill('1.50');
	await field(page, 'Series').getByRole('textbox', { name: 'Series total' }).fill('04');
	await textInput(page, 'ISBN-13').fill(' 9780000000001 ');
	await field(page, 'Contributors').getByRole('textbox', { name: 'Name 1', exact: true }).fill(' A Writer ');
	await expectClean(page);

	const pending = field(page, 'Tags').getByRole('textbox', { name: 'New tag', exact: true });
	await pending.fill('New tag');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeEnabled();
	await pending.fill(' ');
	await expectClean(page);
	await field(page, 'Age rating').getByRole('combobox').selectOption('13');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeEnabled();
	await field(page, 'Age rating').getByRole('combobox').selectOption('');
	await expectClean(page);
	await field(page, 'Contributors').getByRole('button', { name: 'Add contributor', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeEnabled();
	await field(page, 'Contributors').getByRole('button', { name: 'Remove contributor 2', exact: true }).click();
	await expectClean(page);

	const dialogs: string[] = [];
	page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
	await page.getByRole('navigation', { name: 'Book sections' }).getByRole('link', { name: /Files/ }).click();
	await expect(page).toHaveURL(/\/books\/21\/files$/);
	expect(dialogs).toEqual([]);
	expect(patches).toEqual([]);
});

test('restore leaves fields editable and restores pending chips and the latest saved baseline', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	const patches: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21', (route) => {
		if (route.request().method() === 'PATCH') {
			const patch = route.request().postDataJSON() as Record<string, unknown>;
			patches.push(patch);
			const tags = (patch.tags ?? current.tags.map((tag) => tag.name)) as string[];
			current = baseBook({ ...current, ...patch, tags: tags.map((name, index) => ({ id: index + 1, name })) });
		}
		return route.fulfill({ json: { book: current } });
	});
	await lookupFixture(page);
	await page.goto('/books/21/metadata');
	await textInput(page, 'Title').fill('Unsaved title');
	await textInput(page, 'Publisher').fill('');
	await field(page, 'Contributors').getByRole('textbox', { name: 'Name 1', exact: true }).fill('Unsaved writer');
	await field(page, 'Series').getByRole('textbox', { name: 'Series index' }).fill('9');
	await field(page, 'Tags').getByRole('button', { name: 'Remove tag: Original', exact: true }).click();
	const terms = [
		['Tags', 'New tag', 'Pending tag'],
		['Genres', 'New genre', 'Pending genre'],
		['Moods', 'New mood', 'Pending mood']
	] as const;
	for (const [group, name, value] of terms) {
		await field(page, group).getByRole('textbox', { name, exact: true }).fill(value);
	}
	await searchMetadata(page).click();
	await search(page);
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await metadata(page).click();
	await expect(textInput(page, 'Title')).toHaveValue('New Title');
	await expect(textInput(page, 'Title')).toBeEnabled();
	for (const [group, name, value] of terms) {
		await expect(field(page, group).getByRole('textbox', { name, exact: true })).toHaveValue(value);
	}
	await restore(page).click();
	await expect(textInput(page, 'Title')).toHaveValue('Old Title');
	await expect(textInput(page, 'Title')).toBeEnabled();
	await expect(textInput(page, 'Publisher')).toHaveValue('Existing Press');
	await expect(field(page, 'Contributors').getByRole('textbox', { name: 'Name 1', exact: true })).toHaveValue('A Writer');
	await expect(field(page, 'Series').getByRole('textbox', { name: 'Series index' })).toHaveValue('1.5');
	await expect(field(page, 'Tags').getByText('Original', { exact: true })).toBeVisible();
	await expect(field(page, 'Genres').getByText('Fiction', { exact: true })).toBeVisible();
	await expect(field(page, 'Moods').getByText('No moods', { exact: true })).toBeVisible();
	for (const [group, name] of terms) {
		await expect(field(page, group).getByRole('textbox', { name, exact: true })).toHaveValue('');
	}
	await expect(restore(page)).toBeDisabled();
	await expectClean(page);
	expect(patches).toEqual([]);

	await textInput(page, 'Title').fill('Saved baseline');
	await field(page, 'Moods').getByRole('textbox', { name: 'New mood', exact: true }).fill(' ');
	await field(page, 'Tags').getByRole('textbox', { name: 'New tag', exact: true }).fill('Saved tag');
	await field(page, 'Tags').getByRole('button', { name: 'Add tag', exact: true }).click();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expectClean(page);
	expect(patches).toEqual([{ title: 'Saved baseline', tags: ['Original', 'Saved tag'] }]);
	await textInput(page, 'Title').fill('Discard this');
	await field(page, 'Tags').getByRole('button', { name: 'Remove tag: Saved tag', exact: true }).click();
	await field(page, 'Tags').getByRole('textbox', { name: 'New tag', exact: true }).fill('Discard pending');
	await restore(page).click();
	await expect(textInput(page, 'Title')).toHaveValue('Saved baseline');
	await expect(textInput(page, 'Title')).toBeEnabled();
	await expect(field(page, 'Tags').getByText('Saved tag', { exact: true })).toBeVisible();
	await expect(field(page, 'Tags').getByRole('textbox', { name: 'New tag', exact: true })).toHaveValue('');
	await expect(restore(page)).toBeDisabled();
	await expectClean(page);
	expect(patches).toHaveLength(1);
});

test('direct edits preserve contributor roles and order, pages and identifiers', async ({ page }) => {
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
				}))
			});
		}
		return route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/metadata');
	const contributors = field(page, 'Contributors');
	await contributors.getByRole('textbox', { name: 'Name 1', exact: true }).fill('Revised Writer');
	await contributors.getByRole('combobox', { name: 'Role 1', exact: true }).selectOption('editor');
	await contributors.getByRole('button', { name: 'Add contributor', exact: true }).click();
	await contributors.getByRole('textbox', { name: 'Name 2', exact: true }).fill('A Translator');
	await contributors.getByRole('combobox', { name: 'Role 2', exact: true }).selectOption('translator');
	await contributors.getByRole('button', { name: 'Move contributor 2 up', exact: true }).click();
	await textInput(page, 'Pages').fill('321');
	await textInput(page, 'ISBN-10').fill('0000000001');
	const identifiers = field(page, 'Identifiers');
	await identifiers.getByRole('button', { name: 'Add identifier', exact: true }).click();
	await identifiers.getByRole('combobox', { name: 'Scheme 3', exact: true }).selectOption('goodreads');
	await identifiers.getByRole('textbox', { name: 'Value 3', exact: true }).fill('12345');
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	await expectClean(page);
	expect(patches).toEqual([{
		authors: [{ name: 'A Translator', role: 'translator' }, { name: 'Revised Writer', role: 'editor' }],
		page_count: 321,
		identifiers: [
			{ scheme: 'isbn13', value: '9780000000001' },
			{ scheme: 'isbn10', value: '0000000001' },
			{ scheme: 'goodreads', value: '12345' }
		]
	}]);
	await page.reload();
	await expect(contributors.getByRole('textbox', { name: 'Name 1', exact: true })).toHaveValue('A Translator');
	await expect(contributors.getByRole('combobox', { name: 'Role 2', exact: true })).toHaveValue('editor');
	await expect(textInput(page, 'ISBN-10')).toHaveValue('0000000001');
});

test('search sends the prefilled query and compares providers per field until one save', async ({ page }, testInfo) => {
	await authenticate(page);
	let current = baseBook();
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: current } }));
	await page.route('**/api/v1/admin/metadata/providers', (route) => route.fulfill({ json: { providers: [
		{ provider: 'neodb', enabled: true, priority: 2, base_url: null, has_token: false, updated_at: '2026-11-04T00:00:00Z' },
		{ provider: 'openlibrary', enabled: true, priority: 1, base_url: null, has_token: false, updated_at: '2026-11-04T00:00:00Z' },
		{ provider: 'douban', enabled: false, priority: 3, base_url: null, has_token: false, updated_at: '2026-11-04T00:00:00Z' }
	] } }));
	const bodies: unknown[] = [];
	await lookupFixture(page, bodies);
	const applies: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21/metadata/apply', async (route) => {
		applies.push(route.request().postDataJSON() as Record<string, unknown>);
		current = baseBook({ title: 'Alternative Title', publisher: 'Other Press', description: 'My description' });
		await route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/metadata');
	await textInput(page, 'Description').fill('My description');
	await searchMetadata(page).click();
	await expect(page).toHaveURL(/view=search/);
	const query = page.getByRole('form', { name: 'Search metadata' });
	await expect(query.getByRole('textbox', { name: 'ISBN' })).toHaveValue('9780000000001');
	await expect(query.getByRole('textbox', { name: 'Title' })).toHaveValue('Old Title');
	await expect(query.getByRole('textbox', { name: 'Author' })).toHaveValue('A Writer');
	await expect(query.getByRole('checkbox')).toHaveCount(2);
	await query.getByRole('checkbox', { name: 'neodb' }).uncheck();
	await query.getByRole('checkbox', { name: 'openlibrary' }).uncheck();
	await search(page);
	await expect(query.getByRole('alert')).toHaveText('Select at least one provider.');
	await query.getByRole('checkbox', { name: 'neodb' }).check();
	await query.getByRole('checkbox', { name: 'openlibrary' }).check();
	await query.getByRole('textbox', { name: 'Title' }).fill('Custom Title');
	await search(page);
	await expect(page.getByText('Found 3 candidates.')).toBeVisible();
	expect(bodies).toEqual([{ isbn: '9780000000001', title: 'Custom Title', author: 'A Writer' }]);
	await expect(page.getByRole('tab')).toHaveCount(2);
	await expect(page.getByRole('tab', { name: 'openlibrary', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByText('googlebooks could not be searched (code: provider_unavailable).')).toBeVisible();
	await expect(draft(page, 'Description')).toHaveText('My description');
	await expect(field(page, 'Title').getByText('New Title', { exact: true })).toBeVisible();
	await expect(field(page, 'Content rating').getByText('Mature', { exact: true })).toBeVisible();
	await expect(field(page, 'Ratings').locator('.found-value')).toHaveText('openlibrary: ★ 3.9 # 120');
	await page.getByRole('combobox', { name: 'Alternative', exact: true }).selectOption({ label: 'Alternative Title' });
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await expect(draft(page, 'Title')).toHaveText('Alternative Title');
	await expect(field(page, 'Title').getByText('→ openlibrary')).toBeVisible();

	await page.getByRole('tab', { name: 'neodb', exact: true }).click();
	await expect(field(page, 'Title').getByText('Other Title', { exact: true })).toBeVisible();
	await field(page, 'Publisher').getByRole('button', { name: 'Use found Publisher', exact: true }).click();
	await field(page, 'Subtitle').getByRole('button', { name: 'Use found Subtitle', exact: true }).click();
	await expect(draft(page, 'Subtitle')).toHaveText('(empty)');
	await field(page, 'Subtitle').getByRole('button', { name: 'Restore existing Subtitle', exact: true }).click();
	await expect(draft(page, 'Subtitle')).toHaveText('Old subtitle');
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({ path: testInfo.outputPath('metadata-comparison.png'), fullPage: true });

	await metadata(page).click();
	await expect(textInput(page, 'Title')).toHaveValue('Alternative Title');
	await expect(textInput(page, 'Publisher')).toHaveValue('Other Press');
	expect(applies).toHaveLength(0);
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	await expectClean(page);
	expect(applies).toEqual([{
		request_key: 'key-1',
		fields: {
			title: { provider: 'openlibrary', reference: '/works/OL2W' },
			publisher: { provider: 'neodb', reference: 'uuid-1' }
		},
		patch: { description: 'My description' }
	}]);
});

test('use all copies new fields, manual edits clear references, and restore returns saved values', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	const bodies: unknown[] = [];
	await lookupFixture(page, bodies);
	const applies: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21/metadata/apply', (route) => {
		applies.push(route.request().postDataJSON() as Record<string, unknown>);
		return route.fulfill({ json: { book: baseBook({ title: 'Handwritten Title', publisher: 'Provider Press' }) } });
	});
	await page.goto('/books/21/metadata?view=search');
	await page.getByRole('form', { name: 'Search metadata' }).getByRole('textbox', { name: 'ISBN' }).fill('');
	await page.getByRole('form', { name: 'Search metadata' }).getByRole('textbox', { name: 'Title' }).fill('');
	await search(page);
	expect(bodies).toEqual([null]);
	await page.getByRole('button', { name: 'Use all found values', exact: true }).click();
	await expect(draft(page, 'Title')).toHaveText('New Title');
	await expect(draft(page, 'Subtitle')).toHaveText('Old subtitle');
	await expect(draft(page, 'Genres')).toHaveText('Epic Fantasy');
	await expect(draft(page, 'Age rating')).toHaveText('16+');
	await expect(draft(page, 'Ratings')).toContainText('openlibrary: ★ 3.9 # 120');
	await expect(draft(page, 'Ratings')).toContainText('goodreads: ★ 4.25 # 12');
	await page.getByRole('button', { name: 'Restore all existing values', exact: true }).click();
	await expect(draft(page, 'Title')).toHaveText('Old Title');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeDisabled();
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await field(page, 'Publisher').getByRole('button', { name: 'Use found Publisher', exact: true }).click();
	await field(page, 'Ratings').getByRole('button', { name: 'Use found Ratings', exact: true }).click();
	await metadata(page).click();
	await expect(textInput(page, 'Title')).toBeEnabled();
	await textInput(page, 'Title').fill('Handwritten Title');
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	await expectClean(page);
	expect(applies).toEqual([{
		request_key: 'key-1',
		fields: {
			publisher: { provider: 'openlibrary', reference: '/works/OL1W' },
			ratings: { provider: 'openlibrary', reference: '/works/OL1W' }
		},
		patch: { title: 'Handwritten Title' }
	}]);
});

test('provider save failure retains the search draft and success returns to clean editable metadata', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: current } }));
	await lookupFixture(page);
	const applies: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21/metadata/apply', (route) => {
		applies.push(route.request().postDataJSON() as Record<string, unknown>);
		if (applies.length === 1) {
			return route.fulfill({ status: 500, json: { title: 'Internal error', status: 500 } });
		}
		current = baseBook({ title: 'Alternative Title' });
		return route.fulfill({ json: { book: current } });
	});
	await page.goto('/books/21/metadata');
	await expectClean(page);
	await searchMetadata(page).click();
	const query = page.getByRole('form', { name: 'Search metadata' });
	await query.getByRole('textbox', { name: 'Title' }).fill('Keep this query');
	await search(page);
	await page.getByRole('combobox', { name: 'Alternative', exact: true }).selectOption({ label: 'Alternative Title' });
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(tab(page).getByRole('alert')).toBeVisible();
	await expect(page).toHaveURL(/\/books\/21\/metadata\?view=search$/);
	await expect(query.getByRole('textbox', { name: 'Title' })).toHaveValue('Keep this query');
	await expect(page.getByRole('combobox', { name: 'Alternative', exact: true })).toHaveValue('/works/OL2W');
	await expect(draft(page, 'Title')).toHaveText('Alternative Title');
	await expect(field(page, 'Title').getByText('→ openlibrary')).toBeVisible();
	await expect(restore(page)).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page).toHaveURL(/\/books\/21\/metadata$/);
	await expect(query).toHaveCount(0);
	await expect(metadata(page)).toHaveCount(0);
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	await expectClean(page);
	await expect(textInput(page, 'Title')).toHaveValue('Alternative Title');
	const expected = {
		request_key: 'key-1',
		fields: { title: { provider: 'openlibrary', reference: '/works/OL2W' } }
	};
	expect(applies).toEqual([expected, expected]);
});

test('failed saves keep drafts and disable mutation while pending, and chip validation does not send a request', async ({ page }) => {
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
	await page.goto('/books/21/metadata');
	const tags = field(page, 'Tags');
	await tags.getByRole('textbox', { name: 'New tag', exact: true }).fill(' original ');
	await tags.getByRole('button', { name: 'Add tag', exact: true }).click();
	await expect(tab(page).getByRole('alert')).toContainText('Tag names must be unique');
	await field(page, 'Genres').getByRole('textbox', { name: 'New genre', exact: true }).fill('fiction');
	await field(page, 'Genres').getByRole('button', { name: 'Add genre', exact: true }).click();
	await expect(tab(page).getByRole('alert')).toHaveText('Each name can only appear once.');
	expect(patches).toHaveLength(0);
	await tags.getByRole('textbox', { name: 'New tag', exact: true }).fill('');
	await field(page, 'Genres').getByRole('textbox', { name: 'New genre', exact: true }).fill('');
	await textInput(page, 'Title').fill('Retry Title');
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeDisabled();
	await expect(restore(page)).toBeDisabled();
	await expect(searchMetadata(page)).toBeDisabled();
	await expect(textInput(page, 'Title')).toBeDisabled();
	await expect.poll(() => !!finishSave).toBe(true);
	finishSave!();
	await expect(tab(page).getByRole('alert')).toBeVisible();
	await expect(page).toHaveURL(/\/books\/21\/metadata$/);
	await expect(textInput(page, 'Title')).toHaveValue('Retry Title');
	await expect(textInput(page, 'Title')).toBeEnabled();
	await expect(restore(page)).toBeEnabled();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	await expectClean(page);
	expect(patches).toEqual([{ title: 'Retry Title' }, { title: 'Retry Title' }]);
});

test('stale candidate saves refresh results without losing manual edits or saving copied fields as manual', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: current } }));
	const bodies: unknown[] = [];
	let lookups = 0;
	await page.route('**/api/v1/books/21/metadata/candidates', (route) => {
		lookups += 1;
		bodies.push(route.request().postDataJSON());
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
	await page.goto('/books/21/metadata');
	await textInput(page, 'Description').fill('Keep my manual text');
	await searchMetadata(page).click();
	await search(page);
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(tab(page).getByRole('alert')).toContainText('expired or changed');
	await expect.poll(() => lookups).toBe(2);
	expect(bodies[1]).toEqual(bodies[0]);
	await expect(draft(page, 'Description')).toHaveText('Keep my manual text');
	await expect(draft(page, 'Title')).toHaveText('Old Title');
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(page.getByText('Metadata saved.', { exact: true })).toBeVisible();
	await expect(page).toHaveURL(/\/books\/21\/metadata$/);
	await expectClean(page);
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
	await page.goto('/books/21/metadata');
	await textInput(page, 'Description').fill('Manual text survives recovery');
	await searchMetadata(page).click();
	await search(page);
	await field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true }).click();
	await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
	await expect(tab(page).getByRole('alert')).toContainText('Saving is blocked');
	await expect(draft(page, 'Title')).toHaveText('New Title');
	await expect(draft(page, 'Description')).toHaveText('Manual text survives recovery');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeDisabled();
	expect(applies).toBe(1);
	await page.getByRole('button', { name: 'Retry refreshing existing values', exact: true }).click();
	await expect(draft(page, 'Title')).toHaveText('Latest saved title');
	await expect(draft(page, 'Description')).toHaveText('Manual text survives recovery');
	await expect(page.getByRole('button', { name: 'Save metadata', exact: true })).toBeEnabled();
	expect(lookups).toBe(2);
	expect(applies).toBe(1);
});

test('covers are previewed through the server, source tabs work with keyboard, and the views fit small screens', async ({ page }, testInfo) => {
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
	await page.goto('/books/21/metadata');
	await expectClean(page);
	const cleanAxe = await new AxeBuilder({ page }).include('.metadata-tab').analyze();
	expect(cleanAxe.violations).toEqual([]);
	await searchMetadata(page).click();
	await search(page);
	const cover = field(page, 'Cover');
	await expect(cover.getByRole('img', { name: 'Cover preview from openlibrary' })).toHaveAttribute('src', /^blob:/);
	expect(coverRequests).toEqual([{ request_key: 'key-1', provider: 'openlibrary', reference: '/works/OL1W' }]);
	expect(externalRequests).toBe(0);
	await page.getByRole('tab', { name: 'openlibrary', exact: true }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByRole('tab', { name: 'neodb', exact: true })).toBeFocused();
	await expect(page.getByRole('tab', { name: 'neodb', exact: true })).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Home');
	await expect(page.getByRole('tab', { name: 'openlibrary', exact: true })).toHaveAttribute('aria-selected', 'true');
	const searchAxe = await new AxeBuilder({ page }).include('.metadata-tab').analyze();
	expect(searchAxe.violations).toEqual([]);
	await metadata(page).click();
	await expect(textInput(page, 'Title')).toBeEnabled();
	const editAxe = await new AxeBuilder({ page }).include('.metadata-tab').analyze();
	expect(editAxe.violations).toEqual([]);
	await page.setViewportSize({ width: 390, height: 900 });
	const coverBounds = await field(page, 'Cover').boundingBox();
	const actionBounds = await form(page).locator('.cover-actions').boundingBox();
	expect(coverBounds).not.toBeNull();
	expect(actionBounds).not.toBeNull();
	expect(actionBounds!.y).toBeGreaterThanOrEqual(coverBounds!.y + coverBounds!.height);
	const dimensions = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth
	}));
	expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
	await expect(textInput(page, 'Title')).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('metadata-edit-mobile.png'), fullPage: true });
	await searchMetadata(page).click();
	await expect(field(page, 'Title').getByRole('button', { name: 'Use found Title', exact: true })).toBeVisible();
	const searchDimensions = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth
	}));
	expect(searchDimensions.content).toBeLessThanOrEqual(searchDimensions.viewport);
});

test('unsaved edits ask before leaving the metadata tab', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await page.goto('/books/21/metadata');
	await textInput(page, 'Title').fill('Unsaved');
	await searchMetadata(page).click();
	await expect(page).toHaveURL(/view=search/);
	const files = page.getByRole('navigation', { name: 'Book sections' }).getByRole('link', { name: /Files/ });
	page.once('dialog', (dialog) => dialog.dismiss());
	await files.click();
	await expect(page).toHaveURL(/\/metadata\?view=search$/);
	await metadata(page).click();
	await expect(textInput(page, 'Title')).toHaveValue('Unsaved');
	page.once('dialog', (dialog) => dialog.accept());
	await files.click();
	await expect(page).toHaveURL(/\/books\/21\/files$/);
});

test('non-administrators do not see the metadata tab and are refused by its route', async ({ page }) => {
	await authenticate(page, 'user', 'zh');
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await page.goto('/books/21');
	await expect(page.getByRole('heading', { name: 'Old Title' })).toBeVisible();
	await expect(page.getByRole('link', { name: '编辑元数据' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /元数据/ })).toHaveCount(0);
	await page.goto('/books/21/edit');
	await expect(page).toHaveURL(/\/books\/21\/metadata$/);
	await expect(tab(page).getByRole('alert')).toHaveText('只有管理员可以编辑图书元数据。');
	await expect(page.getByRole('form', { name: '图书元数据' })).toHaveCount(0);
});
