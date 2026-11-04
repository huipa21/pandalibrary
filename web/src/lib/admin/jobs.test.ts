import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatTimestamp, mergeImportPage, parseGoDuration, scheduleParts } from './jobs.js';
import { BoundedPoller } from './poller.js';
import { ImportHistory } from './ImportHistory.svelte.js';
import type { ImportJob } from './types.js';

const job = (id: number, status: ImportJob['status'] = 'pending'): ImportJob =>
	({
		id,
		source: 'upload',
		library_id: 1,
		user_id: 1,
		original_name: `book-${id}.epub`,
		sha256: null,
		status,
		error: null,
		book_id: null,
		duplicate_of_book_id: null,
		created_at: '2026-11-03T00:00:00Z',
		finished_at: null
	}) as ImportJob;

describe('job helpers', () => {
	it('merges a refreshed first page into loaded history', () => {
		const current = [job(5), job(4, 'imported'), job(2, 'failed')];
		const merged = mergeImportPage(current, [job(7), job(6), job(5, 'imported'), job(4, 'imported')]);
		expect(merged.map((item) => [item.id, item.status])).toEqual([
			[7, 'pending'],
			[6, 'pending'],
			[5, 'imported'],
			[4, 'imported'],
			[2, 'failed']
		]);
	});

	it('describes Go durations', () => {
		expect(parseGoDuration('1h0m0s')).toBe(3600);
		expect(parseGoDuration('5m0s')).toBe(300);
		expect(parseGoDuration('1.5s')).toBe(1.5);
		expect(parseGoDuration('weekly')).toBeNull();
		expect(scheduleParts('24h0m0s')).toEqual({ unit: 'hours', count: 24 });
		expect(scheduleParts('5m0s')).toEqual({ unit: 'minutes', count: 5 });
		expect(scheduleParts('90s')).toEqual({ unit: 'seconds', count: 90 });
		expect(scheduleParts('daily')).toEqual({ unit: 'raw', text: 'daily' });
	});

	it('formats timestamps and falls back to the raw value', () => {
		expect(formatTimestamp('2026-11-03T08:00:00Z', 'en')).toMatch(/2026/);
		expect(formatTimestamp('nonsense', 'en')).toBe('nonsense');
		expect(formatTimestamp(null, 'zh')).toBe('');
	});
});

describe('BoundedPoller', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('never overlaps ticks and stops after the budget', async () => {
		let active = 0;
		let maxActive = 0;
		let calls = 0;
		const poller = new BoundedPoller(
			async () => {
				calls += 1;
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 5000));
				active -= 1;
				return true;
			},
			{ intervalMs: 1000, maxTicks: 3 }
		);
		poller.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toBe(3);
		expect(maxActive).toBe(1);
		expect(poller.active).toBe(false);
	});

	it('stops when the task reports nothing is active, throws, or stop() is called', async () => {
		const done = vi.fn(async () => false);
		new BoundedPoller(done, { intervalMs: 100, maxTicks: 10 }).start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(done).toHaveBeenCalledTimes(1);

		const failing = vi.fn(async () => {
			throw new Error('boom');
		});
		new BoundedPoller(failing, { intervalMs: 100, maxTicks: 10 }).start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(failing).toHaveBeenCalledTimes(1);

		const busy = vi.fn(async () => true);
		const poller = new BoundedPoller(busy, { intervalMs: 100, maxTicks: 10 });
		poller.start();
		await vi.advanceTimersByTimeAsync(250);
		poller.stop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(busy).toHaveBeenCalledTimes(2);
	});

	it('restarts after an in-flight tick when started again', async () => {
		let release: (value: boolean) => void = () => {};
		const task = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
		const poller = new BoundedPoller(task, { intervalMs: 100, maxTicks: 5 });
		poller.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(task).toHaveBeenCalledTimes(1);
		poller.start();
		release(false);
		await vi.advanceTimersByTimeAsync(100);
		expect(task).toHaveBeenCalledTimes(2);
	});
});

describe('ImportHistory', () => {
	it('merges silent refreshes and reports whether imports are still active', async () => {
		const fetchFirst = vi.fn().mockResolvedValueOnce({ items: [job(3, 'imported'), job(2, 'imported')] });
		const history = new ImportHistory(fetchFirst);
		await history.reset(async () => ({ items: [job(2)], next_cursor: '1' }));
		expect(history.hasActive).toBe(true);
		await expect(history.refresh()).resolves.toBe(false);
		expect(history.items.map((item) => [item.id, item.status])).toEqual([
			[3, 'imported'],
			[2, 'imported']
		]);
		expect(history.nextCursor).toBe('1');
		history.dispose();
	});

	it('shares an in-flight refresh and ignores one that a reset superseded', async () => {
		let resolve: (value: { items: ImportJob[] }) => void = () => {};
		const fetchFirst = vi.fn(() => new Promise<{ items: ImportJob[] }>((done) => (resolve = done)));
		const history = new ImportHistory(fetchFirst);
		await history.reset(async () => ({ items: [job(1)], next_cursor: null }));
		const first = history.refresh();
		expect(history.refresh()).toBe(first);
		expect(fetchFirst).toHaveBeenCalledTimes(1);
		await history.reset(async () => ({ items: [job(1)], next_cursor: null }));
		resolve({ items: [job(9, 'imported'), job(1, 'imported')] });
		await first;
		expect(history.items.map((item) => item.id)).toEqual([1]);
		expect(history.items[0].status).toBe('pending');
		history.dispose();
	});

	it('records refresh failures without clearing the list', async () => {
		const history = new ImportHistory(vi.fn().mockRejectedValue(new TypeError('offline')));
		await history.reset(async () => ({ items: [job(1)], next_cursor: null }));
		await expect(history.refresh()).rejects.toThrow('offline');
		expect(history.refreshError).toBeInstanceOf(TypeError);
		expect(history.items).toHaveLength(1);
		history.dispose();
	});

	it('shows an uploaded job immediately', async () => {
		const history = new ImportHistory(vi.fn());
		await history.reset(async () => ({ items: [job(1, 'imported')], next_cursor: null }));
		history.include(job(2));
		expect(history.items.map((item) => item.id)).toEqual([2, 1]);
		history.dispose();
	});
});
