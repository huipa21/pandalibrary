import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mutation } from '#lib/reader/api.js';
import { PeriodicProgressWriter } from './progress-gate.js';

function position(page: number, updatedAt = page): Mutation {
	return {
		entity: 'reading_progress',
		key: '1',
		op: 'upsert',
		data: { book_id: 1, book_file_id: 2, source: 'web', locator: { type: 'pdf', page }, percentage: page / 100 },
		updated_at: updatedAt
	};
}

function innerWriter() {
	return { schedule: vi.fn<(mutation: Mutation) => void>(), flush: vi.fn(async () => {}) };
}

describe('PeriodicProgressWriter', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('forwards the first position immediately, then the latest change once per interval', () => {
		const inner = innerWriter();
		const writer = new PeriodicProgressWriter(inner);
		writer.schedule(position(1));
		expect(inner.schedule).toHaveBeenCalledTimes(1);
		for (let page = 2; page <= 20; page++) {
			writer.schedule(position(page));
			vi.advanceTimersByTime(400);
		}
		expect(inner.schedule).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10_000 - 19 * 400);
		expect(inner.schedule).toHaveBeenCalledTimes(2);
		expect(inner.schedule).toHaveBeenLastCalledWith(position(20));
		writer.stop();
	});

	it('skips ticks without a position change and saves the next change on the following tick', () => {
		const inner = innerWriter();
		const writer = new PeriodicProgressWriter(inner);
		writer.schedule(position(1));
		writer.schedule(position(1, 99));
		vi.advanceTimersByTime(30_000);
		expect(inner.schedule).toHaveBeenCalledTimes(1);
		writer.schedule(position(2));
		vi.advanceTimersByTime(9_999);
		expect(inner.schedule).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(inner.schedule).toHaveBeenLastCalledWith(position(2));
		writer.stop();
	});

	it('flushes a changed position immediately and waits for the inner writer', async () => {
		const inner = innerWriter();
		let release!: () => void;
		inner.flush.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
		const writer = new PeriodicProgressWriter(inner);
		writer.schedule(position(1));
		writer.schedule(position(3));
		const signal = new AbortController().signal;
		let done = false;
		const flushing = writer.flush({ keepalive: true, signal }).then(() => { done = true; });
		expect(inner.schedule).toHaveBeenLastCalledWith(position(3));
		expect(inner.flush).toHaveBeenCalledWith({ keepalive: true, signal });
		await Promise.resolve();
		expect(done).toBe(false);
		release();
		await flushing;
		expect(done).toBe(true);
		writer.stop();
	});

	it('stops ticking after stop but still flushes the latest position', async () => {
		const inner = innerWriter();
		const writer = new PeriodicProgressWriter(inner);
		writer.schedule(position(1));
		writer.schedule(position(4));
		writer.stop();
		writer.stop();
		vi.advanceTimersByTime(60_000);
		expect(inner.schedule).toHaveBeenCalledTimes(1);
		await writer.flush({});
		expect(inner.schedule).toHaveBeenLastCalledWith(position(4));
		await writer.flush({});
		expect(inner.schedule).toHaveBeenCalledTimes(2);
	});
});
