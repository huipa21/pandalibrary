import type { Attempt, BookSession, SessionSource } from '../log-api.js';

export interface CycleDetail {
	readonly attempt: Attempt;
	/** Newest first, as returned by the API. */
	readonly sessions: readonly BookSession[];
	readonly averageSeconds: number;
	readonly activeDays: number;
}

export interface CyclesOverview {
	readonly cycles: number;
	readonly completed: number;
	readonly sessions: number;
	readonly totalSeconds: number;
	readonly averageSeconds: number;
	readonly activeDays: number;
	readonly bestProgress: number | null;
}

export interface SessionPage {
	readonly items: readonly BookSession[];
	readonly next_cursor: string | null;
}

/** Follows cursors until the end; guards against empty or repeating pages from a misbehaving server. */
export async function collectAllSessions(
	fetchPage: (cursor: string | null) => Promise<SessionPage>
): Promise<BookSession[]> {
	const sessions: BookSession[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	do {
		const page = await fetchPage(cursor);
		sessions.push(...page.items);
		cursor = page.next_cursor;
		if (cursor && page.items.length === 0) throw new Error('A session page was empty before the end.');
		if (cursor && seen.has(cursor)) throw new Error('The session cursor repeated.');
		if (cursor) seen.add(cursor);
	} while (cursor);
	return sessions;
}

function dayFormatter(timezone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat('en-CA-u-nu-latn', {
		timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
	});
}

function distinctDays(sessions: readonly BookSession[], formatter: Intl.DateTimeFormat): Set<string> {
	const days = new Set<string>();
	for (const session of sessions) {
		const date = new Date(session.started_at);
		if (Number.isFinite(date.getTime())) days.add(formatter.format(date));
	}
	return days;
}

function average(seconds: number, sessions: number): number {
	return sessions > 0 ? Math.round(seconds / sessions) : 0;
}

/** A cycle the summary does not know yet (e.g. a session added between requests). */
function syntheticAttempt(number: number, sessions: readonly BookSession[], newest: boolean): Attempt {
	const sources: SessionSource[] = [];
	let maxPercentage: number | null = null;
	for (const session of sessions) {
		if (!sources.includes(session.source)) sources.push(session.source);
		if (session.end_percentage !== null) maxPercentage = Math.max(maxPercentage ?? 0, session.end_percentage);
	}
	return {
		number,
		status: newest ? 'in_progress' : 'stopped',
		started_at: sessions.at(-1)!.started_at,
		ended_at: sessions[0].ended_at,
		sessions: sessions.length,
		seconds: sessions.reduce((sum, session) => sum + session.active_seconds, 0),
		max_percentage: maxPercentage,
		sources
	};
}

/** Pairs each cycle (newest first) with its sessions, grouped by `session.attempt`. */
export function buildCycleDetails(
	attempts: readonly Attempt[],
	sessions: readonly BookSession[],
	timezone: string
): CycleDetail[] {
	const byCycle = new Map<number, BookSession[]>();
	for (const session of sessions) {
		const list = byCycle.get(session.attempt);
		if (list) list.push(session);
		else byCycle.set(session.attempt, [session]);
	}
	const known = new Map(attempts.map((attempt) => [attempt.number, attempt]));
	const newest = Math.max(0, ...attempts.map((attempt) => attempt.number), ...byCycle.keys());
	for (const [number, list] of byCycle) {
		if (!known.has(number)) known.set(number, syntheticAttempt(number, list, number === newest));
	}
	const formatter = dayFormatter(timezone);
	return [...known.values()]
		.sort((a, b) => b.number - a.number)
		.map((attempt) => {
			const cycleSessions = [...(byCycle.get(attempt.number) ?? [])]
				.sort((a, b) => b.started_at.localeCompare(a.started_at));
			return {
				attempt,
				sessions: cycleSessions,
				averageSeconds: average(attempt.seconds, attempt.sessions),
				activeDays: distinctDays(cycleSessions, formatter).size
			};
		});
}

export function cyclesOverview(cycles: readonly CycleDetail[], timezone: string): CyclesOverview {
	let sessions = 0;
	let totalSeconds = 0;
	let completed = 0;
	let bestProgress: number | null = null;
	for (const { attempt } of cycles) {
		sessions += attempt.sessions;
		totalSeconds += attempt.seconds;
		if (attempt.status === 'completed') completed += 1;
		if (attempt.max_percentage !== null) bestProgress = Math.max(bestProgress ?? 0, attempt.max_percentage);
	}
	return {
		cycles: cycles.length,
		completed,
		sessions,
		totalSeconds,
		averageSeconds: average(totalSeconds, sessions),
		activeDays: distinctDays(cycles.flatMap((cycle) => cycle.sessions), dayFormatter(timezone)).size,
		bestProgress
	};
}
