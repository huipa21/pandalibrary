import { expect, test, type Page } from '@playwright/test';
import type { Book } from '#lib/catalog/types.js';
import type { Note, Progress } from '#lib/reader/types.js';
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
		case 'finished':
		case 'abandoned':
			return value;
		default:
			throw new TypeError('Invalid user book status.');
	}
}

async function setup(page: Page, role = 'user') {
	const state: {
		userBook: UserBook | null;
		progress: Progress;
		notes: Note[];
		mutations: CapturedMutation[];
		rejectNext: boolean;
		shelfAdds: number;
	} = {
		userBook: { status: 'reading', rating: 6, started_at: null, finished_at: null, updated_at: stamp, rev: 1 },
		progress: { book_file_id: 31, source: 'web', locator: null, percentage: 0.21, device: 'Web', device_id: 'device', updated_at: stamp, rev: 1 },
		notes: [],
		mutations: [],
		rejectNext: false,
		shelfAdds: 0
	};
	const summary = {
		progress: 0.21, sessions: 196, total_seconds: 10_560, average_seconds: 54,
		active_days: 2, span_days: 4, first_read_at: stamp, last_read_at: stamp,
		pace_percent_per_hour: null, estimated_seconds_left: null,
		records: { longest_session: null, best_day: null, longest_streak_days: 1 },
		attempts: [
			{ number: 2, status: 'in_progress', started_at: stamp, ended_at: stamp, sessions: 1, seconds: 60, max_percentage: 0.21, sources: ['web'] },
			{ number: 1, status: 'completed', started_at: stamp, ended_at: stamp, sessions: 1, seconds: 60, max_percentage: 1, sources: ['web'] }
		],
		days: [
			{ date: '2026-11-05', seconds: 60, sessions: 1, max_percentage: 0.1 },
			{ date: '2026-11-06', seconds: 120, sessions: 1, max_percentage: 0.21 }
		]
	};
	const sessions = [1, 2, 3].map((id) => ({
		id: `session-${id}`, source: id === 2 ? 'koreader' : 'web', device: 'Reader',
		started_at: stamp, ended_at: stamp, active_seconds: id * 60,
		start_percentage: 0.1, end_percentage: 0.21, change: 0.11, attempt: 2
	}));
	let rev = 1;
	await page.route('**/api/v1/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: { id: 1, username: role, display_name: role, role, locale: 'en' } } });
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
		if (path === '/books/21') return route.fulfill({ json: { book } });
		if (path === '/books') {
			const items = url.searchParams.has('author_id') ? [book, authorBook]
				: url.searchParams.has('series_id') ? [book, seriesBook]
					: url.searchParams.has('tag_id') ? [seriesBook, tagBook] : [book];
			return route.fulfill({ json: { items, next_cursor: null } });
		}
		if (path === '/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Fiction', slug: 'fiction', created_at: stamp, updated_at: stamp } } });
		if (path.startsWith('/shelves/system/')) return route.fulfill({ json: { shelf: null } });
		if (path === '/shelves/41/books/21' && route.request().method() === 'PUT') {
			state.shelfAdds += 1;
			return route.fulfill({ json: { saved: true } });
		}
		if (path === '/shelves') return route.fulfill({ json: { items: [{
			id: 41, name: 'My shelf', kind: 'private', owner_id: 1, created_by: 1,
			description: null, visible_book_count: 0, mode: 'manual', system_key: null,
			created_at: stamp, updated_at: stamp
		}], next_cursor: null } });
		if (path === '/me/books/21') return route.fulfill({ json: { user_book: state.userBook, progress: state.progress, highlights: [], bookmarks: [], notes: state.notes } });
		if (path === '/me/books/21/reading-summary') return route.fulfill({ json: { summary } });
		if (path === '/me/books/21/sessions') return route.fulfill({ json: { items: sessions, next_cursor: null, total: 196 } });
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
	await expect(page.getByText('A reader’s journey')).toBeVisible();
	await expect(page.getByRole('link', { name: 'A Writer', exact: true })).toBeVisible();
	await expect(page.getByText('(Translator)')).toBeVisible();
	await expect(page.getByRole('link', { name: 'The Reading Series', exact: true }).first()).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Synopsis' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Your review' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Show more' })).toBeVisible();
	await page.getByRole('button', { name: 'Show more' }).click();
	await expect(page.getByText('Synopsis line 10')).toBeVisible();

	const reading = page.getByRole('region', { name: 'Your reading' });
	await expect(reading).toContainText('196');
	await expect(reading).toContainText('2h 56m');
	await expect(reading).toContainText('54s');
	await expect(reading).toContainText('21%');
	await expect(reading).toContainText('KOReader');
	await expect(reading.getByText('Reading time across the last 2 active days: 3m.')).toBeAttached();
	await expect(reading.locator('[aria-hidden="true"] > span')).toHaveCount(30);
	await expect(page.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '21');
	await expect(page.getByRole('link', { name: 'Files on disk: 2' })).toHaveAttribute('href', '/books/21/files');
	await expect(page.getByText('Panda Press')).toBeVisible();
	await expect(page.getByText('Fiction', { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/library/1');
	await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', book.files[0].download_url);
	await page.getByLabel('Choose a download format').click();
	await expect(page.getByRole('link', { name: 'Download PDF' }).first()).toHaveAttribute('href', book.files[1].download_url);
	await page.getByLabel('Choose a download format').click();
	await expect(page.getByRole('link', { name: 'Another by the Author' })).toBeVisible();
	await page.getByRole('button', { name: 'Similar books' }).click();
	await expect(page.getByRole('link', { name: 'Earlier in the Series' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'A Similar Tale' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Identifiers' })).toBeVisible();
	await page.getByText('Metadata sources', { exact: true }).click();
	await expect(page.getByText('title: import · fixture')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Read EPUB' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Download for offline' }).first()).toBeVisible();

	for (const width of [1440, 1024, 390]) {
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
		if (!cover || !hero || !panel) throw new Error(`Missing details layout at ${width}px.`);
		if (width >= 1280) {
			expect(hero.x).toBeGreaterThan(cover.x + cover.width);
			expect(panel.x).toBeGreaterThan(hero.x);
			expect(Math.abs(panel.y - hero.y)).toBeLessThan(80);
		} else if (width >= 768) {
			expect(hero.x).toBeGreaterThan(cover.x + cover.width);
			expect(panel.y).toBeGreaterThan(cover.y + cover.height);
		} else {
			expect(hero.y).toBeGreaterThan(cover.y + cover.height);
			expect(panel.y).toBeGreaterThan(hero.y);
		}
	}
	await page.getByRole('link', { name: 'Add to shelf', exact: true }).click();
	await page.getByRole('combobox', { name: 'Shelf', exact: true }).selectOption('41');
	await page.getByRole('button', { name: 'Add to shelf', exact: true }).click();
	await expect(page.getByText('Added to “My shelf”.')).toBeVisible();
	expect(state.shelfAdds).toBe(1);
});

test('keeps library navigation available when loading its metadata fails', async ({ page }) => {
	await setup(page);
	await page.route('**/api/v1/libraries/1', (route) =>
		route.fulfill({ status: 503, json: { title: 'Unavailable', status: 503 } })
	);
	await page.goto('/books/21');
	await expect(page.getByText('Could not load the library.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/library/1');
});

test('resumes the saved readable format', async ({ page }) => {
	await setup(page);
	await page.goto('/books/21');
	await page.getByRole('button', { name: 'Resume', exact: true }).click();
	await expect(page).toHaveURL('/read/21/31');
});

test('persists rating, status, dates and review, and refreshes on book-state events', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/books/21');
	const rating = page.getByRole('radio', { name: '4 out of 5', exact: true });
	await expect(rating).toBeVisible();
	await rating.click();
	await expect.poll(() => state.mutations.some((item) => item.entity === 'user_books' && item.data.rating === 8)).toBe(true);
	await expect(rating).toHaveAttribute('aria-checked', 'true');

	await page.getByRole('button', { name: 'Reading status: Re-reading' }).click();
	await page.getByRole('menuitemradio', { name: 'Finished' }).click();
	await expect.poll(() => state.userBook?.status).toBe('finished');
	await expect(page.getByRole('button', { name: 'Reading status: Finished' })).toBeVisible();

	await page.getByRole('button', { name: 'Edit Date started' }).click();
	await page.getByLabel('Date started', { exact: true }).fill('2026-03-04');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => state.mutations.some((item) => item.entity === 'user_books' && item.data.started_at === Date.parse('2026-03-04T00:00:00Z'))).toBe(true);
	await expect(page.getByText('Mar 4, 2026', { exact: true })).toBeVisible();

	await page.getByRole('button', { name: 'Write', exact: true }).click();
	await page.getByRole('textbox', { name: 'Your review', exact: true }).fill('A thoughtful personal review.');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => state.mutations.some((item) => item.entity === 'notes' && item.data.body_md === 'A thoughtful personal review.')).toBe(true);
	await expect(page.getByText('A thoughtful personal review.', { exact: true })).toBeVisible();
	await page.reload();
	await expect(page.getByText('A thoughtful personal review.', { exact: true })).toBeVisible();
	await expect(rating).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('button', { name: 'Reading status: Finished' })).toBeVisible();
	await expect(page.getByText('Mar 4, 2026', { exact: true })).toBeVisible();

	if (!state.userBook) throw new Error('Expected a saved user book.');
	state.userBook = { ...state.userBook, rating: 2, updated_at: '2026-11-07T12:00:00Z', rev: state.userBook.rev + 1 };
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 21 } })));
	await expect(page.getByRole('radio', { name: '1 out of 5', exact: true })).toHaveAttribute('aria-checked', 'true');

	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('textbox', { name: 'Your review', exact: true }).fill('');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => state.mutations.some((item) => item.entity === 'notes' && item.op === 'delete')).toBe(true);
	await expect(page.getByText('Not written yet', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Edit Date started' }).click();
	await page.getByRole('button', { name: 'Clear', exact: true }).click();
	await expect.poll(() => state.userBook?.started_at).toBeNull();
});

test('shows edit metadata only to administrators', async ({ page }) => {
	await setup(page, 'admin');
	await page.goto('/books/21');
	await expect(page.getByRole('link', { name: 'Edit metadata' })).toHaveAttribute('href', '/books/21/edit');
});

test('hides edit metadata from non-admins and reports rejected review writes', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/books/21');
	await expect(page.getByRole('button', { name: 'Write', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
	state.rejectNext = true;
	await page.getByRole('button', { name: 'Write', exact: true }).click();
	await page.getByRole('textbox', { name: 'Your review', exact: true }).fill('Rejected review');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Could not save your review');
	await expect(page.getByRole('textbox', { name: 'Your review', exact: true })).toHaveValue('Rejected review');
});
