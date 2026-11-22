import { expect, test, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { BookStatsResponse } from '#lib/stats/book-types.js';

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

function problem(route: Route, status: number) {
	return route.fulfill({ status, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Problem', status }) });
}

function stats(empty = false): BookStatsResponse {
	const ranked = Array.from({ length: 25 }, (_, index) => ({
		book_id: index + 1, title: `Catalog book ${index + 1}`, authors: ['Catalog Author'], value: 25 - index
	}));
	return {
		timezone: 'America/New_York',
		total_books: empty ? 0 : 4,
		added_over_time: empty ? [] : [{ key: '2026-01', count: 3 }, { key: '2026-02', count: 1 }],
		publication_years: empty ? [] : [{ key: '1990', count: 1 }, { key: '2020', count: 2 }, { key: 'unknown', count: 1 }],
		genres: empty ? [] : [{ key: 'Fiction', count: 3 }, { key: 'Adventure', count: 2 }],
		languages: empty ? [] : [{ key: 'en', count: 3 }, { key: 'unknown', count: 1 }],
		formats: empty ? [] : [{ key: 'epub', count: 3 }, { key: 'pdf', count: 2 }],
		page_counts: empty ? [] : [{ key: '1-100', count: 1 }, { key: '101-200', count: 2 }, { key: '201-300', count: 0 }, { key: 'unknown', count: 1 }],
		top_authors: empty ? [] : Array.from({ length: 25 }, (_, index) => ({ name: `Author ${index + 1}`, count: 25 - index })),
		largest_books: empty ? [] : ranked.map((book) => ({ ...book, value: book.value * 1024 })),
		most_pages: empty ? [] : ranked.map((book) => ({ ...book, value: book.value * 100 }))
	};
}

const titles = [
	'Books Added Over Time', 'Publication Year Timeline', 'Genre Distribution', 'Page Count Distribution',
	'Language Distribution', 'Format Distribution', 'Top 20 Authors', 'Top 20 Largest Books', 'Top 20 Books with Most Pages'
];

test('catalog shows nine all-time cards with counts, percentage interactions and capped linked rankings', async ({ page }) => {
	await authenticate(page);
	const requests: URL[] = [];
	await page.route('**/api/v1/stats/books?*', (route) => {
		requests.push(new URL(route.request().url()));
		return route.fulfill({ json: stats() });
	});
	await page.goto('/stats/books');
	await expect(page.getByRole('heading', { name: 'Books', exact: true })).toHaveClass('sr-only');
	for (const title of titles) await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
	expect(requests).toHaveLength(1);
	expect([...requests[0].searchParams.keys()]).toEqual(['timezone']);
	expect(requests[0].searchParams.get('timezone')).toBe('America/New_York');
	await expect(page.getByLabel('From', { exact: true })).toHaveCount(0);
	const dashboard = page.locator('section[aria-labelledby="books-stats-heading"]');
	await expect(dashboard.locator(':scope > p')).toHaveCount(0);
	await expect(dashboard.locator('header p')).toHaveCount(0);

	const added = page.getByRole('region', { name: titles[0], exact: true });
	const january = added.getByRole('button', { name: 'Jan 2026: 3', exact: true });
	await expect(january.locator('.bar')).toBeVisible();
	await expect(added.getByRole('button', { name: 'Feb 2026: 1', exact: true })).toBeVisible();
	await expect(added.locator('.value')).toHaveCount(0);
	await january.hover();
	await expect(added.getByRole('status')).toContainText('Jan 2026');
	await expect(added.getByRole('status')).toContainText('3');
	const years = page.getByRole('region', { name: titles[1], exact: true });
	await expect(years.getByText('Unknown publication year: 1 (25%)')).toBeVisible();
	await expect(years.getByRole('button', { name: /^Unknown:/ })).toHaveCount(0);
	const year = years.getByRole('button', { name: '1990: 1', exact: true });
	await expect(year.locator('.bar')).toBeVisible();
	await expect(years.locator('.value')).toHaveCount(0);
	await year.hover();
	await expect(years.getByRole('status')).toContainText('1990');
	await expect(years.getByRole('status')).toContainText('1');

	const language = page.getByRole('region', { name: titles[4], exact: true });
	await language.locator('.legend').getByRole('button', { name: 'English: 3 (75%)', exact: true }).hover();
	await expect(language.getByRole('status')).toContainText('English');
	await expect(language.getByRole('status')).toContainText('3 (75%)');
	const pages = page.getByRole('region', { name: titles[3], exact: true });
	await pages.getByRole('button', { name: '101-200: 2 (50%)', exact: true }).hover();
	await expect(pages.getByRole('status')).toContainText('2 (50%)');
	await expect(pages.getByRole('button', { name: '201-300: 0 (0%)', exact: true })).toBeVisible();
	await pages.locator('summary').click();
	const pageData = pages.getByRole('table', { name: titles[3], exact: true });
	await expect(pageData).toBeVisible();
	await expect(pageData.getByRole('row')).toHaveCount(3);
	await expect(pageData.getByRole('row', { name: '1-100 1 (25%)', exact: true })).toBeVisible();
	await expect(pageData.getByRole('row', { name: '101-200 2 (50%)', exact: true })).toBeVisible();
	await expect(pageData.getByRole('row', { name: 'Unknown 1 (25%)', exact: true })).toBeVisible();
	await expect(pageData.getByRole('rowheader', { name: '201-300', exact: true })).toHaveCount(0);

	const formats = page.getByRole('region', { name: titles[5], exact: true });
	const epub = formats.locator('.legend').getByRole('button', { name: 'EPUB: 3 (75%)', exact: true });
	await epub.click();
	await expect(epub).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('heading', { name: titles[0], exact: true }).hover();
	await expect(formats.getByRole('status')).toContainText('EPUB');
	await expect(formats.getByRole('status')).toContainText('3 (75%)');
	const pdf = formats.locator('.legend').getByRole('button', { name: 'PDF: 2 (50%)', exact: true });
	await pdf.focus();
	await page.keyboard.press('Enter');
	await expect(pdf).toHaveAttribute('aria-pressed', 'true');
	await expect(formats.getByRole('status')).toContainText('2 (50%)');
	await expect(formats).not.toContainText('a book may appear in more than one format');

	for (const title of titles.slice(6)) {
		const ranking = page.getByRole('region', { name: title, exact: true });
		await expect(ranking.getByRole('listitem')).toHaveCount(20);
	}
	const largest = page.getByRole('region', { name: titles[7], exact: true });
	await expect(largest.getByRole('listitem').first()).toContainText('25 KB');
	await expect(largest.getByTitle('25,600 bytes')).toBeVisible();
	await expect(largest.getByRole('link').first()).toHaveAttribute('href', '/books/1');
	const mostPages = page.getByRole('region', { name: titles[8], exact: true });
	await expect(mostPages.getByRole('listitem').first()).toContainText('2,500 pages');
	await expect(mostPages.getByRole('link').last()).toHaveAttribute('href', '/books/20');
});

test('a single added month uses month placeholders and bars comparable to page counts at responsive widths', async ({ page }) => {
	await authenticate(page);
	await page.setViewportSize({ width: 1920, height: 1000 });
	await page.route('**/api/v1/stats/books?*', (route) => route.fulfill({ json: {
		...stats(),
		total_books: 7,
		added_over_time: [{ key: '2026-11', count: 7 }],
		page_counts: [
			{ key: '1-100', count: 7 }, { key: '101-200', count: 0 }, { key: '201-300', count: 0 },
			{ key: '301-500', count: 0 }, { key: '501-1000', count: 0 }, { key: '1001+', count: 0 },
			{ key: 'unknown', count: 0 }
		]
	} }));
	await page.goto('/stats/books');
	const added = page.getByRole('region', { name: titles[0], exact: true });
	const november = added.getByRole('button', { name: 'Nov 2026: 7', exact: true });
	const bar = november.locator('.bar');
	const pages = page.getByRole('region', { name: titles[3], exact: true });
	const pageBar = pages.getByRole('button', { name: '1-100: 7 (100%)', exact: true }).locator('.bar');
	await expect(added.locator('.bar-control')).toHaveCount(12);
	await expect(added.getByRole('button', { name: 'Dec 2025: 0', exact: true })).toHaveCount(1);
	await expect(added.getByRole('button', { name: 'Oct 2026: 0', exact: true })).toHaveCount(1);
	for (const width of [1920, 1440, 900, 390, 1440]) {
		await page.setViewportSize({ width, height: 1000 });
		const geometry = await bar.evaluate((element) => {
			const bar = element.getBoundingClientRect();
			const scroll = element.closest('.scroll')!.getBoundingClientRect();
			return { width: bar.width, left: bar.left, right: bar.right, scrollLeft: scroll.left, scrollRight: scroll.right };
		});
		const pageWidth = (await pageBar.boundingBox())!.width;
		expect(geometry.width / pageWidth).toBeGreaterThan(0.7);
		expect(geometry.width / pageWidth).toBeLessThan(1.3);
		expect(geometry.left).toBeGreaterThanOrEqual(geometry.scrollLeft);
		expect(geometry.right).toBeLessThanOrEqual(geometry.scrollRight);
	}
	await page.setViewportSize({ width: 390, height: 1000 });
	const december = added.getByRole('button', { name: 'Dec 2025: 0', exact: true });
	await december.focus();
	await expect(added.getByRole('status')).toContainText('Dec 2025');
	const firstMonthVisible = await december.evaluate((element) => {
		const button = element.getBoundingClientRect();
		const scroll = element.closest('.scroll')!.getBoundingClientRect();
		return button.left >= scroll.left && button.right <= scroll.right;
	});
	expect(firstMonthVisible).toBe(true);
	await added.getByRole('button', { name: 'Oct 2026: 0', exact: true }).hover();
	await expect(added.getByRole('status')).toContainText('Oct 2026');
	await expect(added.getByRole('status')).toContainText('0');
	await added.locator('summary').click();
	const table = added.getByRole('table', { name: titles[0], exact: true });
	await expect(table.getByRole('row')).toHaveCount(1);
	await expect(table.getByRole('row', { name: 'Nov 2026 7', exact: true })).toBeVisible();
});

test('sparse publication years retain regular decade intervals and empty gaps', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/stats/books?*', (route) => route.fulfill({ json: {
		...stats(),
		total_books: 7,
		publication_years: [{ key: '1865', count: 1 }, { key: '1946', count: 1 }, { key: 'unknown', count: 5 }]
	} }));
	await page.goto('/stats/books');
	const years = page.getByRole('region', { name: titles[1], exact: true });
	await expect(years.getByRole('button')).toHaveCount(9);
	for (let year = 1860; year <= 1940; year += 10) {
		const count = year === 1860 || year === 1940 ? 1 : 0;
		await expect(years.getByRole('button', { name: `${year}: ${count}`, exact: true })).toBeVisible();
	}
	await expect(years.getByText('Unknown publication year: 5 (71.4%)')).toBeVisible();
});

