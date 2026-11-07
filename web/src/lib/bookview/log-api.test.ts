import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => {
	const mock = vi.fn<typeof fetch>();
	globalThis.fetch = mock;
	return mock;
});

import { ApiError } from '#lib/api/client.js';
import { SyncError } from '#lib/reader/api.js';
import {
	addManualSession,
	buildBookSessionsPath,
	buildReadingSummaryPath,
	deleteBookSession,
	getReadingSummary,
	listBookSessions,
	viewerTimezone,
	type ReadingSummary
} from './log-api.js';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status: number, detail: string) =>
	new Response(JSON.stringify({ status, detail }), {
		status,
		headers: { 'content-type': 'application/problem+json' }
	});

function lastCall(): { url: string; init: RequestInit } {
	const [url, init] = fetchMock.mock.lastCall ?? [];
	return { url: String(url), init: init ?? {} };
}

const summary: ReadingSummary = {
	progress: 0.21,
	sessions: 2,
	total_seconds: 120,
	average_seconds: 60,
	active_days: 1,
	span_days: 1,
	first_read_at: '2026-05-21T10:00:00Z',
	last_read_at: '2026-05-21T10:05:00Z',
	pace_percent_per_hour: 14.2,
	estimated_seconds_left: 300,
	records: {
		longest_session: { seconds: 60, date: '2026-05-21' },
		best_day: { seconds: 120, date: '2026-05-21' },
		longest_streak_days: 1
	},
	attempts: [
		{
			number: 1,
			status: 'in_progress',
			started_at: '2026-05-21T10:00:00Z',
			ended_at: '2026-05-21T10:05:00Z',
			sessions: 2,
			seconds: 120,
			max_percentage: 0.21,
			sources: ['web']
		}
	],
	days: [{ date: '2026-05-21', seconds: 120, sessions: 2, max_percentage: 0.21 }]
};

afterEach(() => {
	fetchMock.mockReset();
	vi.restoreAllMocks();
});

describe('viewerTimezone', () => {
	it('returns the resolved IANA zone and falls back to UTC', () => {
		const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
		resolved.mockReturnValue({ timeZone: 'Asia/Shanghai' } as Intl.ResolvedDateTimeFormatOptions);
		expect(viewerTimezone()).toBe('Asia/Shanghai');
		resolved.mockReturnValue({ timeZone: '' } as Intl.ResolvedDateTimeFormatOptions);
		expect(viewerTimezone()).toBe('UTC');
		resolved.mockImplementation(() => {
			throw new RangeError('no zone');
		});
		expect(viewerTimezone()).toBe('UTC');
	});
});

describe('reading log paths', () => {
	it('encodes the timezone, range, limit and cursor', () => {
		expect(buildReadingSummaryPath(7, 'America/New_York')).toBe(
			'/me/books/7/reading-summary?timezone=America%2FNew_York'
		);
		expect(buildBookSessionsPath(7, { timezone: 'UTC' })).toBe('/me/books/7/sessions?range=all&timezone=UTC');
		expect(buildBookSessionsPath(7, { range: 'year', limit: 50, cursor: 'a+b/c', timezone: 'Asia/Tokyo' })).toBe(
			'/me/books/7/sessions?range=year&timezone=Asia%2FTokyo&limit=50&cursor=a%2Bb%2Fc'
		);
		expect(() => buildBookSessionsPath(0)).toThrow(RangeError);
		expect(() => buildReadingSummaryPath(1.5, 'UTC')).toThrow(RangeError);
	});
});

