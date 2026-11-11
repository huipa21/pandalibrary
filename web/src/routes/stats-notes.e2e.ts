import { expect, test, type Page, type Route } from '@playwright/test';

test.use({ timezoneId: 'America/New_York' });

async function authenticate(page: Page, locale = 'en') {
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale } } })
	);
}

function problem(route: Route, status: number, detail = '') {
	return route.fulfill({
		status,
		contentType: 'application/problem+json',
		body: JSON.stringify({ title: 'Problem', status, detail })
	});
}

function days(from: string, to: string) {
	const result: { date: string; active_seconds: number; session_count: number }[] = [];
	for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
		result.push({ date: day.toISOString().slice(0, 10), active_seconds: 0, session_count: 0 });
	}
	return result;
}

function statsFor(from: string, to: string, timezone: string, active = true) {
	const daily = days(from, to);
	if (active) {
		daily[0].active_seconds = 3725;
		daily[0].session_count = 2;
		daily[daily.length - 1].active_seconds = 90;
		daily[daily.length - 1].session_count = 1;
	}
	return {
		timezone, from, to, daily,
		finished_per_month: [...new Set(daily.map((day) => day.date.slice(0, 7)))].map((month, index) => ({
			month, books_finished: active && index === 0 ? 2 : 0
		})),
		streaks: active ? { current_days: 1, longest_days: 4 } : { current_days: 0, longest_days: 0 },
		time_per_book: active
			? [{ book_id: 42, title: 'Dune', authors: ['Frank Herbert'], active_seconds: 3815, session_count: 3 }]
			: []
	};
}

test('stats use local inclusive dates and the browser timezone, with accessible tables and validation', async ({ page }) => {
	await authenticate(page);
	const requests: URLSearchParams[] = [];
	await page.route('**/api/v1/stats?*', (route) => {
		const params = new URL(route.request().url()).searchParams;
		requests.push(params);
		const from = params.get('from')!;
		const to = params.get('to')!;
		if (from === '2025-06-01') return problem(route, 400, 'Too many books in this range; narrow the range.');
		return route.fulfill({ json: statsFor(from, to, params.get('timezone')!, from !== '2026-02-01') });
	});

	await page.goto('/');
	await page.getByRole('link', { name: 'Stats', exact: true }).click();
	await expect(page).toHaveURL(/\/stats$/);
	await expect(page.getByRole('heading', { name: 'Reading stats' })).toHaveClass('sr-only');

	await expect.poll(() => requests.length).toBe(1);
	const initial = requests[0];
	expect([...initial.keys()]).toEqual(['from', 'to', 'timezone']);
	expect(initial.get('timezone')).toBe('America/New_York');
	const today = await page.evaluate(() => {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	});
	expect(initial.get('to')).toBe(today);
	await expect(page.getByLabel('From', { exact: true })).toHaveValue(initial.get('from')!);
	await expect(page.getByText('Days follow your time zone (America/New_York).')).toBeVisible();

	await page.getByLabel('From', { exact: true }).fill('2026-01-30');
	await page.getByLabel('To', { exact: true }).fill('2026-02-02');
	await page.getByRole('button', { name: 'Show stats' }).click();
	await expect.poll(() => requests.length).toBe(2);
	expect(requests[1].get('from')).toBe('2026-01-30');
	expect(requests[1].get('to')).toBe('2026-02-02');

	await expect(page.getByTestId('current-streak')).toHaveText('1');
	await expect(page.getByTestId('longest-streak')).toHaveText('4');
	const daily = page.getByRole('region', { name: 'Reading time and sessions for each day' });
	await expect(daily.getByRole('row')).toHaveCount(5);
	await expect(daily.getByRole('row', { name: /Jan 30, 2026/ })).toContainText('1 h 2 min');
	await expect(daily.getByRole('row', { name: /Jan 31, 2026/ })).toContainText('0 min');
	await expect(daily.getByRole('row', { name: /Feb 2, 2026/ })).toContainText('1 min');
	await expect(page.getByRole('img', { name: /Bar chart of daily reading time/ })).toBeVisible();
	const months = page.getByRole('table', { name: 'Books finished in each month of the range' });
	await expect(months.getByRole('row', { name: /Jan 2026/ })).toContainText('2');
	await expect(months.getByRole('row', { name: /Feb 2026/ })).toContainText('0');
	await expect(page.getByRole('link', { name: 'Dune' })).toHaveAttribute('href', '/books/42');

	await daily.focus();
	await expect(daily).toBeFocused();

	await page.getByLabel('From', { exact: true }).fill('2026-02-05');
	await page.getByRole('button', { name: 'Show stats' }).click();
	await expect(page.getByRole('alert')).toHaveText('The start date must be on or before the end date.');
	await page.getByLabel('From', { exact: true }).fill('2024-01-01');
	await page.getByLabel('To', { exact: true }).fill('2025-01-01');
	await page.getByRole('button', { name: 'Show stats' }).click();
	await expect(page.getByRole('alert')).toHaveText('Choose a range of 366 days or fewer.');
	expect(requests).toHaveLength(2);

	await page.getByLabel('From', { exact: true }).fill('2025-06-01');
	await page.getByLabel('To', { exact: true }).fill('2025-06-30');
	await page.getByRole('button', { name: 'Show stats' }).click();
	await expect(page.getByRole('alert')).toContainText('Too many books in this range; narrow the range.');
	await expect(page.getByLabel('From', { exact: true })).toHaveValue('2025-06-01');
	await expect(page.getByLabel('To', { exact: true })).toHaveValue('2025-06-30');

	await page.getByLabel('From', { exact: true }).fill('2026-02-01');
	await page.getByLabel('To', { exact: true }).fill('2026-02-03');
	await page.getByRole('button', { name: 'Show stats' }).click();
	await expect(page.getByText('No reading recorded in this range.')).toBeVisible();
	await expect(page.getByText('No books finished in this range.')).toBeVisible();
	await expect(page.getByText('No reading time recorded for any book in this range.')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Reading time and sessions for each day' }).getByRole('row')).toHaveCount(4);
});

test('stats recover from connection failures and expired sessions', async ({ page }) => {
	await authenticate(page);
	let calls = 0;
	await page.route('**/api/v1/stats?*', (route) => {
		calls += 1;
		if (calls === 1) return route.abort('failed');
		if (calls === 2) return problem(route, 401);
		const params = new URL(route.request().url()).searchParams;
		return route.fulfill({ json: statsFor(params.get('from')!, params.get('to')!, params.get('timezone')!) });
	});

	await page.goto('/stats');
	await expect(page.getByRole('alert')).toContainText('Stats could not be reached');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByRole('alert')).toContainText('Your session has ended');
	await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
	await page.getByRole('button', { name: 'Last 7 days' }).click();
	await expect(page.getByRole('region', { name: 'Reading time and sessions for each day' }).getByRole('row')).toHaveCount(8);
});

