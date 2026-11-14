import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { ReadingStats } from '#lib/stats/reading-types.js';

test.use({ timezoneId: 'America/New_York' });

async function authenticate(page: Page, locale = 'en') {
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route('**/api/v1/shelves?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) => route.fulfill({
		json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale } }
	}));
}

function stats(year: number, empty = false): ReadingStats {
	const calendarYear = String(year).padStart(4, '0');
	const daily: ReadingStats['daily'] = [];
	for (const date = new Date(`${calendarYear}-01-01T00:00:00Z`); date.getUTCFullYear() === year; date.setUTCDate(date.getUTCDate() + 1)) {
		const key = date.toISOString().slice(0, 10);
		const seconds = empty ? 0 : key.endsWith('01-01') ? 21600 : key.endsWith('01-02') ? 3600 : key.endsWith('02-29') ? 7200 : 0;
		daily.push({ date: key, active_seconds: seconds, session_count: seconds ? 1 : 0 });
	}
	return {
		year, timezone: 'America/New_York', daily,
		hours: empty ? [] : [
			{ month: 1, hour: 0, active_seconds: 21600, session_count: 1 },
			{ month: 1, hour: 23, active_seconds: 3600, session_count: 1 },
			...(year === 2024 ? [{ month: 2, hour: 6, active_seconds: 7200, session_count: 1 }] : [])
		],
		books: empty ? { read: 0, read_and_reading: 0 } : { read: 4, read_and_reading: 5 },
		completions: empty ? [] : [0, 5, 10].map((days, index) => ({
			book_id: index + 1, title: `Completed book ${index + 1}`,
			started_on: `${calendarYear}-01-01`, finished_on: `${calendarYear}-01-${String(days + 1).padStart(2, '0')}`, days
		}))
	};
}

