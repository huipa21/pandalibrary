import { expect, test, type Page } from '@playwright/test';

const BOOK_ID = 5;
const hash = 'a'.repeat(64);

const book = {
	id: BOOK_ID,
	library_id: 1,
	title: 'Marked Book',
	sort_title: 'Marked Book',
	subtitle: null,
	description: null,
	language: 'en',
	publisher: null,
	published_date: null,
	page_count: null,
	cover_url: null,
	cover_source: null,
	authors: [],
	series: null,
	tags: [],
	identifiers: [],
	files: [
		{ id: 50, format: 'epub', size_bytes: 2048, download_url: `/api/v1/books/${BOOK_ID}/files/50?v=${hash}` },
		{ id: 51, format: 'pdf', size_bytes: 4096, download_url: `/api/v1/books/${BOOK_ID}/files/51?v=${hash}` }
	],
	field_sources: [],
	created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z'
};

function highlight(id: string, text: string, color: string, chapter: string | null, position: number, created: string, fileId: number) {
	return {
		id, book_id: BOOK_ID, book_file_id: fileId,
		locator: fileId === 51 ? { type: 'pdf', page: 2 } : { type: 'cfi', value: 'epubcfi(/6/2!/4/2/1:0)' },
		position, text, color, chapter, created_at: created, updated_at: created, deleted_at: null, rev: 1
	};
}

function note(id: string, highlightId: string | null, body: string) {
	return {
		id, book_id: BOOK_ID, highlight_id: highlightId, body_md: body,
		created_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z', deleted_at: null, rev: 1
	};
}