for (const width of [900, 1440]) {
	test(`catalog pairs timelines with compact distributions at ${width}px`, async ({ page }) => {
		await authenticate(page);
		await page.setViewportSize({ width, height: 1000 });
		await page.route('**/api/v1/stats/books?*', (route) => route.fulfill({ json: stats() }));
		await page.goto('/stats/books');
		await page.evaluate(() => document.fonts.ready);
		let previousBottom = 0;
		for (const [leftIndex, rightIndex] of [[0, 4], [1, 5], [2, 3]]) {
			const left = page.getByRole('region', { name: titles[leftIndex], exact: true });
			const right = page.getByRole('region', { name: titles[rightIndex], exact: true });
			await expect(left).toBeVisible({ timeout: 30_000 });
			await expect(right).toBeVisible({ timeout: 30_000 });
			const leftBox = (await left.boundingBox())!;
			const rightBox = (await right.boundingBox())!;
			expect(leftBox.y).toBeCloseTo(rightBox.y, 0);
			expect(rightBox.x).toBeGreaterThanOrEqual(leftBox.x + leftBox.width);
			if (leftIndex < 2) {
				const gap = rightBox.x - leftBox.x - leftBox.width;
				expect(leftBox.width).toBeCloseTo(rightBox.width * 2 + gap, 0);
			} else {
				expect(leftBox.width).toBeCloseTo(rightBox.width, 0);
			}
			expect(leftBox.y).toBeGreaterThanOrEqual(previousBottom);
			previousBottom = Math.max(leftBox.y + leftBox.height, rightBox.y + rightBox.height);
		}
	});
}