test('reading cards share yearly data, filter independently and expose exact chart summaries', async ({ page }) => {
	await authenticate(page);
	const requests: URL[] = [];
	await page.route('**/api/v1/stats/reading?*', (route) => {
		const url = new URL(route.request().url());
		requests.push(url);
		return route.fulfill({ json: stats(Number(url.searchParams.get('year'))) });
	});
	await page.goto('/stats/reading');
	const heatmap = page.getByRole('region', { name: 'Reading Heatmap', exact: true });
	const habits = page.getByRole('region', { name: 'Reading Habits', exact: true });
	const race = page.getByRole('region', { name: 'Reading Completion Race', exact: true });
	await expect(heatmap.getByText('Days of reading', { exact: true })).toBeVisible();
	expect(requests).toHaveLength(1);
	expect([...requests[0].searchParams.keys()]).toEqual(['year', 'timezone']);
	expect(requests[0].searchParams.get('timezone')).toBe('America/New_York');
	await expect(page.getByLabel('From', { exact: true })).toHaveCount(0);
	await heatmap.getByLabel('Year', { exact: true }).selectOption('2024');
	await expect(heatmap.getByText('Total reading hours', { exact: true }).locator('..')).toContainText('9 h');
	await expect(heatmap.getByText('Average hours per reading day', { exact: true }).locator('..')).toContainText('3 h');
	await expect(heatmap.getByText('Days of reading', { exact: true }).locator('..')).toContainText('3');
	await expect(heatmap.getByText('Books Read', { exact: true }).locator('..')).toContainText('4');
	await expect(heatmap.getByText('Books Read and Reading', { exact: true }).locator('..')).toContainText('5');
	await expect(heatmap.locator('rect[data-date]')).toHaveCount(366);
	await expect(heatmap.locator('rect[data-date="2024-02-29"]')).toHaveAttribute('data-seconds', '7200');
	await expect(habits.getByLabel('Year', { exact: true })).not.toHaveValue('2024');
	await expect(race.getByLabel('Year', { exact: true })).not.toHaveValue('2024');
	await habits.getByLabel('Year', { exact: true }).selectOption('2024');
	await race.getByLabel('Year', { exact: true }).selectOption('2024');
	await expect(race.getByText('Average days', { exact: true }).locator('..')).toContainText('5');
	await expect(race.getByText('Median days', { exact: true }).locator('..')).toContainText('5');
	await expect(race.getByText('Fastest days', { exact: true }).locator('..')).toContainText('0');
	await expect(race.getByText('Slowest days', { exact: true }).locator('..')).toContainText('10');
	expect(requests).toHaveLength(2);
	await expect(habits.getByRole('img', { name: 'Weekdays', exact: true })).toBeVisible();
	await expect(habits.getByRole('img', { name: 'Time range (0–24 hours)', exact: true })).toBeVisible();
	await expect(race.getByRole('img', { name: 'Stepped chart of days to complete Read books', exact: true })).toBeVisible();
	await expect(race.locator('path')).toHaveAttribute('d', /H .* V .* H .* V /);
	await habits.getByText('Reading hours by weekday', { exact: true }).click();
	const weekdays = habits.getByRole('table', { name: 'Weekdays', exact: true });
	await expect(weekdays.getByRole('row').nth(1)).toHaveText('Monday6 h');
	await expect(weekdays.getByRole('row').nth(2)).toHaveText('Tuesday1 h');
	await expect(weekdays.getByRole('row').nth(4)).toHaveText('Thursday2 h');
	await habits.getByText('Reading hours by time range', { exact: true }).click();
	const hours = habits.getByRole('table', { name: 'Time range (0–24 hours)', exact: true });
	await expect(hours.getByRole('row')).toHaveCount(25);
	await expect(hours.getByRole('row').nth(1)).toHaveText('00:00–01:006 h');
	await expect(hours.getByRole('row').nth(24)).toHaveText('23:00–24:001 h');
	await habits.getByLabel('Month', { exact: true }).selectOption('2');
	await expect(habits.getByText('2 h', { exact: true }).first()).toBeAttached();
	await habits.getByLabel('Month', { exact: true }).selectOption('3');
	await expect(habits.getByText('No reading recorded in this period.')).toBeVisible();
	await expect(heatmap.getByText('Total reading hours', { exact: true }).locator('..')).toContainText('9 h');
	expect(requests).toHaveLength(2);
	await heatmap.getByRole('button', { name: 'Previous year', exact: true }).click();
	await expect(heatmap.getByLabel('Year', { exact: true })).toHaveValue('2023');
	await expect(heatmap.getByText('Total reading hours', { exact: true }).locator('..')).toContainText('7 h');
	await heatmap.getByRole('button', { name: 'Next year', exact: true }).click();
	await expect(heatmap.getByText('Total reading hours', { exact: true }).locator('..')).toContainText('9 h');
	await expect(habits.getByLabel('Year', { exact: true })).toHaveValue('2024');
	await expect(race.getByLabel('Year', { exact: true })).toHaveValue('2024');
	expect(requests).toHaveLength(3);
	const accessibility = await new AxeBuilder({ page }).include('main').analyze();
	expect(accessibility.violations).toEqual([]);
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await heatmap.getByLabel('Year', { exact: true }).selectOption('1');
	await expect(heatmap.getByText('Total reading hours', { exact: true }).locator('..')).toContainText('7 h');
	expect(requests.at(-1)?.searchParams.get('year')).toBe('0001');
	await expect(heatmap.getByRole('button', { name: 'Previous year', exact: true })).toBeDisabled();
});

test('reading cards recover from failures and show empty and localized results', async ({ page }) => {
	await authenticate(page, 'zh');
	let calls = 0;
	await page.route('**/api/v1/stats/reading?*', (route) => {
		calls++;
		if (calls === 1) return route.abort('failed');
		const year = Number(new URL(route.request().url()).searchParams.get('year'));
		return route.fulfill({ json: stats(year, true) });
	});
	await page.goto('/stats/reading');
	await expect(page.getByRole('alert')).toHaveCount(3);
	await page.getByRole('region', { name: '阅读热力图', exact: true }).getByRole('button', { name: '重试', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.getByRole('region', { name: '阅读热力图', exact: true })).toBeVisible();
	await expect(page.getByText('此期间没有阅读记录。')).toBeVisible();
	await expect(page.getByText('此年份没有同时记录开始及完成日期的已读图书。')).toBeVisible();
	expect(calls).toBe(2);
});