describe('reading log requests', () => {
	it('loads and unwraps the summary', async () => {
		fetchMock.mockResolvedValueOnce(json({ summary }));
		const controller = new AbortController();
		await expect(getReadingSummary(3, { timezone: 'Europe/Paris', signal: controller.signal })).resolves.toEqual(
			summary
		);
		const { url, init } = lastCall();
		expect(url).toBe('/api/v1/me/books/3/reading-summary?timezone=Europe%2FParis');
		expect(init.signal).toBe(controller.signal);
		expect(init.cache).toBe('no-store');
	});

	it('defaults the summary timezone to the viewer zone', async () => {
		vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
			timeZone: 'Asia/Shanghai'
		} as Intl.ResolvedDateTimeFormatOptions);
		fetchMock.mockResolvedValueOnce(json({ summary }));
		await getReadingSummary(3);
		expect(lastCall().url).toBe('/api/v1/me/books/3/reading-summary?timezone=Asia%2FShanghai');
	});

	it('lists a sessions page with its total and cursor', async () => {
		const page = {
			items: [
				{
					id: '018f0f7e-7b00-7000-8000-000000000001',
					source: 'koreader',
					device: 'Kobo',
					started_at: '2026-05-21T10:00:00Z',
					ended_at: '2026-05-21T10:05:00Z',
					active_seconds: 300,
					start_percentage: null,
					end_percentage: 0.4,
					change: null,
					attempt: 2
				}
			],
			next_cursor: 'next',
			total: 31
		};
		fetchMock.mockResolvedValueOnce(json(page));
		await expect(
			listBookSessions(3, { range: '30d', cursor: 'abc', limit: 10, timezone: 'UTC' })
		).resolves.toEqual(page);
		expect(lastCall().url).toBe('/api/v1/me/books/3/sessions?range=30d&timezone=UTC&limit=10&cursor=abc');
		expect(lastCall().init.cache).toBe('no-store');
	});

	it('maps problem responses to ApiError', async () => {
		fetchMock.mockResolvedValueOnce(problem(400, 'cursor does not match this list'));
		const error = await listBookSessions(3, { cursor: 'old', timezone: 'UTC' }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 400, message: 'cursor does not match this list' });
	});

	it('deletes a session and accepts the empty 204 response', async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await expect(deleteBookSession(3, '018f0f7e-7b00-7000-8000-000000000001')).resolves.toBeUndefined();
		const { url, init } = lastCall();
		expect(url).toBe('/api/v1/me/books/3/sessions/018f0f7e-7b00-7000-8000-000000000001');
		expect(init.method).toBe('DELETE');

		fetchMock.mockResolvedValueOnce(problem(404, 'Not Found'));
		await expect(deleteBookSession(3, 'a/b')).rejects.toMatchObject({ name: 'ApiError', status: 404 });
		expect(lastCall().url).toBe('/api/v1/me/books/3/sessions/a%2Fb');
	});

	it('pushes a manual session as a reading_sessions upsert', async () => {
		fetchMock.mockResolvedValueOnce(json({ results: [{ index: 0, status: 'applied' }] }));
		const id = await addManualSession(3, {
			startedAt: new Date('2026-05-21T10:00:00Z'),
			endedAt: Date.parse('2026-05-21T10:30:00Z'),
			activeSeconds: 1500.7,
			startPercentage: 0.1,
			endPercentage: 0.2
		});
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const { url, init } = lastCall();
		expect(url).toBe('/api/v1/sync/push');
		expect(init.method).toBe('POST');
		expect(JSON.parse(String(init.body))).toEqual({
			mutations: [
				{
					entity: 'reading_sessions',
					id,
					op: 'upsert',
					updated_at: Date.parse('2026-05-21T10:30:00Z'),
					data: {
						book_id: 3,
						source: 'web',
						device: 'Manual entry',
						started_at: Date.parse('2026-05-21T10:00:00Z'),
						ended_at: Date.parse('2026-05-21T10:30:00Z'),
						active_seconds: 1500,
						start_percentage: 0.1,
						end_percentage: 0.2
					}
				}
			]
		});
	});

	it('surfaces a rejected manual session', async () => {
		fetchMock.mockResolvedValueOnce(
			json({ results: [{ index: 0, status: 'rejected', reason: 'session fields are invalid' }] })
		);
		const error = await addManualSession(3, { startedAt: 2, endedAt: 1, activeSeconds: 1 }).catch(
			(e: unknown) => e
		);
		expect(error).toBeInstanceOf(SyncError);
		expect(JSON.parse(String(lastCall().init.body)).mutations[0].data).toMatchObject({
			start_percentage: null,
			end_percentage: null
		});
	});
});
