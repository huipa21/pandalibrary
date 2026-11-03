import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mutation } from './api.js';
import { IDLE_MS, ReadingSessions, SessionWriter } from './sessions.js';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
});

afterEach(() => vi.useRealTimers());

describe('reading session lifecycle', () => {
	it('drops sessions shorter than 30 seconds and records the exact active duration at 30 seconds', () => {
		const completed = vi.fn();
		const clock = new ReadingSessions(7, () => 0.4, completed);
		clock.start();
		vi.advanceTimersByTime(29999);
		clock.stop();
		expect(completed).not.toHaveBeenCalled();
		clock.start();
		vi.advanceTimersByTime(30000);
		clock.stop();
		expect(completed).toHaveBeenCalledOnce();
		expect(completed.mock.calls[0][0]).toMatchObject({
			entity: 'reading_sessions',
			op: 'upsert',
			data: { book_id: 7, active_seconds: 30, source: 'web', start_percentage: 0.4, end_percentage: 0.4 }
		});
	});

	it('closes after five minutes idle and starts a separate session when activity resumes', () => {
		const completed = vi.fn();
		const clock = new ReadingSessions(7, () => 0.2, completed);
		clock.start();
		vi.advanceTimersByTime(IDLE_MS + 120000);
		expect(completed).toHaveBeenCalledOnce();
		expect(completed.mock.calls[0][0].data.active_seconds).toBe(300);
		clock.activity();
		vi.advanceTimersByTime(45000);
		clock.stop();
		expect(completed).toHaveBeenCalledTimes(2);
		expect(completed.mock.calls[1][0].data.active_seconds).toBe(45);
	});

	it('does not count time while hidden between stop and start', () => {
		const completed = vi.fn();
		const clock = new ReadingSessions(7, () => 0.2, completed);
		clock.start();
		vi.advanceTimersByTime(40000);
		clock.stop();
		vi.advanceTimersByTime(120000);
		clock.start();
		vi.advanceTimersByTime(35000);
		clock.stop();
		expect(completed.mock.calls.map(([mutation]) => mutation.data.active_seconds)).toEqual([40, 35]);
	});

	it('retains failed session writes and retries with the same id', async () => {
		const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
		const onError = vi.fn();
		const writer = new SessionWriter(onError, send);
		const mutation: Mutation = { entity: 'reading_sessions', id: 'same-id', op: 'upsert', data: {}, updated_at: 1 };
		writer.enqueue(mutation);
		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
		await writer.flush();
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenLastCalledWith(mutation, { keepalive: true });
	});
});
