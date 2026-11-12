import { describe, expect, it } from 'vitest';
import type { Attempt, BookSession } from '../log-api.js';
import { buildCycleDetails, collectAllSessions, cyclesOverview } from './cycles-model.js';

function session(id: number, startedAt: string, attempt: number, overrides: Partial<BookSession> = {}): BookSession {
	const start = new Date(startedAt).getTime();
	return {
		id: `s${id}`, source: 'web', device: 'Browser', started_at: startedAt,
		ended_at: new Date(start + 600_000).toISOString(), active_seconds: 600,
		start_percentage: 0.1, end_percentage: 0.2, change: 0.1, attempt, ...overrides
	};
}

const attempts: Attempt[] = [
	{ number: 2, status: 'in_progress', started_at: '2026-10-01T10:00:00Z', ended_at: '2026-10-03T10:10:00Z',
		sessions: 3, seconds: 1800, max_percentage: 0.4, sources: ['web'] },
	{ number: 1, status: 'completed', outcome: 'finished', started_at: '2026-03-01T10:00:00Z',
		ended_at: '2026-03-02T10:10:00Z', sessions: 2, seconds: 1000, max_percentage: 1, sources: ['koreader'] }
];

const sessions = [
	session(5, '2026-10-03T10:00:00Z', 2),
	session(4, '2026-10-01T23:30:00Z', 2),
	session(3, '2026-10-01T10:00:00Z', 2),
	session(2, '2026-03-02T10:00:00Z', 1),
	session(1, '2026-03-01T10:00:00Z', 1)
];

describe('buildCycleDetails', () => {
	it('groups sessions by cycle, newest cycle first', () => {
		const cycles = buildCycleDetails(attempts, sessions, 'UTC');
		expect(cycles.map((cycle) => cycle.attempt.number)).toEqual([2, 1]);
		expect(cycles[0].sessions.map((item) => item.id)).toEqual(['s5', 's4', 's3']);
		expect(cycles[1].sessions.map((item) => item.id)).toEqual(['s2', 's1']);
		expect(cycles[0].averageSeconds).toBe(600);
		expect(cycles[1].averageSeconds).toBe(500);
	});

	it('counts active days in the viewer time zone', () => {
		expect(buildCycleDetails(attempts, sessions, 'UTC')[0].activeDays).toBe(2);
		// 23:30 UTC on Oct 1 is Oct 2 in Shanghai.
		expect(buildCycleDetails(attempts, sessions, 'Asia/Shanghai')[0].activeDays).toBe(3);
	});

	it('keeps cycles without loaded sessions and synthesizes unknown ones', () => {
		const extra = session(6, '2026-11-01T10:00:00Z', 3, { source: 'koreader', end_percentage: 0.05 });
		const cycles = buildCycleDetails(attempts, [extra, ...sessions.slice(3)], 'UTC');
		expect(cycles.map((cycle) => cycle.attempt.number)).toEqual([3, 2, 1]);
		expect(cycles[0].attempt).toMatchObject({
			status: 'in_progress', sessions: 1, seconds: 600, max_percentage: 0.05, sources: ['koreader']
		});
		expect(cycles[1].sessions).toEqual([]);
		expect(cycles[1].activeDays).toBe(0);
	});
});

describe('cyclesOverview', () => {
	it('totals the cycles', () => {
		expect(cyclesOverview(buildCycleDetails(attempts, sessions, 'UTC'), 'UTC')).toEqual({
			cycles: 2, completed: 1, sessions: 5, totalSeconds: 2800, averageSeconds: 560,
			activeDays: 4, bestProgress: 1
		});
	});

	it('handles no cycles', () => {
		expect(cyclesOverview([], 'UTC')).toEqual({
			cycles: 0, completed: 0, sessions: 0, totalSeconds: 0, averageSeconds: 0, activeDays: 0, bestProgress: null
		});
	});
});

describe('collectAllSessions', () => {
	it('follows cursors to the end', async () => {
		const cursors: Array<string | null> = [];
		const result = await collectAllSessions(async (cursor) => {
			cursors.push(cursor);
			const offset = Number(cursor ?? 0);
			const next = offset + 2;
			return { items: sessions.slice(offset, next), next_cursor: next < sessions.length ? String(next) : null };
		});
		expect(cursors).toEqual([null, '2', '4']);
		expect(result.map((item) => item.id)).toEqual(['s5', 's4', 's3', 's2', 's1']);
	});

	it('rejects repeating or empty pages', async () => {
		await expect(collectAllSessions(async () => ({ items: sessions.slice(0, 1), next_cursor: 'same' })))
			.rejects.toThrow('repeated');
		await expect(collectAllSessions(async () => ({ items: [], next_cursor: 'x' }))).rejects.toThrow('empty');
	});
});
