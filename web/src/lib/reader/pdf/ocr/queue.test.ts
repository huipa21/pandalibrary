import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OcrQueue } from './queue.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('debounces from the last enqueue and runs the visible/nearest page first', async () => {
	const queue = new OcrQueue(4);
	const calls: number[] = [];
	const signal = new AbortController().signal;
	const far = queue.enqueue(4, signal, async () => { calls.push(4); });
	await vi.advanceTimersByTimeAsync(300);
	const visible = queue.enqueue(0, signal, async () => { calls.push(0); });
	const near = queue.enqueue(1, signal, async () => { calls.push(1); });
	await vi.advanceTimersByTimeAsync(399);
	expect(calls).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	await Promise.all([far, visible, near]);
	expect(calls).toEqual([0, 1, 4]);
	queue.dispose();
});

it.each([[4, 1], [8, 2]])('limits %i cores to %i simultaneous jobs', async (cores, expected) => {
	const queue = new OcrQueue(cores);
	const releases: (() => void)[] = [];
	const signal = new AbortController().signal;
	const jobs = Array.from({ length: 3 }, (_, i) => queue.enqueue(i, signal, () =>
		new Promise<void>((resolve) => releases.push(resolve))));
	await vi.advanceTimersByTimeAsync(400);
	expect(releases).toHaveLength(expected);
	while (releases.length) {
		releases.shift()!();
		await vi.advanceTimersByTimeAsync(0);
	}
	await Promise.all(jobs);
	queue.dispose();
});

it('cancels queued jobs without running and rejects already-aborted jobs', async () => {
	const queue = new OcrQueue();
	const controller = new AbortController();
	const action = vi.fn(async () => {});
	const job = queue.enqueue(0, controller.signal, action);
	const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
	controller.abort();
	await rejected;
	await vi.advanceTimersByTimeAsync(400);
	expect(action).not.toHaveBeenCalled();
	await expect(queue.enqueue(0, controller.signal, action)).rejects.toMatchObject({ name: 'AbortError' });
	queue.dispose();
});

it('does not release a running concurrency slot before its aborted action settles', async () => {
	const queue = new OcrQueue(1);
	const controller = new AbortController();
	let release!: () => void;
	const first = queue.enqueue(0, controller.signal, () => new Promise<void>((resolve) => { release = resolve; }));
	const failed = expect(first).rejects.toMatchObject({ name: 'AbortError' });
	const secondAction = vi.fn(async () => {});
	const second = queue.enqueue(1, new AbortController().signal, secondAction);
	await vi.advanceTimersByTimeAsync(400);
	controller.abort();
	await failed;
	expect(secondAction).not.toHaveBeenCalled();
	release();
	await vi.advanceTimersByTimeAsync(0);
	await second;
	expect(secondAction).toHaveBeenCalledOnce();
	queue.dispose();
});

it('dispose rejects pending jobs', async () => {
	const queue = new OcrQueue();
	const job = queue.enqueue(0, new AbortController().signal, async () => {});
	const failed = expect(job).rejects.toMatchObject({ name: 'AbortError' });
	queue.dispose();
	await failed;
	await expect(queue.enqueue(0, new AbortController().signal, async () => {})).rejects.toMatchObject({ name: 'AbortError' });
});

it('re-evaluates visible-page priorities when scrolling changes before the debounce', async () => {
	const queue = new OcrQueue(1);
	let visible = 1;
	const calls: number[] = [];
	const jobs = [1, 2, 3].map((page) => queue.enqueue(
		() => Math.abs(page - visible), new AbortController().signal, async () => { calls.push(page); }
	));
	visible = 3;
	await vi.advanceTimersByTimeAsync(400);
	await Promise.all(jobs);
	expect(calls).toEqual([3, 2, 1]);
	queue.dispose();
});