// 7 live highlights across 6 chapters (one untitled), 2 with notes, 4 colours.
const highlights = [
	highlight('h1', 'It was a bright cold day in April', 'yellow', 'Chapter One', 0.05, '2026-10-29T09:00:00Z', 50),
	highlight('h2', 'The clocks were striking thirteen', 'blue', 'Chapter One', 0.08, '2026-10-29T09:05:00Z', 50),
	highlight('h3', 'Café society gathered at noon', 'red', 'Chapter Two', 0.2, '2026-10-30T09:00:00Z', 51),
	highlight('h4', 'Memory is a strange garden', 'green', 'Chapter Three', 0.35, '2026-11-02T09:00:00Z', 50),
	highlight('h5', 'Silence fell over the square', 'yellow', 'Chapter Four', 0.5, '2026-11-03T09:00:00Z', 50),
	highlight('h6', 'Nothing was your own except a few centimetres', 'blue', 'Chapter Five', 0.7, '2026-11-04T09:00:00Z', 99),
	highlight('h7', 'Epilogue words linger', 'yellow', null, 0.9, '2026-11-05T09:00:00Z', 50),
	{ ...highlight('gone', 'Deleted highlight text', 'red', 'Chapter Six', 0.95, '2026-11-05T09:00:00Z', 50), deleted_at: '2026-11-06T00:00:00Z' }
];
const notes = [
	note('n1', 'h1', 'A **strong** opening<script>window.__noteAttack = true</script>'),
	note('n4', 'h4', 'Compare with *Proust*'),
	note('book', null, 'Private book note')
];
const textInsert = {
	id: 'text', book_id: BOOK_ID, book_file_id: 51, kind: 'text',
	locator: { type: 'pdf', page: 2, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
	position: 0.5, data: { text: 'Inserted 中文', color: '#112233', size: 0.02 },
	created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', deleted_at: null, rev: 1
};

async function mockApi(page: Page, state: { highlights: unknown[]; notes: unknown[]; page_annotations?: unknown[] } = { highlights, notes }) {
	const exports: string[] = [];
	await page.route('**/api/v1/**', (route) =>
		route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not Found', status: 404 }) })
	);
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' } } })
	);
	await page.route('**/api/v1/shelves**', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route(`**/api/v1/books/${BOOK_ID}`, (route) => route.fulfill({ json: { book } }));
	await page.route(`**/api/v1/books/${BOOK_ID}/reviews?*`, (route) => route.fulfill({ json: {
		mine: null, items: [], next_cursor: null, total: 0
	} }));
	await page.route(`**/api/v1/me/books/${BOOK_ID}`, (route) => route.fulfill({ json: {
		user_book: null, progress: null, bookmarks: [], highlights: state.highlights, notes: state.notes, page_annotations: state.page_annotations ?? []
	} }));
	await page.route('**/api/v1/me/notes/export?*', (route) => {
		exports.push(route.request().url());
		return route.fulfill({
			status: 200,
			headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="Marked Book.md"' },
			body: '# Marked Book\n'
		});
	});
	return { exports };
}

const list = (page: Page) => page.getByRole('region', { name: 'Highlights by chapter' });
const items = (page: Page) => list(page).getByRole('listitem');
const overview = (page: Page) => page.getByRole('complementary');

async function open(page: Page, search = '') {
	await page.goto(`/books/${BOOK_ID}/highlights${search}`);
	await expect(list(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
});

test('style badges and filters distinguish legacy, underline and strikeout marks and show inserted text', async ({ page }) => {
	await mockApi(page, {
		highlights: [highlights[0], { ...highlights[1], style: 'underline' }, { ...highlights[2], style: 'strikeout' }],
		notes: [],
		page_annotations: [textInsert]
	});
	await open(page);
	await expect(items(page).nth(1).getByText('Underline', { exact: true })).toBeVisible();
	await expect(items(page).nth(2).getByText('Strikeout', { exact: true })).toBeVisible();
	await expect(page.getByRole('list', { name: 'Annotations', exact: true })).toContainText('Inserted 中文');
	await page.getByRole('button', { name: 'Filters', exact: true }).click();
	await page.getByRole('checkbox', { name: 'Underline', exact: true }).check();
	await expect(items(page)).toHaveCount(1);
	await expect(items(page).first()).toContainText('The clocks were striking thirteen');
	await page.getByRole('checkbox', { name: 'Underline', exact: true }).uncheck();
	await page.getByRole('checkbox', { name: 'Highlight', exact: true }).check();
	await expect(items(page)).toHaveCount(1);
	await expect(items(page).first()).toContainText('It was a bright cold day');
});

test('hex colours use their swatches, preset labels and palette-ordered filters', async ({ page }) => {
	await mockApi(page, {
		highlights: [
			highlights[0],
			{ ...highlights[1], color: '#FACC15' },
			{ ...highlights[2], color: '#f87171' },
			{ ...highlights[3], color: '#abcdef' },
			{ ...highlights[4], color: '#123456' }
		],
		notes: []
	});
	await open(page);
	const custom = list(page).locator('[data-highlight-id="h4"] div[aria-hidden="true"]').first();
	await expect(custom).toHaveCSS('background-color', 'rgb(171, 205, 239)');
	await page.getByRole('button', { name: 'Filters', exact: true }).click();
	const colors = page.locator('fieldset').filter({ has: page.getByText('Colour', { exact: true }) });
	await expect(colors.locator('label')).toHaveText(['Yellow (2)', 'Red (1)', '#123456 (1)', '#abcdef (1)']);
	await colors.getByRole('checkbox', { name: 'Yellow (2)' }).check();
	await expect(items(page)).toHaveCount(2);
	await colors.getByRole('checkbox', { name: '#abcdef (1)' }).check();
	await expect(items(page)).toHaveCount(3);
	await expect(items(page).last()).toContainText('Memory is a strange garden');
});

test('invalid stored colours use the yellow display fallback without changing their filter label', async ({ page }) => {
	await mockApi(page, { highlights: [{ ...highlights[0], color: 'teal' }], notes: [] });
	await open(page);
	const swatch = list(page).locator('[data-highlight-id="h1"] div[aria-hidden="true"]').first();
	await expect(swatch).toHaveCSS('background-color', 'rgb(250, 204, 21)');
	await page.getByRole('button', { name: 'Filters', exact: true }).click();
	await expect(page.getByRole('checkbox', { name: 'teal (1)' })).toBeVisible();
});

test('inserted text remains visible and exportable without any highlights', async ({ page }) => {
	const { exports } = await mockApi(page, { highlights: [], notes: [], page_annotations: [textInsert] });
	await page.goto(`/books/${BOOK_ID}/highlights`);
	await expect(page.getByRole('list', { name: 'Annotations', exact: true })).toContainText('Inserted 中文');
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	await expect.poll(() => exports.length).toBe(1);
});
test('groups highlights by chapter with counts, notes and a summary', async ({ page }) => {
	await mockApi(page);
	await open(page);
	await expect(overview(page).getByRole('heading', { name: '7 marks · 6 chapters' })).toBeVisible();
	const headings = list(page).getByRole('heading', { level: 2 });
	await expect(headings).toHaveCount(6);
	await expect(headings.first()).toHaveAccessibleName('Chapter One (2 highlights)');
	await expect(headings.last()).toHaveAccessibleName('Untitled section (1 highlights)');
	await expect(items(page)).toHaveCount(7);
	await expect(items(page).first()).toContainText('It was a bright cold day in April');
	await expect(page.getByText('Deleted highlight text')).toHaveCount(0);
	await expect(page.getByText('Private book note')).toHaveCount(0);
	const firstNote = items(page).first().locator('.reader-markdown');
	await expect(firstNote.locator('strong')).toHaveText('strong');
	await expect(firstNote.locator('script')).toHaveCount(0);
	expect(await page.evaluate(() => (window as Window & { __noteAttack?: boolean }).__noteAttack)).toBeUndefined();
	await expect(overview(page).getByText('Busiest week')).toBeVisible();
	await expect(overview(page).getByText('EPUB')).toBeVisible();
	await expect(overview(page).getByText('PDF')).toBeVisible();
	await expect(overview(page).getByText('Unknown')).toBeVisible();
	await expect(overview(page).getByRole('img', { name: /Annotations per week/ }).locator('rect')).toHaveCount(52);
});

test('search narrows the list, marks matches and syncs ?q=', async ({ page }) => {
	await mockApi(page);
	await open(page);
	await page.getByRole('searchbox', { name: 'Search annotations' }).fill('cafe');
	await expect(page).toHaveURL(/[?&]q=cafe/);
	await expect(items(page)).toHaveCount(1);
	await expect(items(page).first().locator('mark')).toHaveText('Café');
	await expect(page.getByText('Showing 1 of 7')).toBeVisible();
	await page.getByRole('searchbox', { name: 'Search annotations' }).fill('proust');
	await expect(items(page)).toHaveCount(1);
	await expect(items(page).first()).toContainText('Memory is a strange garden');
	await page.getByRole('searchbox', { name: 'Search annotations' }).fill('zzz');
	await expect(page.getByText('No annotations match these filters')).toBeVisible();
	await page.getByRole('button', { name: 'Clear filters' }).click();
	await expect(items(page)).toHaveCount(7);
	await expect(page).not.toHaveURL(/[?&]q=/);
	await expect(page.getByRole('searchbox', { name: 'Search annotations' })).toHaveValue('');
});

test('the Notes toggle shows only highlights with notes', async ({ page }) => {
	await mockApi(page);
	await open(page);
	const toggle = page.getByRole('button', { name: 'Notes 2' });
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(items(page)).toHaveCount(2);
	await toggle.click();
	await expect(items(page)).toHaveCount(7);
});

test('colour chips in the sidebar and the filters popover filter by colour', async ({ page }) => {
	await mockApi(page);
	await open(page);
	const red = overview(page).getByRole('button', { name: 'Filter by Red, 1 highlights' });
	await red.click();
	await expect(red).toHaveAttribute('aria-pressed', 'true');
	await expect(items(page)).toHaveCount(1);
	await expect(items(page).first()).toContainText('Café society');
	await page.getByRole('button', { name: 'Filters (1 active)' }).click();
	await page.getByRole('checkbox', { name: 'Yellow (3)' }).check();
	await expect(items(page)).toHaveCount(4);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('checkbox', { name: 'Yellow (3)' })).toHaveCount(0);
	await red.click();
	await expect(items(page)).toHaveCount(3);
});

test('changing the sort reorders highlights and syncs ?sort=', async ({ page }) => {
	await mockApi(page);
	await open(page);
	await page.getByRole('combobox', { name: 'Sort annotations' }).selectOption('newest');
	await expect(page).toHaveURL(/[?&]sort=newest/);
	await expect(items(page).first()).toContainText('Epilogue words linger');
	await page.getByRole('combobox', { name: 'Sort annotations' }).selectOption('oldest');
	await expect(items(page).first()).toContainText('It was a bright cold day in April');
	await page.reload();
	await expect(page.getByRole('combobox', { name: 'Sort annotations' })).toHaveValue('oldest');
});

test('the compact toggle clamps text and persists after reload', async ({ page }) => {
	await mockApi(page);
	await open(page);
	const compact = page.getByRole('button', { name: 'Compact view' });
	await expect(compact).toHaveAttribute('aria-pressed', 'false');
	await compact.click();
	await expect(compact).toHaveAttribute('aria-pressed', 'true');
	await expect(items(page).first().getByTestId('highlight-text')).toHaveClass(/line-clamp-2/);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Compact view' })).toHaveAttribute('aria-pressed', 'true');
	await expect(items(page).first().getByTestId('highlight-text')).toHaveClass(/line-clamp-2/);
});

test('a chapter button scrolls to its group', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 500 });
	await mockApi(page);
	await open(page);
	const target = list(page).getByRole('heading', { name: /^Untitled section/ });
	await expect(target).not.toBeInViewport();
	await overview(page).getByRole('button', { name: 'Jump to Untitled section, 1 highlights' }).click();
	await expect(target).toBeInViewport();
	await expect(target).toBeFocused();
});

