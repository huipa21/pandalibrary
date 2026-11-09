import { afterEach, expect, it, vi } from 'vitest';
import { flushReaderWrites } from './flush.js';

afterEach(() => vi.useRealTimers());

it('waits for all progress and session writers before allowing close', async () => {
	let finish!: () => void;
	const progress = { flush: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) };
	const retiredWriter = { flush: vi.fn().mockResolvedValue(undefined) };
	const retired = new Set([retiredWriter]);
	const sessions = { flush: vi.fn().mockResolvedValue(undefined) };
	const closed = vi.fn();
	const closing = flushReaderWrites(progress, retired, sessions).then(closed);
	await Promise.resolve();
	expect(retired.size).toBe(0);
	expect(closed).not.toHaveBeenCalled();
	expect(sessions.flush).toHaveBeenCalledWith({ keepalive: true, signal: expect.any(AbortSignal) });
	finish();
	await closing;
	expect(closed).toHaveBeenCalledOnce();
});

it('retains failed retired writers for retry and rejects the close', async () => {
	const writer = { flush: vi.fn().mockRejectedValue(new Error('Storage unavailable')) };
	const retired = new Set([writer]);
	const sessions = { flush: vi.fn().mockResolvedValue(undefined) };
	await expect(flushReaderWrites(null, retired, sessions)).rejects.toThrow('Storage unavailable');
	expect(retired.has(writer)).toBe(true);
	writer.flush.mockResolvedValue(undefined);
	await flushReaderWrites(null, retired, sessions);
	expect(retired.size).toBe(0);
});

it('bounds close flushing even when a writer does not handle abort', async () => {
	vi.useFakeTimers();
	const writer = { flush: vi.fn((_options: { keepalive: boolean; signal: AbortSignal }) => new Promise<void>(() => {})) };
	const sessions = { flush: vi.fn().mockResolvedValue(undefined) };
	const closing = expect(flushReaderWrites(writer, new Set(), sessions)).rejects.toThrow('Reader save timed out.');
	await vi.advanceTimersByTimeAsync(2500);
	await closing;
	expect(writer.flush.mock.calls[0][0].signal.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});