const annotation = (id: string, bookId: number, kind: 'highlight' | 'note' | 'review' | 'text', content: string, position = 0) => ({
	id, book_id: bookId, book_title: `Book ${bookId}`, cover_url: null, kind, content, position,
	book_file_id: kind === 'review' ? undefined : 31,
	highlight_id: kind === 'highlight' || kind === 'note' ? id : undefined,
	created_at: '2026-11-03T08:00:00Z'
});

test('searches annotations with unified entries and no export panel', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/me/notes?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	const searches: URLSearchParams[] = [];
	await page.route('**/api/v1/search/annotations?*', (route) => {
		const params = new URL(route.request().url()).searchParams;
		searches.push(params);
		if (params.get('q') === 'spice') {
			return route.fulfill({ json: { items: [
				annotation('h-1', 101, 'highlight', 'The spice must flow.', 0.425),
				annotation('n-1', 104, 'note', '<img src=x onerror="window.__xss=1"> **spice** notes'),
				annotation('h-2', 101, 'highlight', 'Spice everywhere', 0.9)
			] } });
		}
		if (params.get('q') === 'zz') return route.fulfill({ json: { items: [] } });
		return problem(route, 400);
	});
	await page.goto('/notes');
	await expect(page.getByText('You have no annotations yet.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Annotations', exact: true })).toBeVisible();
	expect(searches).toHaveLength(0);

	const box = page.getByRole('searchbox', { name: 'Search annotations', exact: true });
	await expect(page.getByRole('heading', { name: 'Annotations', exact: true })).toHaveClass('sr-only');
	await expect(box).toHaveAttribute('placeholder', 'Search reviews, comments, notes, highlights, and inserted text');
	await expect(page.locator('#notes-query-hint')).toHaveCount(0);
	await expect(page.getByText('Search annotations', { exact: true })).toHaveCount(0);
	await box.fill('  spice ');
	await box.press('Enter');
	await expect(page).toHaveURL(/\/notes\?q=spice$/);
	await expect(page.getByText('Matches: 3.')).toBeVisible();
	const results = page.getByRole('list', { name: 'Matching annotations, newest first' }).getByRole('listitem');
	await expect(results).toHaveCount(3);
	await expect(results.nth(0)).toContainText('The spice must flow.');
	await expect(results.nth(0)).toContainText('Book 101');
	await expect(results.nth(1)).toContainText('Comment');
	await expect(results.nth(1).locator('strong')).toHaveText('spice');
	await expect(results.nth(1).locator('.reader-markdown img')).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
	await expect(results.nth(1).getByRole('link')).toHaveAttribute('href', '/read/104/31?highlight=n-1');
	await expect(results.nth(0).getByText('Highlight', { exact: true })).toHaveClass(/bg-amber-100/);
	await expect(results.nth(1).getByText('Comment', { exact: true })).toHaveClass(/bg-emerald-100/);
	expect(searches).toHaveLength(1);

	await page.getByRole('search', { name: 'Annotations search' }).getByRole('button', { name: 'Search', exact: true }).click();
	expect(searches).toHaveLength(1);

	await expect(page.getByText('Export notes', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);
	await expect(page.getByRole('checkbox')).toHaveCount(0);

	await box.fill('zz');
	await box.press('Enter');
	await expect(page.getByText('Searches of one or two characters match those characters anywhere.')).toBeVisible();
	await expect(page.getByText('None of your annotations match “zz”.')).toBeVisible();
	await expect(page.getByText('Export notes', { exact: true })).toHaveCount(0);

	await box.fill('x'.repeat(201));
	await box.press('Enter');
	await expect(page.getByRole('alert')).toHaveText('This search is too long. Use 200 characters or fewer.');
	expect(searches.map((params) => params.get('q'))).toEqual(['spice', 'zz']);
});