test('Export downloads this book through the notes export', async ({ page }) => {
	const { exports } = await mockApi(page);
	await open(page);
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export' }).click();
	expect((await download).suggestedFilename()).toBe('Marked Book.md');
	expect(exports).toHaveLength(1);
	expect(new URL(exports[0]).pathname).toBe('/api/v1/me/notes/export');
	expect(new URL(exports[0]).searchParams.get('book_ids')).toBe(String(BOOK_ID));
	await expect(page.getByText('Downloaded Marked Book.md')).toBeVisible();
});

test('Open links to the reader with ?highlight= and is hidden for missing files', async ({ page }) => {
	await mockApi(page);
	await open(page);
	const first = items(page).filter({ hasText: 'It was a bright cold day' });
	await expect(first.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/read/${BOOK_ID}/50?highlight=h1`);
	await expect(items(page).filter({ hasText: 'Café society' }).getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/read/${BOOK_ID}/51?highlight=h3`);
	await expect(items(page).filter({ hasText: 'Nothing was your own' }).getByRole('link', { name: 'Open' })).toHaveCount(0);
	await first.getByRole('link', { name: 'Open' }).click();
	await expect(page).toHaveURL(new RegExp(`/read/${BOOK_ID}/50\\?highlight=h1$`));
});

test('a book without annotations shows the empty state', async ({ page }) => {
	await mockApi(page, { highlights: [], notes: [] });
	await page.goto(`/books/${BOOK_ID}/highlights`);
	await expect(page.getByText('No annotations yet – your annotations for this book appear here')).toBeVisible();
	await expect(page.getByRole('searchbox', { name: 'Search annotations' })).toHaveCount(0);
});

