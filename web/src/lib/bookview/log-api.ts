import { v7 as uuidv7 } from 'uuid';
import { api, createApiClient } from '#lib/api/client.js';
import type { Page } from '#lib/catalog/types.js';
import { pushMutation } from '#lib/reader/api.js';

export type SessionRange = 'all' | '30d' | '90d' | 'year';
export type AttemptStatus = 'completed' | 'in_progress' | 'stopped';
export type SessionSource = 'web' | 'koreader';

export interface Attempt {
	readonly number: number;
	readonly status: AttemptStatus;
	readonly started_at: string;
	readonly ended_at: string;
	readonly sessions: number;
	readonly seconds: number;
	readonly max_percentage: number | null;
	readonly sources: readonly SessionSource[];
}

export interface DayRecord {
	readonly seconds: number;
	readonly date: string;
}

export interface ReadingRecords {
	readonly longest_session: DayRecord | null;
	readonly best_day: DayRecord | null;
	readonly longest_streak_days: number;
}

export interface ReadingDay {
	readonly date: string;
	readonly seconds: number;
	readonly sessions: number;
	readonly max_percentage: number | null;
}

export interface ReadingSummary {
	readonly progress: number;
	readonly sessions: number;
	readonly total_seconds: number;
	readonly average_seconds: number;
	readonly active_days: number;
	readonly span_days: number;
	readonly first_read_at: string | null;
	readonly last_read_at: string | null;
	readonly pace_percent_per_hour: number | null;
	readonly estimated_seconds_left: number | null;
	readonly records: ReadingRecords;
	/** Newest first. */
	readonly attempts: readonly Attempt[];
	/** Active local days, ascending. */
	readonly days: readonly ReadingDay[];
}

export interface BookSession {
	readonly id: string;
	readonly source: SessionSource;
	readonly device: string;
	readonly started_at: string;
	readonly ended_at: string;
	readonly active_seconds: number;
	readonly start_percentage: number | null;
	readonly end_percentage: number | null;
	readonly change: number | null;
	readonly attempt: number;
}

export type BookSessionsPage = Page<BookSession> & { readonly total: number };

export interface ManualSession {
	readonly startedAt: number | Date;
	readonly endedAt: number | Date;
	readonly activeSeconds: number;
	readonly startPercentage?: number | null;
	readonly endPercentage?: number | null;
}

export interface SessionsQuery {
	readonly range?: SessionRange;
	readonly cursor?: string | null;
	readonly limit?: number;
	readonly timezone?: string;
}

export const MANUAL_SESSION_DEVICE = 'Manual entry';

/** The viewer's resolved IANA zone; the server buckets local days with it. */
export function viewerTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

function bookPath(bookId: number): string {
	if (!Number.isSafeInteger(bookId) || bookId < 1) throw new RangeError(`Invalid book ID: ${bookId}`);
	return `/me/books/${bookId}`;
}

export function buildReadingSummaryPath(bookId: number, timezone = viewerTimezone()): string {
	return `${bookPath(bookId)}/reading-summary?${new URLSearchParams({ timezone })}`;
}

export function buildBookSessionsPath(
	bookId: number,
	{ range = 'all', cursor, limit, timezone = viewerTimezone() }: SessionsQuery = {}
): string {
	const query = new URLSearchParams({ range, timezone });
	if (limit !== undefined) query.set('limit', String(limit));
	if (cursor) query.set('cursor', cursor);
	return `${bookPath(bookId)}/sessions?${query}`;
}

export async function getReadingSummary(
	bookId: number,
	{ timezone, signal }: { timezone?: string; signal?: AbortSignal } = {}
): Promise<ReadingSummary> {
	const response = await api.request<{ summary: ReadingSummary }>(buildReadingSummaryPath(bookId, timezone), {
		signal,
		cache: 'no-store'
	});
	return response.summary;
}

export function listBookSessions(
	bookId: number,
	{ signal, ...query }: SessionsQuery & { signal?: AbortSignal } = {}
): Promise<BookSessionsPage> {
	return api.request(buildBookSessionsPath(bookId, query), { signal, cache: 'no-store' });
}

// The shared client always parses JSON, so a 204 is mapped to a JSON null body.
const noContentClient = createApiClient({
	fetcher: async (input, init) => {
		const response = await fetch(input, init);
		return response.status === 204
			? new Response('null', { headers: { 'content-type': 'application/json' } })
			: response;
	}
});

export async function deleteBookSession(bookId: number, sessionId: string): Promise<void> {
	await noContentClient.request<null>(`${bookPath(bookId)}/sessions/${encodeURIComponent(sessionId)}`, {
		method: 'DELETE'
	});
}

function epochMs(value: number | Date): number {
	return value instanceof Date ? value.getTime() : value;
}

/** Records a manual session through the append-only `/sync/push` path and returns its ID. */
export async function addManualSession(bookId: number, session: ManualSession): Promise<string> {
	bookPath(bookId);
	const id = uuidv7();
	const endedAt = epochMs(session.endedAt);
	await pushMutation({
		entity: 'reading_sessions',
		id,
		op: 'upsert',
		updated_at: endedAt,
		data: {
			book_id: bookId,
			source: 'web',
			device: MANUAL_SESSION_DEVICE,
			started_at: epochMs(session.startedAt),
			ended_at: endedAt,
			active_seconds: Math.max(0, Math.floor(session.activeSeconds)),
			start_percentage: session.startPercentage ?? null,
			end_percentage: session.endPercentage ?? null
		}
	});
	return id;
}