test('notes search reports expired sessions and connection failures with recovery', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/me/notes?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	let calls = 0;
	await page.route('**/api/v1/search/annotations?*', (route) => {
		calls += 1;
		if (calls === 1) return problem(route, 401);
		if (calls === 2) return route.abort('failed');
		return route.fulfill({ json: { items: [annotation('h-1', 7, 'highlight', 'Recovered', 0.1)] } });
	});

	await page.goto('/notes?q=dune');
	await expect(page.getByRole('alert')).toContainText('Your session has ended');
	await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
	await page.getByRole('searchbox', { name: 'Search annotations', exact: true }).press('Enter');
	await expect(page.getByRole('alert')).toContainText('Annotations search could not be reached');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('Recovered')).toBeVisible();
});

test('shows reviews and comments newest first with book covers and pagination', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/books/21/cover*', (route) => route.fulfill({
		status: 200,
		contentType: 'image/svg+xml',
		body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150"><rect width="100" height="150" fill="#3b6d59"/></svg>'
	}));
	const requests: string[] = [];
	await page.route('**/api/v1/me/notes?*', (route) => {
		const params = new URL(route.request().url()).searchParams;
		requests.push(params.get('cursor') ?? 'first');
		if (!params.has('cursor')) {
			return route.fulfill({ json: {
				items: [
					{ id: '18', kind: 'review', book_id: 21, book_title: 'Dune', cover_url: '/api/v1/books/21/cover', content: 'My review', created_at: '2026-11-10T12:00:00Z', updated_at: '2026-11-10T12:00:00Z' },
					{ id: '00000000-0000-7000-8000-000000000001', kind: 'comment', book_id: 22, book_title: 'A Wizard of Earthsea', cover_url: null, content: 'A **passage** comment <img src=x onerror="window.__xss=1">', anchor: 'The quoted passage', created_at: '2026-11-09T12:00:00Z', updated_at: '2026-11-09T12:00:00Z' }
				],
				next_cursor: 'older'
			} });
		}
		return route.fulfill({ json: {
			items: [{ id: '00000000-0000-7000-8000-000000000002', kind: 'book_note', book_id: 23, book_title: 'The Left Hand of Darkness', cover_url: null, content: 'A private legacy note', created_at: '2026-11-08T12:00:00Z', updated_at: '2026-11-08T12:00:00Z' }],
			next_cursor: null
		} });
	});

	await page.goto('/notes');
	const list = page.getByRole('list', { name: 'Your annotations, newest first' });
	await expect(list.getByRole('listitem')).toHaveCount(2);
	await expect(list.getByRole('listitem').nth(0)).toContainText('Dune');
	await expect(list.getByRole('listitem').nth(0)).toContainText('My review');
	await expect(list.getByRole('listitem').nth(0).locator('img')).toHaveAttribute('src', '/api/v1/books/21/cover');
	await expect(list.getByRole('listitem').nth(1)).toContainText('The quoted passage');
	await expect(list.getByRole('listitem').nth(1).locator('.reader-markdown strong')).toHaveText('passage');
	await expect(list.getByRole('listitem').nth(1).locator('.reader-markdown img')).toHaveCount(0);
	await page.getByRole('button', { name: 'Show more' }).click();
	await expect(list.getByRole('listitem')).toHaveCount(3);
	await expect(list.getByRole('listitem').nth(2)).toContainText('A private legacy note');
	expect(requests).toEqual(['first', 'older']);
});