test('Annotations includes every type for this book and shares the sidebar type filter', async ({ page }) => {
	const inserted = (id: string, kind: string, data: unknown, extra = {}) => ({ ...textInsert, id, kind, data, ...extra });
	await mockApi(page, {
		highlights: [
			highlights[0], { ...highlights[1], style: 'underline' }, { ...highlights[2], style: 'strikeout' },
			{ ...highlights[3], book_id: 999, text: 'Other book highlight' }, highlights[7]
		],
		notes,
		page_annotations: [
			textInsert,
			inserted('ink', 'ink', { color: '#112233', width: 0.01, strokes: [[0.1, 0.1, 0.2, 0.2]] }),
			inserted('image', 'image', { asset: hash, media_type: 'image/png', width: 100, height: 100 }),
			inserted('deleted', 'text', { ...textInsert.data, text: 'Deleted insert' }, { deleted_at: '2026-11-02T00:00:00Z' }),
			inserted('foreign', 'text', { ...textInsert.data, text: 'Other book insert' }, { book_id: 999 })
		]
	});
	await page.route(`**/api/v1/books/${BOOK_ID}/reviews?*`, (route) => route.fulfill({ json: {
		mine: { id: 1, book_id: BOOK_ID, body: 'My review', created_at: textInsert.created_at },
		items: [{ id: 2, book_id: BOOK_ID, body: 'Another reader review' }], next_cursor: null, total: 2
	} }));
	await open(page);
	await expect(page.getByRole('navigation', { name: 'Book sections' }).getByRole('link', { name: 'Annotations', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByText('Private book note')).toHaveCount(0);
	await expect(page.getByText('My review', { exact: true })).toBeVisible();
	await expect(page.getByText('Another reader review')).toHaveCount(0);
	await expect(page.getByText('Other book insert')).toHaveCount(0);
	await expect(page.getByText('Other book highlight')).toHaveCount(0);
	await expect(page.getByText('Deleted highlight text')).toHaveCount(0);
	await expect(page.getByText('Deleted insert')).toHaveCount(0);
	const type = page.getByRole('combobox', { name: 'Annotation type' });
	await expect(type.locator('option')).toHaveCount(9);
	await expect(type.getByRole('option', { name: 'Private note' })).toHaveCount(0);
	for (const kind of ['review', 'text', 'ink', 'image']) {
		await type.selectOption(kind);
		await expect(page).toHaveURL(new RegExp(`kind=${kind}`));
		await expect(items(page)).toHaveCount(0);
		await expect(page.getByRole('list', { name: 'Annotations', exact: true }).getByRole('listitem')).toHaveCount(1);
	}
	await expect(page.getByRole('list', { name: 'Annotations', exact: true }).getByRole('link')).toHaveAttribute('href', `/read/${BOOK_ID}/51?annotation=image`);
	await type.selectOption('comment');
	await expect(items(page)).toHaveCount(1);
	await expect(items(page).first()).toContainText('strong');
	await expect(page.getByRole('list', { name: 'Annotations', exact: true })).toContainText('Compare with');
	await type.selectOption('text');
	await page.getByRole('searchbox', { name: 'Search annotations' }).fill('absent');
	await expect(page.getByText('No annotations match these filters')).toBeVisible();
	await page.getByRole('button', { name: 'Clear filters' }).click();
	await expect(type).toHaveValue('');
	await expect(page.getByText('My review', { exact: true })).toBeVisible();
});

test('review failures do not hide reader annotations and can be retried', async ({ page }) => {
	await mockApi(page);
	let failed = true;
	await page.route(`**/api/v1/books/${BOOK_ID}/reviews?*`, (route) => failed
		? route.fulfill({ status: 503, json: { title: 'Unavailable', status: 503 } })
		: route.fulfill({ json: { mine: null, items: [], next_cursor: null, total: 0 } }));
	await open(page);
	await expect(items(page)).toHaveCount(7);
	await expect(page.getByRole('alert')).toContainText('Could not load your review');
	failed = false;
	await page.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(items(page)).toHaveCount(7);
});

test('non-highlight annotations are visible on their own with accurate totals', async ({ page }) => {
	await mockApi(page, {
		highlights: [], notes: [note('book', null, 'A private note without highlights')],
		page_annotations: [{
			...textInsert, id: 'only-drawing', kind: 'ink',
			data: { color: '#112233', width: 0.01, strokes: [[0.1, 0.1, 0.2, 0.2]] }
		}]
	});
	await page.goto(`/books/${BOOK_ID}/highlights`);
	await expect(page.getByText('A private note without highlights')).toHaveCount(0);
	await expect(page.getByRole('img', { name: 'Drawing', exact: true })).toBeVisible();
	await expect(overview(page).getByRole('heading', { name: '1 marks · 0 chapters' })).toBeVisible();
	await expect(page.getByText('No annotations yet', { exact: false })).toHaveCount(0);
});
