import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { HistoryPage, HistoryRow, HistorySummary } from '#lib/stats/history.js';

const year = new Date().getFullYear();

function row(id: number, date = `${year}-11-13`): HistoryRow {
	return {
		date, book_id: id, title: `History book ${id}`, authors: [`Author ${id}`],
		cover_url: null, cycle: id === 1 ? 3 : 1, active_seconds: 120,
		session_count: 2, day_active_seconds: 6120, day_session_count: 102
	};
}

function summary(selectedYear = year, empty = false): HistorySummary {
	return {
		books: empty ? 0 : 60, active_seconds: empty ? 0 : 37200,
		session_count: empty ? 0 : 120, active_days: empty ? 0 : 3,
		months: Array.from({ length: 12 }, (_, index) => ({
			month: `${selectedYear}-${String(index + 1).padStart(2, '0')}`,
			books: !empty && index === 10 ? 52 : !empty && index === 9 ? 8 : 0,
			active_seconds: !empty && index === 10 ? 30000 : !empty && index === 9 ? 7200 : 0,
			session_count: !empty && index === 10 ? 104 : !empty && index === 9 ? 16 : 0
		})),
		records: {
			busiest_day: empty ? null : { date: `${year}-11-13`, active_seconds: 6120, session_count: 102 },
			longest_session_seconds: empty ? 0 : 3600,
			most_read_book: empty ? null : { book_id: 1, title: 'History book 1', session_count: 12 }
		}
	};
}

async function setup(page: Page) {
	const state = { requests: [] as string[], failNext: false };
	await page.route('**/api/v1/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: {
			user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' }
		} });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: []
		} });
		if (path === '/stats/history') {
			state.requests.push(url.search);
			expect(url.searchParams.get('limit')).toBe('50');
			expect(url.searchParams.get('timezone')).toBeTruthy();
			if (url.searchParams.has('cursor') && state.failNext) {
				state.failNext = false;
				return route.fulfill({ status: 503, json: { title: 'Temporarily unavailable' } });
			}
			const selectedYear = Number(url.searchParams.get('year'));
			const empty = selectedYear !== year;
			const more = url.searchParams.has('cursor');
			const response: HistoryPage = {
				year: selectedYear, timezone: url.searchParams.get('timezone')!,
				items: empty ? [] : more ? [
					row(51), row(52, `${year}-11-12`), row(53, `${year}-10-30`)
				] : Array.from({ length: 50 }, (_, index) => row(index + 1)),
				next_cursor: empty || more ? null : 'next-page',
				summary: summary(selectedYear, empty)
			};
			return route.fulfill({ json: response });
		}
		if (path === '/books/count') return route.fulfill({ json: { count: 60 } });
		if (path === '/version') return route.fulfill({ status: 503, json: {} });
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	return state;
}

test('history groups months, completes split days, and reuses locally cached pages', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/stats/history');
	await expect(page.getByTestId('history-row')).toHaveCount(50);
	await expect(page.getByText('Read cycle 3', { exact: true })).toBeVisible();
	const panel = page.getByRole('complementary', { name: `${year} in numbers` });
	await expect(panel.getByText('60', { exact: true })).toBeVisible();
	await expect(panel.getByText('10 h 20 m', { exact: true })).toBeVisible();
	await expect(page.getByText('Day total', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: `Nov ${year}`, exact: true })).toHaveCount(1);
	await expect(page.getByText('52 books · 104 sessions · 8 h 20 m')).toBeVisible();
	await page.getByRole('button', { name: 'Load more history' }).scrollIntoViewIfNeeded();
	await expect(page.getByTestId('history-row')).toHaveCount(53);
	await expect(page.getByText('Day total', { exact: true })).toHaveCount(3);
	await expect(page.getByRole('heading', { name: `Oct ${year}`, exact: true })).toHaveCount(1);
	expect(state.requests).toHaveLength(2);
	await page.reload();
	await expect(page.getByTestId('history-row').first()).toBeAttached();
	const moreButton = page.getByRole('button', { name: 'Load more history' });
	if (await moreButton.count()) await moreButton.scrollIntoViewIfNeeded();
	await expect(page.getByTestId('history-row')).toHaveCount(53);
	expect(state.requests).toHaveLength(2);
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect.poll(() => state.requests.length).toBeGreaterThan(2);
});

test('failed next page is retryable without losing rows; year switching shows empty state', async ({ page }) => {
	const state = await setup(page);
	state.failNext = true;
	await page.goto('/stats/history');
	await expect(page.getByTestId('history-row')).toHaveCount(50);
	await page.getByRole('button', { name: 'Load more history' }).scrollIntoViewIfNeeded();
	await expect(page.getByRole('alert')).toBeVisible();
	await expect(page.getByTestId('history-row')).toHaveCount(50);
	await page.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(page.getByTestId('history-row')).toHaveCount(53);
	await page.getByRole('button', { name: 'Previous year', exact: true }).click();
	await expect(page.getByText(`No reading sessions in ${year - 1}.`)).toBeVisible();
	await expect(page.getByTestId('history-row')).toHaveCount(0);
	await expect(page.getByRole('complementary', { name: `${year - 1} in numbers` })).toBeVisible();
});

test('history fits mobile and exposes accessible content', async ({ page }) => {
	await setup(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/stats/history');
	await expect(page.getByTestId('history-row')).toHaveCount(50);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	for (const theme of ['light', 'dark']) {
		await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
		// Cover artwork is decorative; each title has a separate accessible link.
		const result = await new AxeBuilder({ page }).include('.history').exclude('.cover-link').analyze();
		expect(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }))).toEqual([]);
	}
});