test('Notes shows inserted text and drawing previews and searches reviews using icon controls', async ({ page }) => {
	await authenticate(page);
	const base = { book_id: 21, book_file_id: 31, book_title: 'Book 21', cover_url: null, created_at: '2026-11-10T12:00:00Z', updated_at: '2026-11-10T12:00:00Z' };
	const locator = { type: 'pdf', page: 5, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
	await page.route('**/api/v1/me/notes?*', (route) => route.fulfill({ json: { items: [
		{ ...base, id: 'review', kind: 'review', content: '这是一个扣子的大纲' },
		{ ...base, id: 'text', kind: 'text', content: '扣子已经关闭了', locator },
		{ ...base, id: 'ink', kind: 'ink', content: '', locator, data: { color: '#000000', width: 0.01, strokes: [[0.1, 0.2, 0.3, 0.4]] } }
	], next_cursor: null } }));
	await page.route('**/api/v1/search/annotations?*', (route) => {
		expect(new URL(route.request().url()).searchParams.get('q')).toBe('扣子');
		return route.fulfill({ json: { items: [
			annotation('review', 21, 'review', '这是一个扣子的大纲'),
			{ ...annotation('text', 21, 'text', '扣子已经关闭了', 0.5), locator, created_at: base.created_at },
			annotation('comment', 21, 'note', 'AI实战使用扣子')
		] } });
	});
	await page.goto('/notes');
	const feed = page.getByRole('list', { name: 'Your annotations, newest first' });
	await expect(feed.getByRole('listitem')).toHaveCount(3);
	await expect(feed.getByRole('img', { name: 'Drawing' })).toBeVisible();
	await expect(feed.getByRole('img', { name: 'Drawing' }).locator('path')).toHaveAttribute('d', 'M0.1 0.2 L0.3 0.4');
	await expect(feed.getByText('Page 5')).toHaveCount(2);
	await expect(feed.getByRole('listitem').nth(0).getByRole('link')).toHaveAttribute('href', '/books/21#book-reviews-heading');
	await expect(feed.getByRole('listitem').nth(1).getByRole('link')).toHaveAttribute('href', '/read/21/31?annotation=text');
	await expect(feed.getByRole('listitem').nth(2).getByRole('link')).toHaveAttribute('href', '/read/21/31?annotation=ink');
	const feedText = await feed.getByRole('listitem').nth(1).innerHTML();
	const form = page.getByRole('search', { name: 'Annotations search' });
	const submit = form.getByRole('button', { name: 'Search', exact: true });
	const clear = form.getByRole('button', { name: 'Clear search' });
	await expect(submit).toHaveClass(/shell-search-submit/);
	await expect(submit).toHaveText('');
	await expect(clear).toHaveText('');
	await form.getByRole('searchbox').fill('扣子');
	await submit.click();
	const matches = page.getByRole('list', { name: 'Matching annotations, newest first' });
	await expect(matches.getByRole('listitem')).toHaveCount(3);
	await expect(matches).toContainText('Review');
	await expect(matches).toContainText('Inserted text');
	await expect(matches).toContainText('Comment');
	await expect(matches.getByRole('listitem').nth(0).getByRole('link')).toHaveAttribute('href', '/books/21#book-reviews-heading');
	await expect(matches.getByRole('listitem').nth(1).getByRole('link')).toHaveAttribute('href', '/read/21/31?annotation=text');
	expect(await matches.getByRole('listitem').nth(1).innerHTML()).toBe(feedText);
	await expect(feed).toHaveCount(0);
	await clear.click();
	await expect(feed.getByRole('img', { name: 'Drawing' })).toBeVisible();
	await expect(form.getByRole('searchbox')).toBeFocused();
});

test('Notes explains an unavailable backend and retries the feed', async ({ page }) => {
	await authenticate(page);
	let calls = 0;
	await page.route('**/api/v1/me/notes?*', (route) => {
		if (++calls === 1) return problem(route, 404);
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto('/notes');
	await expect(page.getByRole('alert')).toContainText('Restart or update the backend');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('You have no annotations yet.')).toBeVisible();
});
