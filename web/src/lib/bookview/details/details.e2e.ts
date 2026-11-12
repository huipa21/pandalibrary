import { expect, test, type Page } from '@playwright/test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { Book } from '#lib/catalog/types.js';
import type { Note, Progress } from '#lib/reader/types.js';
import type { Shelf } from '#lib/shelves/types.js';
import type { UserBook } from '../user-book.js';

type CapturedMutation = {
	entity: string;
	id?: string;
	key?: string;
	op: string;
	data: Record<string, unknown>;
	updated_at: number;
};

const stamp = '2026-11-06T10:00:00Z';
const book: Book = {
	id: 21, library_id: 1, title: 'The Emerald Library', sort_title: 'The Emerald Library',
	subtitle: 'A reader’s journey', description: Array.from({ length: 10 }, (_, i) => `Synopsis line ${i + 1}`).join('\n'),
	language: 'en', publisher: 'Panda Press', published_date: '2024-01-02', page_count: 320,
	cover_url: null, cover_source: 'Imported',
	authors: [
		{ id: 4, name: 'A Writer', role: 'author', position: 0 },
		{ id: 5, name: 'A Translator', role: 'translator', position: 1 }
	],
	series: { id: 8, name: 'The Reading Series', index: 2 },
	tags: [{ id: 9, name: 'Fantasy' }],
	identifiers: [{ scheme: 'isbn13', value: '9781234567890' }],
	files: [
		{ id: 31, format: 'epub', size_bytes: 4096, download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}`, original_filename: 'library.epub', created_at: stamp },
		{ id: 32, format: 'pdf', size_bytes: 8192, download_url: `/api/v1/books/21/files/32?v=${'b'.repeat(64)}`, original_filename: 'library.pdf', created_at: stamp }
	],
	field_sources: [{ field: 'title', source: 'import', source_ref: 'fixture', chosen_by: null, chosen_at: stamp }],
	created_at: stamp, updated_at: stamp
};

function relatedBook(id: number, title: string, index: number): Book {
	return {
		...book, id, title, sort_title: title, subtitle: null, description: null,
		series: { id: 8, name: 'The Reading Series', index }, identifiers: [], field_sources: [],
		files: [{ ...book.files[0], id: id * 10, download_url: `/api/v1/books/${id}/files/${id * 10}?v=${'a'.repeat(64)}` }]
	};
}

const authorBook = relatedBook(22, 'Another by the Author', 1);
const seriesBook = relatedBook(23, 'Earlier in the Series', 1);
const tagBook = relatedBook(24, 'A Similar Tale', 3);

const shelf = (id: number, name: string, extra: Partial<Shelf> = {}): Shelf => ({
	id, name, kind: 'private', owner_id: 1, created_by: 1, description: null,
	visible_book_count: 1, mode: 'manual', system_key: null, created_at: stamp, updated_at: stamp, ...extra
});
const shelves = [
	shelf(41, 'My shelf'),
	shelf(42, 'Shared shelf', { kind: 'shared', owner_id: null, created_by: 2 }),
	shelf(43, 'Owned shelf')
];

function timestamp(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== 'number') throw new TypeError('Expected a timestamp.');
	return new Date(value).toISOString();
}

function statusValue(value: unknown): UserBook['status'] {
	switch (value) {
		case 'unread':
		case 'want_to_read':
		case 'reading':
		case 'on_hold':
		case 'rereading':
		case 'finished':
		case 'skimmed':
		case 'abandoned':
			return value;
		default:
			throw new TypeError('Invalid user book status.');
	}
}

async function setup(page: Page, role = 'user', locale: 'en' | 'zh' = 'en') {
	const state: {
		book: Book;
		online: boolean;
		userBook: UserBook | null;
		progress: Progress;
		notes: Note[];
		mutations: CapturedMutation[];
		rejectNext: boolean;
		shelfAdds: number;
		members: number[];
		shelfDeletes: string[];
		failShelfDelete: boolean;
	} = {
		book,
		online: true,
		userBook: { status: 'reading', rating: 6, started_at: null, finished_at: null, updated_at: stamp, rev: 1 },
		progress: { book_file_id: 31, source: 'web', locator: null, percentage: 0.21, device: 'Web', device_id: 'device', updated_at: stamp, rev: 1 },
		notes: [],
		mutations: [],
		rejectNext: false,
		shelfAdds: 0,
		members: [42, 43],
		shelfDeletes: [],
		failShelfDelete: false
	};
	let rev = 1;
	await page.route('**/api/v1/**', async (route) => {
		if (!state.online) return route.abort('internetdisconnected');
		const url = new URL(route.request().url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: { id: 1, username: role, display_name: role, role, locale } } });
		if (path === '/sync/pull') return route.fulfill({ json: { cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: [] } });
		if (path === '/sync/push') {
			const { mutations } = route.request().postDataJSON() as { mutations: CapturedMutation[] };
			state.mutations.push(...mutations);
			if (state.rejectNext) {
				state.rejectNext = false;
				return route.fulfill({ json: { results: mutations.map((_, index) => ({ index, status: 'rejected', reason: 'invalid' })) } });
			}
			for (const mutation of mutations) {
				rev += 1;
				const updated = new Date(mutation.updated_at).toISOString();
				if (mutation.entity === 'user_books') {
					const { status, rating, started_at, finished_at } = mutation.data;
					if (rating !== null && typeof rating !== 'number') {
						throw new TypeError('Invalid user book mutation.');
					}
					state.userBook = {
						status: statusValue(status), rating, started_at: timestamp(started_at),
						finished_at: timestamp(finished_at), updated_at: updated, rev
					};
				} else if (mutation.entity === 'notes') {
					const id = mutation.id;
					if (!id) throw new TypeError('Missing note ID.');
					const existing = state.notes.find((note) => note.id === id);
					state.notes = state.notes.filter((note) => note.id !== id);
					if (mutation.op !== 'delete') {
						if (typeof mutation.data.body_md !== 'string') throw new TypeError('Missing note body.');
						state.notes.push({
							id, book_id: 21, highlight_id: null, body_md: mutation.data.body_md,
							created_at: existing?.created_at ?? updated, updated_at: updated, deleted_at: null, rev
						});
					}
				}
			}
			return route.fulfill({ json: { results: mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		if (path === '/books/21') return route.fulfill({ json: { book: state.book } });
		if (path === '/books/21/files/31') return route.fulfill({ contentType: 'application/epub+zip', body: 'book fixture' });
		if (path === '/books') {
			const items = url.searchParams.has('author_id') ? [state.book, authorBook]
				: url.searchParams.has('series_id') ? [state.book, seriesBook]
					: url.searchParams.has('tag_id') ? [seriesBook, tagBook] : [state.book];
			return route.fulfill({ json: { items, next_cursor: null } });
		}
		if (path === '/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Fiction', slug: 'fiction', created_at: stamp, updated_at: stamp } } });
		if (path.startsWith('/shelves/system/')) return route.fulfill({ json: { shelf: null } });
		const membership = /^\/shelves\/(\d+)\/books\/21$/.exec(path);
		if (membership && route.request().method() === 'PUT') {
			state.shelfAdds += 1;
			state.members.push(Number(membership[1]));
			return route.fulfill({ json: { saved: true } });
		}
		if (membership && route.request().method() === 'DELETE') {
			state.shelfDeletes.push(path);
			if (state.failShelfDelete) return route.fulfill({ status: 500, json: { title: 'Failed', status: 500 } });
			state.members = state.members.filter((id) => id !== Number(membership[1]));
			return route.fulfill({ json: { removed: true } });
		}
		if (path === '/shelves') return route.fulfill({ json: { items: shelves, next_cursor: null } });
		if (path === '/books/21/shelves') {
			return route.fulfill({ json: { shelves: shelves.filter((shelf) => state.members.includes(shelf.id)) } });
		}
		if (path === '/books/21/reviews') return route.fulfill({ json: { mine: null, items: [], next_cursor: null, total: 0 } });
		if (path === '/me/books/21') return route.fulfill({ json: { user_book: state.userBook, progress: state.progress, highlights: [], bookmarks: [], notes: state.notes } });
		return route.fulfill({ status: 404, json: { title: 'Unknown fixture endpoint', status: 404 } });
	});
	return state;
}

test('renders details, reading statistics, editions and related books responsively', async ({ page }) => {
	const state = await setup(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/books/21');
	const title = page.getByRole('heading', { name: 'The Emerald Library' });
	await expect(title).toBeVisible();
	await expect(title.locator('..').getByText('A reader’s journey')).toBeVisible();
	await expect(page.getByRole('link', { name: 'A Writer', exact: true })).toBeVisible();
	await expect(page.getByText('(Translator)')).toBeVisible();
	await expect(page.getByRole('link', { name: 'The Reading Series', exact: true }).first()).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Reviews', exact: true })).toContainText('No reviews yet. Be the first to write one.');
	await expect(page.getByRole('button', { name: 'Show more' })).toBeVisible();
	await page.getByRole('button', { name: 'Show more' }).click();
	await expect(page.getByText('Synopsis line 10')).toBeVisible();

	await expect(page.getByRole('heading', { name: 'Synopsis' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Your reading' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Back to library' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Personal review' })).toHaveCount(0);
	await expect(page.getByText('Metadata sources', { exact: true })).toHaveCount(0);
	await expect(page.getByText(/^Cover source: /)).toHaveCount(0);
	await expect(page.getByRole('main').getByRole('heading', { name: 'Shelves', exact: true })).toHaveCount(0);
	await expect(page.getByRole('combobox', { name: 'Shelf', exact: true })).toHaveCount(0);
	await expect(page.locator('#book-shelf')).toHaveCount(0);
	await expect(page.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '21');
	await expect(page.getByRole('link', { name: 'Files on disk: 2' })).toHaveAttribute('href', '/books/21/files');
	await expect(page.getByText('Panda Press')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Fiction', exact: true })).toHaveAttribute('href', '/library/1');
	await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', book.files[0].download_url);
	await page.getByLabel('Choose a download format').click();
	await expect(page.getByRole('link', { name: 'Download PDF' }).first()).toHaveAttribute('href', book.files[1].download_url);
	await page.getByLabel('Choose a download format').click();
	const relatedRegion = page.getByRole('region', { name: 'Related books' });
	await expect(relatedRegion.getByTitle('Another by the Author', { exact: true })).toHaveAttribute('href', '/books/22');
	const related = relatedRegion.getByRole('list');
	const relatedCover = related.locator(':scope > li .book-cover').first();
	const relatedGeometry = await relatedCover.evaluate((element) => ({
		width: element.getBoundingClientRect().width,
		standard: Number.parseFloat(getComputedStyle(element).getPropertyValue('--spacing-book')) *
			Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
	}));
	expect(relatedGeometry.standard).toBe(208);
	expect(relatedGeometry.width).toBe(relatedGeometry.standard);
	await expect(related).toHaveCSS('padding-top', '4px');
	await page.getByRole('button', { name: 'Similar books' }).click();
	await expect(relatedRegion.getByTitle('Earlier in the Series', { exact: true })).toHaveAttribute('href', '/books/23');
	await expect(relatedRegion.getByTitle('A Similar Tale', { exact: true })).toHaveAttribute('href', '/books/24');
	await expect(page.getByRole('heading', { name: 'Identifiers' })).toBeVisible();
	// Per-file read and offline actions live on the Files tab (BV7), not in Details.
	await expect(page.getByRole('heading', { name: 'Available formats' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Download for offline' })).toHaveCount(0);

	for (const width of [1440, 1024, 768, 390, 360]) {
		await page.setViewportSize({ width, height: 900 });
		const dimensions = await page.evaluate(() => ({
			viewport: document.documentElement.clientWidth,
			content: document.documentElement.scrollWidth
		}));
		expect(dimensions.content, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewport);
		await expect(title).toBeVisible();
		const cover = await page.getByRole('img', { name: 'The Emerald Library', exact: true }).boundingBox();
		const hero = await title.boundingBox();
		const panel = await page.getByRole('heading', { name: 'Details', exact: true }).boundingBox();
		const overview = await page.getByRole('region', { name: 'Overview', exact: true }).boundingBox();
		const reviews = await page.getByRole('region', { name: 'Reviews', exact: true }).boundingBox();
		if (!cover || !hero || !panel || !overview || !reviews) throw new Error(`Missing details layout at ${width}px.`);
		expect(reviews.y).toBeGreaterThan(overview.y + overview.height);
		expect(Math.abs(reviews.x - overview.x)).toBeLessThan(1);
		expect(reviews.width).toBeGreaterThan(Math.min(width - 64, 280));
		if (width >= 1280) {
			expect(hero.x).toBeGreaterThan(cover.x + cover.width);
			expect(overview.x).toBeGreaterThan(cover.x + cover.width);
			expect(panel.x).toBeGreaterThan(hero.x);
			expect(Math.abs(panel.y - hero.y)).toBeLessThan(80);
		} else if (width >= 768) {
			expect(hero.x).toBeGreaterThan(cover.x + cover.width);
			expect(overview.x).toBeGreaterThan(cover.x + cover.width);
			expect(panel.y).toBeGreaterThan(cover.y + cover.height);
		} else {
			expect(hero.y).toBeGreaterThan(cover.y + cover.height);
			expect(panel.y).toBeGreaterThan(hero.y);
		}
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	const tags = page.getByRole('list', { name: 'Shelves', exact: true });
	await expect(tags.getByRole('link')).toHaveText(['Owned shelf', 'Shared shelf']);
	const trigger = page.getByRole('button', { name: 'Add to shelf', exact: true });
	await trigger.click();
	const picker = page.getByRole('dialog', { name: 'Add to shelf' });
	const option = picker.getByRole('button', { name: /My shelf/ });
	await expect(option).toBeVisible();
	await expect(picker.getByRole('button', { name: /Owned shelf/ })).toHaveAttribute('aria-disabled', 'true');
	const triggerBox = await trigger.boundingBox();
	const pickerBox = await picker.boundingBox();
	if (!triggerBox || !pickerBox) throw new Error('Missing shelf picker.');
	expect(pickerBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height);
	await option.click();
	await expect(picker).toHaveCount(0);
	await expect(tags.getByRole('link')).toHaveText(['My shelf', 'Owned shelf', 'Shared shelf']);
	expect(state.shelfAdds).toBe(1);
});

test('shows a borderless hero status without duplicate format chips or review link', async ({ page }, testInfo) => {
	await setup(page);
	await page.goto('/books/21');
	const hero = page.locator('header').filter({ has: page.getByRole('heading', { name: book.title, exact: true }) });
	const trigger = hero.getByRole('button', { name: 'Reading status: Reading', exact: true });
	await expect(trigger).toBeVisible();
	await expect(hero.getByText(/^(PDF|EPUB)$/)).toHaveCount(0);
	await expect(hero.getByRole('link', { name: 'Personal review', exact: true })).toHaveCount(0);
	await expect(hero.getByRole('link', { name: /Open Library:/ })).toBeVisible();
	await expect(page.locator('.book-cover').first().getByText('EPUB', { exact: true })).toBeVisible();

	for (const theme of ['light', 'dark']) {
		await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
		for (const width of [360, 768, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await page.evaluate(() => window.scrollTo(0, 0));
			await page.mouse.move(0, 0);
			await expect(trigger).toHaveCSS('border-top-width', '0px');
			await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(trigger).toHaveCSS('box-shadow', 'none');
			await expect(trigger.locator('[data-status-icon]')).toHaveCSS('width', '16px');
			const stars = await hero.getByRole('radiogroup').boundingBox();
			const statusIcon = await trigger.locator('[data-status-icon]').boundingBox();
			if (!stars || !statusIcon) throw new Error('Missing hero rating or status icon.');
			expect(Math.abs(stars.y + stars.height / 2 - statusIcon.y - statusIcon.height / 2)).toBeLessThanOrEqual(2);
			const screenshot = testInfo.outputPath(`bd4-hero-${theme}-${width}.png`);
			await hero.screenshot({ path: screenshot });
			await testInfo.attach(`Hero ${theme} ${width}px`, { path: screenshot, contentType: 'image/png' });
		}
		if (theme === 'dark') {
			await expect(trigger).toHaveCSS('color', 'rgb(223, 226, 230)');
			await expect(trigger.locator('svg').last()).toHaveCSS('color', 'rgb(160, 167, 175)');
		}
	}
});

test('opens the inline status with the keyboard and updates it optimistically', async ({ page }) => {
	const state = await setup(page);
	if (!state.userBook) throw new Error('Expected the fixture user book.');
	state.userBook.status = 'unread';
	await page.goto('/books/21');
	const hero = page.locator('header').filter({ has: page.getByRole('heading', { name: book.title, exact: true }) });
	const trigger = hero.getByRole('button', { name: /Reading status:/ });
	const chevron = trigger.locator('svg').last();
	await trigger.focus();
	await expect(trigger).toHaveCSS('outline-width', '2px');
	await trigger.press('Enter');
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('menuitemradio', { name: 'Unread', exact: true })).toBeFocused();
	await expect(chevron).toHaveCSS('rotate', '180deg');
	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');

	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(chevron).toHaveCSS('transition-property', 'none');
	await trigger.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: 'Unread', exact: true })).toBeFocused();
	await expect(page.getByRole('menuitemradio', { name: 'Want to read', exact: true })).toHaveCount(0);
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('menuitemradio', { name: 'Reading', exact: true })).toBeFocused();
	const pending = Promise.withResolvers<void>();
	await page.route('**/api/v1/sync/push', async (route) => {
		await pending.promise;
		await route.fallback();
	});
	try {
		await page.keyboard.press('Enter');
		await expect(trigger).toHaveAccessibleName('Reading status: Reading');
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		expect(state.mutations).toHaveLength(0);
	} finally {
		pending.resolve();
	}
	await expect.poll(() => state.userBook?.status).toBe('reading');
	await expect(trigger).toHaveAttribute('aria-busy', 'false');

	await page.setViewportSize({ width: 360, height: 600 });
	await trigger.evaluate((element) => element.scrollIntoView({ block: 'end' }));
	await trigger.press('ArrowDown');
	const menu = await page.getByRole('menu', { name: 'Reading status', exact: true }).boundingBox();
	const button = await trigger.boundingBox();
	if (!menu || !button) throw new Error('Missing status menu or trigger.');
	expect(menu.x).toBeGreaterThanOrEqual(8);
	expect(menu.x + menu.width).toBeLessThanOrEqual(352);
	expect(menu.y + menu.height).toBeLessThanOrEqual(button.y);
	await page.keyboard.press('Escape');
});

test('reports a library load failure without the removed back-to-library link', async ({ page }) => {
	await setup(page);
	await page.route('**/api/v1/libraries/1', (route) =>
		route.fulfill({ status: 503, json: { title: 'Unavailable', status: 503 } })
	);
	await page.goto('/books/21');
	await expect(page.getByText('Could not load the library.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Back to library' })).toHaveCount(0);
});

test('resumes the saved readable format', async ({ page }) => {
	await setup(page);
	await page.goto('/books/21');
	await page.getByRole('button', { name: 'Resume', exact: true }).click();
	await expect(page).toHaveURL('/read/21/31');
});

test('persists rating, status and dates without showing private notes as a review', async ({ page }) => {
	const state = await setup(page);
	state.notes = [{
		id: 'private-note', book_id: 21, highlight_id: null, body_md: 'A private book note.',
		created_at: stamp, updated_at: stamp, deleted_at: null, rev: 1
	}];
	await page.goto('/books/21');
	await expect(page.getByRole('region', { name: 'Reviews', exact: true })).toContainText('No reviews yet.');
	await expect(page.getByText('A private book note.')).toHaveCount(0);
	const rating = page.getByRole('radio', { name: '4 out of 5', exact: true });
	await expect(rating).toBeVisible();
	await rating.click();
	await expect.poll(() => state.mutations.some((item) => item.entity === 'user_books' && item.data.rating === 8)).toBe(true);
	await expect(rating).toHaveAttribute('aria-checked', 'true');

	await page.getByRole('button', { name: 'Reading status: Reading' }).click();
	await page.getByRole('menuitemradio', { name: 'Read', exact: true }).click();
	await expect.poll(() => state.userBook?.status).toBe('finished');
	await expect(page.getByRole('button', { name: 'Reading status: Read' })).toBeVisible();

	await page.getByRole('button', { name: 'Edit Date started' }).click();
	await page.getByLabel('Date started', { exact: true }).fill('2026-03-04');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => state.mutations.some((item) => item.entity === 'user_books' && item.data.started_at === Date.parse('2026-03-04T00:00:00Z'))).toBe(true);
	await expect(page.getByText('Mar 4, 2026', { exact: true })).toBeVisible();

	await page.reload();
	await expect(rating).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('button', { name: 'Reading status: Read' })).toBeVisible();
	await expect(page.getByText('Mar 4, 2026', { exact: true })).toBeVisible();

	if (!state.userBook) throw new Error('Expected a saved user book.');
	state.userBook = { ...state.userBook, rating: 2, updated_at: '2026-11-07T12:00:00Z', rev: state.userBook.rev + 1 };
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 21 } })));
	await expect(page.getByRole('radio', { name: '1 out of 5', exact: true })).toHaveAttribute('aria-checked', 'true');

	await page.getByRole('button', { name: 'Edit Date started' }).click();
	await page.getByRole('button', { name: 'Clear', exact: true }).click();
	await expect.poll(() => state.userBook?.started_at).toBeNull();
});

test('uses the stored status and persists a new re-read without a finish date', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/books/21');
	await page.getByRole('button', { name: 'Reading status: Reading' }).click();
	await page.getByRole('menuitemradio', { name: 'Read', exact: true }).click();
	await expect.poll(() => state.userBook?.status).toBe('finished');
	expect(state.userBook?.finished_at).not.toBeNull();
	await page.getByRole('button', { name: 'Reading status: Read' }).click();
	await page.getByRole('menuitemradio', { name: 'Re-reading' }).click();
	await expect.poll(() => state.userBook?.status).toBe('rereading');
	expect(state.userBook?.started_at).not.toBeNull();
	expect(state.userBook?.finished_at).toBeNull();
	expect(state.userBook?.rating).toBe(6);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Reading status: Re-reading' })).toBeVisible();
});

test('opens the metadata editor from the administrator details card', async ({ page }) => {
	await setup(page, 'admin');
	await page.goto('/books/21');
	const card = page.getByRole('region', { name: 'Details', exact: true });
	const edit = card.getByRole('link', { name: 'Edit metadata', exact: true });
	await expect(edit).toHaveAttribute('href', '/books/21/edit');
	await expect(edit).toHaveAttribute('title', 'Edit metadata');
	await expect(edit.locator('svg')).toHaveCSS('width', '16px');
	await edit.focus();
	await expect(edit).toHaveCSS('outline-width', '2px');
	const headingBox = await card.getByRole('heading', { name: 'Details' }).boundingBox();
	const editBox = await edit.boundingBox();
	if (!headingBox || !editBox) throw new Error('Missing details heading or edit control.');
	expect(editBox.width).toBe(32);
	expect(editBox.height).toBe(32);
	expect(editBox.x).toBeGreaterThan(headingBox.x + headingBox.width);
	await edit.click();
	await expect(page).toHaveURL('/books/21/edit');
	await expect(page.getByRole('heading', { name: 'Edit metadata: The Emerald Library' })).toBeVisible();
});

test('hides edit metadata and shows the write-review button to non-admins', async ({ page }) => {
	await setup(page);
	await page.goto('/books/21');
	await expect(page.getByRole('button', { name: 'Write a review', exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Details', exact: true }).getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
});

test('shows only the details-card edit link to administrators', async ({ page }) => {
	await setup(page, 'admin');
	await page.goto('/books/21');
	const card = page.getByRole('region', { name: 'Details', exact: true });
	await expect(card.getByRole('link', { name: 'Edit metadata' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Edit metadata' })).toHaveCount(1);
	await expect(page.getByText('Metadata sources', { exact: true })).toHaveCount(0);
});

test('manages shelf tags on the real tab with permissions, confirmation, keyboard and rollback', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/books/21');
	const tags = page.getByRole('list', { name: 'Shelves', exact: true });
	await expect(tags.getByRole('link')).toHaveText(['Owned shelf', 'Shared shelf']);
	await expect(tags.getByRole('link', { name: 'Owned shelf' })).toHaveAttribute('href', '/shelves/43');
	await expect(page.getByRole('button', { name: 'Remove from Shared shelf', exact: true })).toHaveCount(0);
	const remove = page.getByRole('button', { name: 'Remove from Owned shelf', exact: true });

	await tags.getByRole('link', { name: 'Owned shelf' }).focus();
	await page.keyboard.press('Tab');
	await expect(remove).toBeFocused();
	page.once('dialog', async (dialog) => {
		expect(dialog.message()).toBe('Remove “The Emerald Library” from “Owned shelf”?');
		await dialog.dismiss();
	});
	await page.keyboard.press('Enter');
	await expect(tags.getByRole('link', { name: 'Owned shelf' })).toBeVisible();
	expect(state.shelfDeletes).toEqual([]);

	state.failShelfDelete = true;
	page.once('dialog', (dialog) => dialog.accept());
	await remove.click();
	await expect(page.getByRole('alert').filter({ hasText: /shelf/i })).toBeVisible();
	await expect(tags.getByRole('link', { name: 'Owned shelf' })).toBeVisible();
	expect(state.shelfDeletes).toEqual(['/shelves/43/books/21']);

	state.failShelfDelete = false;
	page.once('dialog', (dialog) => dialog.accept());
	await remove.click();
	await expect(page.getByRole('status').filter({ hasText: 'Removed from Owned shelf' })).toBeVisible();
	await expect(tags.getByRole('link')).toHaveText(['Shared shelf']);
	expect(state.shelfDeletes).toEqual(['/shelves/43/books/21', '/shelves/43/books/21']);
});

test.describe('touch shelf tags', () => {
	test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 800 } });

	test('shows the remove badge without hover on touch devices', async ({ page }) => {
		await setup(page);
		await page.goto('/books/21');
		await expect(page.getByRole('button', { name: 'Remove from Owned shelf', exact: true })).toHaveCSS('opacity', '1');
	});
});

test('shows distinct metadata sources, field provenance and cover source inside the details card', async ({ page }) => {
	const state = await setup(page);
	const longReference = 'reference'.repeat(30);
	state.book = {
		...book,
		field_sources: [
			{ field: 'title', source: 'openlibrary', source_ref: '/works/OL1W', chosen_by: null, chosen_at: stamp },
			{ field: 'subtitle', source: 'import', source_ref: null, chosen_by: null, chosen_at: stamp },
			{ field: 'publisher', source: 'openlibrary', source_ref: 'fixture', chosen_by: null, chosen_at: stamp },
			{ field: 'description', source: 'googlebooks', source_ref: longReference, chosen_by: null, chosen_at: stamp }
		]
	};
	await page.setViewportSize({ width: 360, height: 900 });
	await page.goto('/books/21');
	const card = page.getByRole('region', { name: 'Details', exact: true });
	const metadata = card.locator('dl > div').filter({ has: page.getByText('Metadata source', { exact: true }) });
	const cover = card.locator('dl > div').filter({ has: page.getByText('Cover source', { exact: true }) });
	await expect(metadata.locator('dd > span')).toHaveText('openlibrary, import, googlebooks');
	await expect(cover.locator('dd')).toHaveText('Imported');

	const disclosure = metadata.locator('details');
	await expect(disclosure.locator('li').first()).toBeHidden();
	await disclosure.getByText('Show fields', { exact: true }).click();
	await expect(disclosure.locator('li')).toHaveText([
		'title: openlibrary · /works/OL1W',
		'subtitle: import',
		'publisher: openlibrary · fixture',
		`description: googlebooks · ${longReference}`
	]);
	await expect(disclosure.locator('li').last()).toBeVisible();
	const dimensions = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		content: document.documentElement.scrollWidth
	}));
	expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
	await disclosure.getByText('Show fields', { exact: true }).click();
	await expect(disclosure.locator('li').first()).toBeHidden();

	state.book = { ...state.book, field_sources: [], cover_source: null };
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 21 } })));
	await expect(metadata.locator('dd > span')).toHaveText('–');
	await expect(metadata.locator('details')).toHaveCount(0);
	await expect(cover).toHaveCount(0);
});

test('localizes details card metadata controls', async ({ page }) => {
	await setup(page, 'admin', 'zh');
	await page.goto('/books/21');
	const card = page.getByRole('region', { name: '详情', exact: true });
	const edit = card.getByRole('link', { name: '编辑元数据', exact: true });
	await expect(edit).toHaveAttribute('title', '编辑元数据');
	await expect(card.getByText('元数据来源', { exact: true })).toBeVisible();
	await expect(card.getByText('封面来源', { exact: true })).toBeVisible();
	await card.getByText('显示字段', { exact: true }).click();
	await expect(card.getByText('title: import · fixture', { exact: true })).toBeVisible();
});

test('keeps metadata sources but hides the admin edit control when offline', async ({ page, context }) => {
	const state = await setup(page, 'admin');
	await page.goto('/books/21');
	const card = page.getByRole('region', { name: 'Details', exact: true });
	await expect(card.getByRole('link', { name: 'Edit metadata' })).toBeVisible();
	await page.goto('/books/21/files');
	const filePanel = page.getByRole('region', { name: 'This file' });
	await filePanel.getByRole('button', { name: 'Actions for library.epub' }).click();
	await filePanel.getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect(page.getByText('Book file downloaded for offline reading.', { exact: true })).toBeVisible();
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
		}
	});

	await page.goto('/books/21');
	await expect(card.getByRole('link', { name: 'Edit metadata' })).toBeVisible();
	state.online = false;
	await context.setOffline(true);
	await expect(card.getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
	state.online = true;
	await context.setOffline(false);
	await expect(card.getByRole('link', { name: 'Edit metadata' })).toBeVisible();

	state.online = false;
	await context.setOffline(true);
	await page.goto('/books/21');
	await expect(page.getByText('Reading details are read-only while offline.')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Reviews', exact: true })).toContainText('Reviews are available when you\'re online.');
	await expect(page.getByRole('button', { name: 'Write a review' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add to shelf' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Remove from / })).toHaveCount(0);
	const hero = page.locator('header').filter({ has: page.getByRole('heading', { name: book.title, exact: true }) });
	const status = hero.getByLabel('Unread', { exact: true });
	await expect(status).toBeVisible();
	await expect(status).toHaveCSS('border-top-width', '0px');
	await expect(status).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(status.locator('svg')).toHaveCount(1);
	await expect(status.locator('[data-status-icon="unread"]')).toBeVisible();
	await expect(status.getByRole('button')).toHaveCount(0);
	await expect(hero.getByRole('button')).toHaveCount(0);
	await expect(hero.getByRole('link', { name: 'Personal review', exact: true })).toHaveCount(0);
	await expect(card.getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
	await expect(card.getByRole('button', { name: 'Edit Date started' })).toHaveCount(0);
	await expect(card.getByText('import', { exact: true })).toBeVisible();
	await expect(card.getByText('Imported', { exact: true })).toBeVisible();
	await card.getByText('Show fields', { exact: true }).click();
	await expect(card.getByText('title: import · fixture', { exact: true })).toBeVisible();
});

test.describe('details card permission overrides', () => {
	test.use({ serviceWorkers: 'block', bypassCSP: true });

	test('honors explicit permissions and always hides the edit link offline', async ({ page }) => {
		await setup(page);
		await page.goto('/books/21');
		const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
		const result = await build({
			configFile: false,
			plugins: [svelte()],
			resolve: { alias: [{ find: '#lib', replacement: resolve(fixtureDirectory, '..', '..') }] },
			build: {
				write: false,
				lib: { entry: resolve(fixtureDirectory, 'details-panel-fixture.ts'), formats: ['es'] }
			}
		});
		const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
			if (!('output' in item)) throw new Error('Unexpected fixture build result.');
			return item.output;
		});
		const script = outputs.find((output) => output.type === 'chunk' && output.isEntry);
		if (!script || script.type !== 'chunk') throw new Error('The details fixture did not produce JavaScript.');
		await page.evaluate(() => {
			const root = document.createElement('div');
			root.id = 'bd6-test-root';
			document.body.append(root);
		});
		await page.addScriptTag({ content: script.code, type: 'module' });
		const root = page.locator('#bd6-test-root');
		const edit = root.getByRole('link', { name: 'Edit metadata', exact: true });
		await expect(root.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
		await expect(edit).toHaveCount(0);
		await root.getByLabel('Context permission').check();
		await expect(edit).toHaveAttribute('href', '/books/21/edit');
		await root.getByLabel('Edit permission override').selectOption('deny');
		await expect(edit).toHaveCount(0);
		await root.getByLabel('Context permission').uncheck();
		await root.getByLabel('Edit permission override').selectOption('allow');
		await expect(edit).toBeVisible();
		await root.getByLabel('Offline').check();
		await expect(edit).toHaveCount(0);
		await root.getByLabel('Offline').uncheck();
		await expect(edit).toBeVisible();
		await root.getByRole('button', { name: 'Switch book' }).click();
		await expect(edit).toHaveAttribute('href', '/books/22/edit');
	});
});
