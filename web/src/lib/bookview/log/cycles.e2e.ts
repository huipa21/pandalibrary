import { expect, test, type Page } from '@playwright/test';
import type { BookSession, ReadingSummary } from '../log-api.js';

const book = {
	id: 21, library_id: 1, title: 'A Test Book', sort_title: 'A Test Book',
	subtitle: null, description: null, language: 'en', publisher: null, published_date: null,
	page_count: null, cover_url: null, cover_source: null, authors: [], series: null, tags: [],
	identifiers: [], files: [], field_sources: [], created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z'
};

/** 150 sessions newest first: the newest 120 belong to cycle 3, then 20 to cycle 2 and 10 to cycle 1. */
function sessions(): BookSession[] {
	return Array.from({ length: 150 }, (_, index) => {
		const start = Date.UTC(2026, 10, 6, 10) - index * 86_400_000;
		return {
			id: `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
			started_at: new Date(start).toISOString(),
			ended_at: new Date(start + 600_000).toISOString(),
			active_seconds: 600, start_percentage: 0.1, end_percentage: 0.2, change: 0.1,
			source: index % 2 ? 'web' : 'koreader', device: 'Browser',
			attempt: index < 120 ? 3 : index < 140 ? 2 : 1
		};
	});
}

function summary(): ReadingSummary {
	return {
		progress: 0.2, sessions: 150, total_seconds: 90_000, average_seconds: 600, active_days: 150, span_days: 150,
		first_read_at: '2026-06-10T10:00:00Z', last_read_at: '2026-11-06T10:10:00Z',
		pace_percent_per_hour: 10, estimated_seconds_left: 3600,
		records: { longest_session: null, best_day: null, longest_streak_days: 0 },
		attempts: [
			{ number: 3, status: 'in_progress', started_at: '2026-07-10T10:00:00Z', ended_at: '2026-11-06T10:10:00Z',
				sessions: 120, seconds: 72_000, max_percentage: 0.2, sources: ['web', 'koreader'] },
			{ number: 2, status: 'stopped', started_at: '2026-06-20T10:00:00Z', ended_at: '2026-07-09T10:10:00Z',
				sessions: 20, seconds: 12_000, max_percentage: 0.2, sources: ['web', 'koreader'] },
			{ number: 1, status: 'completed', outcome: 'finished', started_at: '2026-06-10T10:00:00Z',
				ended_at: '2026-06-19T10:10:00Z', sessions: 10, seconds: 6000, max_percentage: 1, sources: ['koreader'] }
		],
		days: []
	};
}

async function mockApi(page: Page): Promise<{ sessionRequests: URLSearchParams[] }> {
	const all = sessions();
	const state = { sessionRequests: [] as URLSearchParams[] };
	await page.route('**/api/v1/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: {
			user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' }
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
			user_book: { status: 'reading', rating: null, started_at: '2026-06-10T10:00:00Z',
				finished_at: null, updated_at: '2026-06-10T10:00:00Z', rev: 1 },
			progress: null, highlights: [], bookmarks: [], notes: []
		} });
		if (path === '/me/books/21/reading-summary') return route.fulfill({ json: { summary: summary() } });
		if (path === '/me/books/21/sessions') {
			state.sessionRequests.push(url.searchParams);
			const offset = Number(url.searchParams.get('cursor') ?? 0);
			const size = Math.min(100, Number(url.searchParams.get('limit') ?? 25));
			const items = all.slice(offset, offset + size);
			const next = offset + items.length;
			return route.fulfill({ json: { items, next_cursor: next < all.length ? String(next) : null, total: all.length } });
		}
		return route.fulfill({ status: 404, json: { title: 'Unknown fixture endpoint', status: 404 } });
	});
	return state;
}

test('the reading cycles card shows only the latest cycle and links to the cycles page', async ({ page }) => {
	await mockApi(page);
	await page.goto('/books/21/activities');
	const card = page.getByRole('region', { name: 'Reading cycles 3' });
	await expect(card).toBeVisible();
	await expect(card.getByText('Cycle 3 · In progress', { exact: true })).toBeVisible();
	await expect(card.getByText('Cycle 2 · Stopped')).toHaveCount(0);
	await expect(card.getByText('Read once · Read')).toHaveCount(0);
	await expect(card.getByRole('link')).toHaveCount(1);
	await expect(card.locator('a[href="/stats"]')).toHaveCount(0);

	await card.getByRole('link', { name: 'Open reading cycle details' }).click();
	await expect(page).toHaveURL(/\/books\/21\/activities\/cycles$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Reading cycles' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Activities', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('the cycles page lists every cycle with its sessions', async ({ page }) => {
	const state = await mockApi(page);
	await page.goto('/books/21/activities/cycles');
	const overview = page.getByRole('region', { name: 'Cycle overview' });
	await expect(overview).toBeVisible();
	const stat = (label: string) => overview.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
	await expect(stat('Cycles')).toHaveText('3');
	await expect(stat('Completed cycles')).toHaveText('1');
	await expect(stat('Sessions')).toHaveText('150');
	await expect(stat('Total time')).toHaveText('25h');
	await expect(stat('Furthest reached')).toHaveText('100%');

	const headings = page.locator('ol > li > section h2');
	await expect(headings).toHaveText(['Cycle 3 · In progress', 'Cycle 2 · Stopped', 'Read once · Read']);
	await expect(page.getByRole('table', { name: 'Sessions in cycle 3' }).locator('tbody tr')).toHaveCount(120);
	await expect(page.getByRole('table', { name: 'Sessions in cycle 2' }).locator('tbody tr')).toHaveCount(20);
	const first = page.getByRole('region', { name: 'Read once · Read' });
	await expect(first.getByRole('table', { name: 'Sessions in cycle 1' }).locator('tbody tr')).toHaveCount(10);
	await expect(first.locator('dl > div').filter({ has: page.getByText('Active days', { exact: true }) }).locator('dd')).toHaveText('10');
	await expect(first.getByText('10% to 20%').first()).toBeVisible();
	expect(state.sessionRequests.map((query) => [query.get('range'), query.get('limit'), query.get('cursor')]))
		.toEqual([['all', '100', null], ['all', '100', '100']]);

	await page.getByRole('link', { name: 'Back to Activities' }).click();
	await expect(page).toHaveURL(/\/books\/21\/activities$/);
	await expect(page.getByRole('heading', { name: 'Reading summary' })).toBeVisible();
});
