import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { BookSession, ReadingSummary } from '../log-api.js';

interface Mutation {
	entity: string;
	id: string;
	op: string;
	updated_at: number;
	data: Record<string, unknown>;
}

interface Harness {
	sessions: BookSession[];
	mutations: Mutation[];
	requests: Array<{ method: string; path: string; query: string }>;
	failDelete: boolean;
	rejectManual: boolean;
	exportPageSize: number;
	failNextSummary: boolean;
	failNextFirstPage: boolean;
	failNextMore: boolean;
	failNextExport: boolean;
}

const book = {
	id: 21, library_id: 1, title: 'A Test Book', sort_title: 'A Test Book',
	subtitle: null, description: null, language: 'en', publisher: null, published_date: null,
	page_count: null, cover_url: null, cover_source: null, authors: [], series: null, tags: [],
	identifiers: [], files: [], field_sources: [], created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z'
};

function sessions(count: number): BookSession[] {
	return Array.from({ length: count }, (_, index) => {
		const start = Date.UTC(2026, 10, 6, 10) - index * 86_400_000;
		return {
			id: `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
			started_at: new Date(start).toISOString(),
			ended_at: new Date(start + 300_000).toISOString(),
			active_seconds: 300, start_percentage: index === 0 ? 0.8 : 0.1,
			end_percentage: 0.2, change: index === 0 ? -0.6 : 0.1,
			source: index % 2 ? 'web' : 'koreader',
			device: index === 0 ? 'Kobo, "bedroom"' : 'Browser',
			attempt: index < 12 ? 2 : 1
		};
	});
}

function summary(items: readonly BookSession[]): ReadingSummary {
	const empty = items.length === 0;
	return {
		progress: empty ? 0 : 0.21, sessions: items.length, total_seconds: empty ? 0 : 10_800,
		average_seconds: empty ? 0 : 300, active_days: empty ? 0 : 3, span_days: empty ? 0 : 4,
		first_read_at: empty ? null : '2026-03-07T10:00:00Z',
		last_read_at: empty ? null : '2026-11-06T10:05:00Z',
		pace_percent_per_hour: empty ? null : 14.2, estimated_seconds_left: empty ? null : 300,
		records: {
			longest_session: empty ? null : { seconds: 360, date: '2026-03-07' },
			best_day: empty ? null : { seconds: 600, date: '2026-03-08' },
			longest_streak_days: empty ? 0 : 3
		},
		attempts: empty ? [] : [
			{ number: 2, status: 'in_progress', started_at: '2026-10-25T10:00:00Z',
				ended_at: '2026-11-06T10:05:00Z', sessions: 12, seconds: 3600,
				max_percentage: 0.21, sources: ['web', 'koreader'] },
			{ number: 1, status: 'completed', started_at: '2026-03-07T10:00:00Z',
				ended_at: '2026-10-24T10:05:00Z', sessions: 19, seconds: 7200,
				max_percentage: 1, sources: ['web'] }
		],
		days: empty ? [] : [
			{ date: '2026-03-07', seconds: 120, sessions: 1, max_percentage: 0.1 },
			{ date: '2026-03-08', seconds: 600, sessions: 2, max_percentage: 0.5 },
			{ date: '2026-03-10', seconds: 300, sessions: 1, max_percentage: 0.25 }
		]
	};
}

async function mockApi(page: Page, count = 31, locale: 'en' | 'zh' = 'en'): Promise<Harness> {
	const state: Harness = {
		sessions: sessions(count), mutations: [], requests: [], failDelete: false,
		rejectManual: false, exportPageSize: 100, failNextSummary: false,
		failNextFirstPage: false, failNextMore: false, failNextExport: false
	};
	await page.route('**/api/v1/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.slice('/api/v1'.length);
		const method = request.method();
		state.requests.push({ method, path, query: url.search });
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: {
			user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale }
		} });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
		} });
		if (path === '/version') return route.fulfill({ json: {
			version: 'test', commit: 'test', commit_date: '2026-01-01', dirty: false, release: null
		} });
		if (path === '/shelves/system/unshelved' || path === '/shelves/system/favorites') {
			const key = path.split('/').at(-1);
			return route.fulfill({ json: { shelf: { id: key === 'favorites' ? 1 : 2, name: key, system_key: key, visible_book_count: 0 } } });
		}
		if (path === '/shelves') return route.fulfill({ json: { items: [], next_cursor: null } });
		if (path === '/books/21') return route.fulfill({ json: { book } });
		if (path === '/me/books/21') return route.fulfill({ json: {
			user_book: { status: 'reading', rating: null, started_at: '2026-03-07T10:00:00Z',
				finished_at: null, updated_at: '2026-03-07T10:00:00Z', rev: 1 },
			progress: null, highlights: [], bookmarks: [], notes: []
		} });
		if (path === '/me/books/21/reading-summary') {
			if (state.failNextSummary) {
				state.failNextSummary = false;
				return route.fulfill({ status: 503, json: { title: 'Unavailable', status: 503 } });
			}
			return route.fulfill({ json: { summary: summary(state.sessions) } });
		}
		if (path === '/me/books/21/sessions' && method === 'GET') {
			const selected = url.searchParams.get('range') === '30d' ? state.sessions.slice(0, 27) : state.sessions;
			const offset = Number(url.searchParams.get('cursor') ?? 0);
			const requested = Number(url.searchParams.get('limit') ?? 25);
			if (requested > 25 && state.failNextExport) {
				state.failNextExport = false;
				return route.fulfill({ status: 503, json: { title: 'Unavailable', status: 503 } });
			}
			if (requested <= 25 && offset === 0 && state.failNextFirstPage) {
				state.failNextFirstPage = false;
				return route.fulfill({ status: 503, json: { title: 'Unavailable', status: 503 } });
			}
			if (requested <= 25 && offset > 0 && state.failNextMore) {
				state.failNextMore = false;
				return route.fulfill({ status: 503, json: { title: 'Unavailable', status: 503 } });
			}
			const size = requested > 25 ? Math.min(requested, state.exportPageSize) : requested;
			const items = selected.slice(offset, offset + size);
			const next = offset + items.length;
			return route.fulfill({ json: {
				items, next_cursor: next < selected.length ? String(next) : null, total: selected.length
			} });
		}
		if (path.startsWith('/me/books/21/sessions/') && method === 'DELETE') {
			if (state.failDelete) {
				await new Promise((resolve) => setTimeout(resolve, 300));
				return route.fulfill({ status: 500, json: { title: 'Delete failed', status: 500 } });
			}
			const id = path.split('/').at(-1);
			state.sessions = state.sessions.filter((item) => item.id !== id);
			return route.fulfill({ status: 204 });
		}
		if (path === '/sync/push' && method === 'POST') {
			const payload = request.postDataJSON() as { mutations: Mutation[] };
			state.mutations.push(...payload.mutations);
			if (state.rejectManual) return route.fulfill({ json: {
				results: [{ index: 0, status: 'rejected', reason: 'session fields are invalid' }]
			} });
			for (const mutation of payload.mutations) {
				if (mutation.entity !== 'reading_sessions') continue;
				const start = Number(mutation.data.start_percentage);
				const end = Number(mutation.data.end_percentage);
				const hasStart = mutation.data.start_percentage !== null;
				const hasEnd = mutation.data.end_percentage !== null;
				state.sessions.push({
					id: mutation.id, source: 'web', device: String(mutation.data.device),
					started_at: new Date(Number(mutation.data.started_at)).toISOString(),
					ended_at: new Date(Number(mutation.data.ended_at)).toISOString(),
					active_seconds: Number(mutation.data.active_seconds),
					start_percentage: hasStart ? start : null, end_percentage: hasEnd ? end : null,
					change: hasStart && hasEnd ? end - start : null, attempt: 1
				});
				state.sessions.sort((a, b) => b.started_at.localeCompare(a.started_at));
			}
			return route.fulfill({ json: { results: payload.mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		return route.fulfill({ status: 404, json: { title: 'Unknown fixture endpoint', status: 404 } });
	});
	return state;
}

async function openLog(page: Page, query = '') {
	await page.goto(`/books/21/activities${query}`);
	await expect(page.getByRole('heading', { name: 'Reading summary' })).toBeVisible();
}

test('renders summary, timezone-aware sessions, filters and cursor pagination', async ({ page }) => {
	const state = await mockApi(page);
	await openLog(page);
	await expect(page.getByRole('img', { name: 'Reading progress: 21%' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reading status: Reading' })).toBeVisible();
	await expect(page.getByText('~5m to finish')).toBeVisible();
	await expect(page.getByText('3 of 4', { exact: true })).toBeVisible();
	await expect(page.getByText('14.2%/h').first()).toBeVisible();
	await expect(page.getByText('Showing 25 of 31')).toBeVisible();
	await expect(page.getByText(/Attempt 2 began/)).toBeVisible();
	await expect(page.getByRole('cell', { name: '-60%' })).toHaveClass(/text-amber-700/);
	await expect(page.getByRole('cell', { name: '+10%' }).first()).toHaveClass(/text-emerald-700/);
	expect(state.requests.find((item) => item.path.endsWith('/reading-summary'))?.query).toContain('timezone=');

	await page.getByRole('button', { name: 'Last 30 days' }).click();
	await expect(page).toHaveURL(/range=30d/);
	await expect(page.getByText('Showing 25 of 27')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(page.getByText('Showing 27 of 27')).toBeVisible();
	expect(state.requests.some((item) => item.path.endsWith('/sessions') && item.query.includes('cursor=25'))).toBe(true);
	await page.getByRole('button', { name: 'All time' }).click();
	await expect(page).toHaveURL(/range=all/);
	await expect(page.getByText('Showing 25 of 31')).toBeVisible();
});

test('optimistically deletes a session and rolls back a failed delete', async ({ page }) => {
	const state = await mockApi(page);
	await openLog(page);
	await expect(page.getByText('Showing 25 of 31')).toBeVisible();
	const first = page.getByRole('button', { name: /Delete session from/ }).first();
	const label = await first.getAttribute('aria-label');
	expect(label).toBeTruthy();
	state.failDelete = true;
	page.once('dialog', (dialog) => void dialog.accept());
	await first.click();
	await expect(page.getByRole('button', { name: label! })).toHaveCount(0);
	await expect(page.getByRole('alert')).toContainText('Could not delete the session. It has been restored.');
	await expect(page.getByRole('button', { name: label! })).toHaveCount(1);
	await expect(page.getByText('Showing 25 of 31')).toBeVisible();

	state.failDelete = false;
	page.once('dialog', (dialog) => void dialog.accept());
	await page.getByRole('button', { name: label! }).click();
	await expect.poll(() => state.requests.filter((item) => item.method === 'DELETE').length).toBe(2);
	await expect(page.getByRole('button', { name: label! })).toHaveCount(0);
	await expect(page.getByText('Showing 25 of 30')).toBeVisible();
});

test('does not insert an old optimistic row into a newly selected range', async ({ page }) => {
	const state = await mockApi(page);
	state.failDelete = true;
	await openLog(page);
	await expect(page.getByText('Showing 25 of 31')).toBeVisible();
	const first = page.getByRole('button', { name: /Delete session from/ }).first();
	const label = await first.getAttribute('aria-label');
	expect(label).toBeTruthy();
	page.once('dialog', (dialog) => void dialog.accept());
	await first.click();
	await page.getByRole('button', { name: 'Last 30 days' }).click();
	await expect(page.getByText('Showing 25 of 27')).toBeVisible();
	await expect(page.getByRole('alert')).toContainText('Please retry in its original range.');
	await expect(page.getByRole('button', { name: label! })).toHaveCount(1);
});

test('validates manual sessions, traps and restores focus, and pushes one backward session', async ({ page }) => {
	const state = await mockApi(page);
	await openLog(page);
	const add = page.getByRole('button', { name: 'Add session' });
	await add.click();
	let dialog = page.getByRole('dialog', { name: 'Add session' });
	await expect(dialog.getByLabel('Date', { exact: true })).toBeFocused();
	const today = await page.evaluate(() => {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	});
	await expect(dialog.getByLabel('Date', { exact: true })).toHaveValue(today);
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.getByRole('button', { name: 'Save session' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog.getByLabel('Date', { exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(add).toBeFocused();

	await add.click();
	dialog = page.getByRole('dialog', { name: 'Add session' });
	await dialog.getByLabel('Duration (minutes)').fill('0');
	await dialog.getByRole('button', { name: 'Save session' }).click();
	await expect(dialog.getByRole('alert')).toContainText('Duration must be a whole number');
	expect(state.mutations).toHaveLength(0);
	await dialog.getByLabel('Date', { exact: true }).fill('2020-06-01');
	await dialog.getByLabel('Start time').fill('09:00');
	await dialog.getByLabel('Duration (minutes)').fill('30');
	await dialog.getByLabel('Start % (optional)').fill('101');
	await dialog.getByRole('button', { name: 'Save session' }).click();
	await expect(dialog.getByRole('alert')).toContainText('Percentages must be between 0 and 100.');
	await dialog.getByLabel('Start % (optional)').fill('80');
	await dialog.getByLabel('End % (optional)').fill('20');
	await dialog.getByLabel('Date', { exact: true }).fill('2999-01-01');
	await dialog.getByRole('button', { name: 'Save session' }).click();
	await expect(dialog.getByRole('alert')).toContainText('A session cannot end in the future.');
	expect(state.mutations).toHaveLength(0);
	await dialog.getByLabel('Date', { exact: true }).fill('2020-06-01');
	await dialog.getByRole('button', { name: 'Save session' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(add).toBeFocused();
	await expect.poll(() => state.mutations.length).toBe(1);
	const mutation = state.mutations[0];
	expect(mutation.entity).toBe('reading_sessions');
	expect(mutation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	expect(mutation.data).toMatchObject({
		book_id: 21, source: 'web', device: 'Manual entry', active_seconds: 1800,
		start_percentage: 0.8, end_percentage: 0.2
	});
	expect(mutation.data.started_at).toBe(await page.evaluate(() => new Date('2020-06-01T09:00:00').getTime()));
	expect(Number(mutation.data.ended_at) - Number(mutation.data.started_at)).toBe(1_800_000);
	await expect(page.getByText('Showing 25 of 32')).toBeVisible();
});

test('shows rejected sync mutations inline without closing the dialog', async ({ page }) => {
	const state = await mockApi(page);
	state.rejectManual = true;
	await openLog(page);
	await page.getByRole('button', { name: 'Add session' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add session' });
	await dialog.getByLabel('Date', { exact: true }).fill('2020-06-01');
	await dialog.getByLabel('Start time').fill('09:00');
	await dialog.getByRole('button', { name: 'Save session' }).click();
	await expect(dialog.getByRole('alert')).toContainText('session fields are invalid');
	await expect(dialog).toBeVisible();
	expect(state.mutations).toHaveLength(1);
});

test('exports every page in the selected range as RFC 4180 CSV', async ({ page }) => {
	const state = await mockApi(page);
	state.exportPageSize = 10;
	await openLog(page, '?range=30d');
	await expect(page.getByText('Showing 25 of 27')).toBeVisible();
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export' }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('A Test Book reading log.csv');
	const csv = await readFile(await download.path(), 'utf8');
	expect(csv.startsWith('started_at,ended_at,active_seconds,start_percentage,end_percentage,change,source,device,attempt\r\n')).toBe(true);
	expect(csv).toContain('"Kobo, ""bedroom"""');
	expect(csv.trimEnd().split('\r\n')).toHaveLength(28);
	const exportRequests = state.requests.filter((item) =>
		item.path.endsWith('/sessions') && item.query.includes('limit=100'));
	expect(exportRequests.length).toBe(3);
	expect(exportRequests.every((item) => item.query.includes('range=30d'))).toBe(true);
});

test('caps export at exactly 10,000 sessions and reports the limit', async ({ page }) => {
	test.setTimeout(90_000);
	const state = await mockApi(page, 10_001);
	await openLog(page);
	await expect(page.getByText('Showing 25 of 10001')).toBeVisible();
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export' }).click();
	const download = await downloadPromise;
	const csv = await readFile(await download.path(), 'utf8');
	expect(csv.trimEnd().split('\r\n')).toHaveLength(10_001);
	await expect(page.getByText('Exported the first 10,000 sessions in this range.')).toBeVisible();
	expect(state.requests.filter((item) => item.path.endsWith('/sessions') && item.query.includes('limit=100'))).toHaveLength(100);
});

test('changes chart paths, exposes daily details and handles an empty book', async ({ page }) => {
	await mockApi(page);
	await openLog(page);
	const chart = page.getByRole('img', { name: /Reading progress over 3 active days/ });
	await expect(chart).toBeVisible();
	const path = page.getByTestId('bv8-chart-line');
	const curve = await path.getAttribute('d');
	await page.getByRole('button', { name: 'Trace', exact: true }).click();
	await expect(path).not.toHaveAttribute('d', curve!);
	await expect(page.getByRole('button', { name: 'Trace', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await chart.locator('[role=button]').first().focus();
	await expect(page.getByRole('status').filter({ hasText: 'Mar 7, 2026' })).toBeVisible();
	await chart.locator('[role=button]').first().blur();
	await chart.locator('[role=button]').nth(1).hover();
	await expect(page.getByRole('status').filter({ hasText: 'Mar 8, 2026' })).toBeVisible();
	await page.getByText('Show daily chart data').click();
	await expect(page.getByRole('table').last()).toContainText('Mar 8, 2026');
});

test('renders explicit empty and offline states and recovers after reconnecting', async ({ page, context }) => {
	await mockApi(page, 0);
	await openLog(page);
	await expect(page.getByText('No sessions in this range')).toBeVisible();
	await expect(page.getByText('No reading attempts yet.')).toBeVisible();
	await expect(page.getByText('No reading activity to chart yet.')).toBeVisible();
	await context.setOffline(true);
	await expect(page.getByText('Reading log needs a connection.')).toBeVisible();
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('Still offline. Reconnect and try again.')).toBeVisible();
	await expect(page.getByText('Reading log needs a connection.')).toBeVisible();
	await context.setOffline(false);
	await expect(page.getByRole('heading', { name: 'Reading summary' })).toBeVisible();
});

test('localizes the log and validation messages in Chinese', async ({ page }) => {
	await mockApi(page, 0, 'zh');
	await page.goto('/books/21/activities');
	await expect(page.getByRole('heading', { name: '阅读概况' })).toBeVisible();
	await expect(page.getByText('此范围内没有阅读记录')).toBeVisible();
	await page.getByRole('button', { name: '添加阅读记录' }).click();
	const dialog = page.getByRole('dialog', { name: '添加阅读记录' });
	await dialog.getByLabel('时长（分钟）').fill('0');
	await dialog.getByRole('button', { name: '保存记录' }).click();
	await expect(dialog.getByRole('alert')).toContainText('时长必须是 1 到 1440 分钟的整数。');
});

test('exposes and retries summary, session-page and export errors', async ({ page }) => {
	const state = await mockApi(page);
	state.failNextSummary = true;
	state.failNextFirstPage = true;
	await page.goto('/books/21/activities');
	await expect(page.getByRole('alert').filter({ hasText: 'Could not load the reading log.' })).toBeVisible();
	await page.getByRole('button', { name: 'Try again' }).click();
	const table = page.getByRole('region', { name: 'Sessions', exact: true });
	await expect(table.getByRole('alert')).toContainText('Could not load sessions.');
	await table.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('Showing 25 of 31')).toBeVisible();

	state.failNextMore = true;
	await table.getByRole('button', { name: 'Load more' }).click();
	await expect(table.getByRole('alert')).toContainText('Could not load more sessions.');
	await table.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('Showing 31 of 31')).toBeVisible();

	state.failNextExport = true;
	await table.getByRole('button', { name: 'Export' }).click();
	await expect(table.getByRole('alert')).toContainText('Could not export sessions.');
});

test('refreshes for the matching book-state event only', async ({ page }) => {
	const state = await mockApi(page);
	await openLog(page);
	await expect(page.getByText('Showing 25 of 31')).toBeVisible();
	const count = () => state.requests.filter((item) => item.path.endsWith('/reading-summary')).length;
	const before = count();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 99 } })));
	await page.waitForTimeout(150);
	expect(count()).toBe(before);
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandalibrary-book-state-changed', { detail: { bookId: 21 } })));
	await expect.poll(count).toBeGreaterThan(before);
});

test('normalizes an unknown range in the URL', async ({ page }) => {
	await mockApi(page);
	await openLog(page, '?range=unknown');
	await expect(page).toHaveURL(/range=all/);
	await expect(page.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByText('Showing 25 of 31')).toBeVisible();
});

test.describe('daylight-saving time', () => {
	test.use({ timezoneId: 'America/New_York' });

	test('sends the viewer timezone and rejects a nonexistent local start time', async ({ page }) => {
		const state = await mockApi(page);
		await openLog(page);
		expect(state.requests.find((item) => item.path.endsWith('/reading-summary'))?.query)
			.toContain('timezone=America%2FNew_York');
		await page.getByRole('button', { name: 'Add session' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add session' });
		await dialog.getByLabel('Date', { exact: true }).fill('2026-03-08');
		await dialog.getByLabel('Start time').fill('02:30');
		await dialog.getByRole('button', { name: 'Save session' }).click();
		await expect(dialog.getByRole('alert')).toContainText('Enter a valid date and start time.');
		expect(state.mutations).toHaveLength(0);
	});
});

test('keeps the page within a 390px viewport while the table scrolls internally', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockApi(page);
	await openLog(page);
	await expect(page.getByText('Showing 25 of 31')).toBeVisible();
	const chart = page.getByRole('img', { name: /Reading progress over 3 active days/ });
	await chart.locator('[role=button]').last().focus();
	const tooltip = page.getByRole('status').filter({ hasText: 'Mar 10, 2026' });
	await expect(tooltip).toBeVisible();
	expect((await tooltip.boundingBox())?.width).toBeGreaterThan(150);
	expect((await chart.locator('text').filter({ hasText: /^100%$/ }).boundingBox())?.width)
		.toBeGreaterThan(18);
	const viewBoxWidth = () => chart.evaluate((element) => {
		const viewBox = element.getAttribute('viewBox');
		if (!viewBox) throw new Error('Chart viewBox is missing');
		return Number(viewBox.split(' ')[2]);
	});
	const narrowWidth = await viewBoxWidth();
	await page.setViewportSize({ width: 600, height: 844 });
	await expect.poll(viewBoxWidth).toBeGreaterThan(narrowWidth + 100);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect.poll(viewBoxWidth).toBe(narrowWidth);
	const sizes = await page.evaluate(() => {
		const table = document.querySelector('table');
		const container = table?.parentElement;
		return {
			pageWidth: document.documentElement.scrollWidth,
			viewportWidth: document.documentElement.clientWidth,
			tableWidth: container?.scrollWidth ?? 0,
			containerWidth: container?.clientWidth ?? 0
		};
	});
	expect(sizes.pageWidth).toBeLessThanOrEqual(sizes.viewportWidth);
	expect(sizes.tableWidth).toBeGreaterThan(sizes.containerWidth);
});