test('empty catalog keeps all nine cards and never renders invalid percentages', async ({ page }) => {
	await authenticate(page);
	await page.route('**/api/v1/stats/books?*', (route) => route.fulfill({ json: stats(true) }));
	await page.goto('/stats/books');
	await expect(page.getByText('There are no books in your catalog yet.')).toBeVisible();
	for (const title of titles) await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
	const added = page.getByRole('region', { name: titles[0], exact: true });
	await expect(added.getByText('No books to show.')).toBeVisible();
	await expect(added.locator('.bar-control')).toHaveCount(0);
	await expect(page.getByText('Unknown publication year: 0 (0%)')).toBeVisible();
	await expect(page.getByText('No books with this metadata to rank.')).toHaveCount(3);
	await expect(page.getByText(/NaN|Infinity/)).toHaveCount(0);
});

test('catalog handles loading, retryable connection and server failures, and expired sessions', async ({ page }) => {
	await authenticate(page);
	let calls = 0;
	let release: (() => void) | undefined;
	const waiting = new Promise<void>((resolve) => { release = resolve; });
	page.on('close', () => release?.());
	await page.route('**/api/v1/stats/books?*', async (route) => {
		calls += 1;
		if (calls === 1) {
			await waiting;
			return route.abort('failed');
		}
		if (calls === 2) return problem(route, 500);
		return route.fulfill({ json: stats() });
	});
	await page.goto('/stats/books');
	await expect(page.getByRole('status', { name: '' }).filter({ hasText: 'Loading your book stats…' })).toBeVisible();
	release!();
	await expect(page.getByRole('alert')).toContainText('Stats could not be reached');
	await page.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('The stats request failed');
	await page.getByRole('button', { name: 'Try again', exact: true }).click();
	await expect(page.getByRole('region', { name: titles[0], exact: true })).toBeVisible();
	await page.route('**/api/v1/stats/books?*', (route) => problem(route, 401));
	await page.reload();
	await expect(page.getByRole('alert')).toContainText('Your session has ended');
	await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login');
	await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
});

