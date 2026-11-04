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
	await expect(page.getByRole('heading', { name: 'Reading stats' })).toBeVisible();

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

const annotation = (id: string, bookId: number, kind: 'highlight' | 'note', content: string, position = 0) => ({
	id, book_id: bookId, kind, content, position, created_at: '2026-11-03T08:00:00Z'
});

test('searches annotations and downloads single-book Markdown and multi-book ZIP exports', async ({ page }) => {
	await authenticate(page);
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
	const exports: URLSearchParams[] = [];
	await page.route('**/api/v1/me/notes/export?*', (route) => {
		const params = new URL(route.request().url()).searchParams;
		exports.push(params);
		const ids = params.get('book_ids');
		if (ids === '101') {
			return route.fulfill({
				status: 200,
				headers: {
					'content-type': 'text/markdown; charset=utf-8',
					'cache-control': 'no-store',
					'content-disposition': "attachment; filename*=utf-8''%E6%B2%99%E4%B8%98%20-%20Frank%20Herbert.md"
				},
				body: '# 沙丘\n'
			});
		}
		if (ids === '101,104') {
			return route.fulfill({
				status: 200,
				headers: {
					'content-type': 'application/zip',
					'cache-control': 'no-store',
					'content-disposition': 'attachment; filename="PandaLibrary notes 2026-11-04.zip"'
				},
				body: Buffer.from([80, 75, 5, 6, ...new Array(18).fill(0)])
			});
		}
		return problem(route, 404);
	});

	await page.goto('/notes');
	await expect(page.getByText('Enter a word or phrase to search your notes and highlights.')).toBeVisible();
	expect(searches).toHaveLength(0);

	const box = page.getByRole('searchbox', { name: 'Search notes and highlights' });
	await box.fill('  spice ');
	await box.press('Enter');
	await expect(page).toHaveURL(/\/notes\?q=spice$/);
	await expect(page.getByText('Matches: 3.')).toBeVisible();
	const results = page.getByRole('list', { name: 'Matching notes and highlights, newest first' }).getByRole('listitem');
	await expect(results).toHaveCount(3);
	await expect(results.nth(0)).toContainText('The spice must flow.');
	await expect(results.nth(0)).toContainText('At 42.5% of the book');
	await expect(results.nth(1)).toContainText('<img src=x onerror="window.__xss=1"> **spice** notes');
	await expect(results.nth(1).locator('img')).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
	await expect(results.nth(1).getByRole('link', { name: 'Open book 104' })).toHaveAttribute('href', '/books/104');
	expect(searches).toHaveLength(1);

	await page.getByRole('search', { name: 'Notes search' }).getByRole('button', { name: 'Search', exact: true }).click();
	expect(searches).toHaveLength(1);

	const markdownButton = page.getByRole('button', { name: 'Download Markdown' });
	await expect(markdownButton).toBeDisabled();
	await expect(page.getByText('No books selected.')).toBeVisible();
	await page.getByRole('checkbox', { name: 'Book 101 (matches: 2)' }).check();
	await expect(page.getByText('Books selected: 1 of up to 100.')).toBeVisible();
	const markdown = page.waitForEvent('download');
	await markdownButton.click();
	const markdownDownload = await markdown;
	expect(markdownDownload.suggestedFilename()).toBe('沙丘 - Frank Herbert.md');
	await expect(page.getByText('Downloaded “沙丘 - Frank Herbert.md”.')).toBeVisible();

	await page.getByRole('checkbox', { name: 'Book 104 (matches: 1)' }).press('Space');
	const zip = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download ZIP (2 books)' }).click();
	expect((await zip).suggestedFilename()).toBe('PandaLibrary notes 2026-11-04.zip');
	expect(exports.map((params) => params.getAll('book_ids'))).toEqual([['101'], ['101,104']]);
	expect(exports.every((params) => [...params.keys()].length === 1)).toBe(true);

	await page.getByRole('button', { name: 'Clear selection' }).click();
	await expect(page.getByRole('button', { name: 'Download Markdown' })).toBeDisabled();
	await page.getByRole('button', { name: 'Select all books' }).click();
	await expect(page.getByText('Books selected: 2 of up to 100.')).toBeVisible();

	await page.getByRole('checkbox', { name: 'Book 101 (matches: 2)' }).uncheck();
	await page.getByRole('button', { name: 'Download Markdown' }).click();
	await expect(page.getByRole('alert')).toContainText('A selected book is no longer available.');

	await box.fill('zz');
	await box.press('Enter');
	await expect(page.getByText('Searches of one or two characters match those characters anywhere.')).toBeVisible();
	await expect(page.getByText('None of your notes or highlights match “zz”.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Export notes' })).toHaveCount(0);

	await box.fill('x'.repeat(201));
	await box.press('Enter');
	await expect(page.getByRole('alert')).toHaveText('This search is too long. Use 200 characters or fewer.');
	expect(searches.map((params) => params.get('q'))).toEqual(['spice', 'zz']);
});

test('notes search reports expired sessions and connection failures with recovery', async ({ page }) => {
	await authenticate(page);
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
	await page.getByRole('searchbox', { name: 'Search notes and highlights' }).press('Enter');
	await expect(page.getByRole('alert')).toContainText('Notes search could not be reached');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('Recovered')).toBeVisible();
});