test('Chinese catalog is localized and usable at mobile widths with accessible chart details', async ({ page }) => {
	await authenticate(page, 'zh');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.route('**/api/v1/stats/books?*', (route) => route.fulfill({ json: stats() }));
	await page.goto('/stats/books');
	await expect(page.getByRole('region', { name: '图书添加趋势', exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: '出版年份时间线', exact: true })).toContainText('出版年份未知：1 (25%)');
	const languages = page.getByRole('region', { name: '语言分布', exact: true });
	await languages.locator('.legend').getByRole('button', { name: '英语: 3 (75%)', exact: true }).focus();
	await expect(languages.getByRole('status')).toContainText('3 (75%)');
	const details = languages.locator('summary');
	await expect(details).toHaveText('查看图表数据');
	await details.click();
	await expect(languages.getByRole('table', { name: '语言分布', exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: '页数最多的 20 本图书', exact: true }).getByRole('listitem').first()).toContainText('2,500 页');
	const cards = page.locator('section[aria-labelledby="books-stats-heading"] section[aria-label]');
	await expect(cards).toHaveCount(9);
	const cardBoxes = await cards.evaluateAll((elements) => elements.map((element) => {
		const box = element.getBoundingClientRect();
		return { x: box.x + window.scrollX, y: box.y + window.scrollY, height: box.height };
	}));
	let previousBottom = 0;
	let columnLeft: number | undefined;
	for (const box of cardBoxes) {
		columnLeft ??= box.x;
		expect(box.x).toBeCloseTo(columnLeft, 0);
		expect(box.y).toBeGreaterThanOrEqual(previousBottom);
		previousBottom = box.y + box.height;
	}
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	const accessibility = await new AxeBuilder({ page }).include('section[aria-labelledby="books-stats-heading"]').analyze();
	expect(accessibility.violations).toEqual([]);
});
