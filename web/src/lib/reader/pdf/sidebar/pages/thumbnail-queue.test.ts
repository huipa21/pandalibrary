import { describe, expect, it, vi } from 'vitest';
import { ThumbnailQueue } from './thumbnail-queue.js';

function bitmap() {
	return { close: vi.fn() } as unknown as ImageBitmap;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe('ThumbnailQueue', () => {
	it('caps concurrent renders at two', async () => {
		const queue = new ThumbnailQueue(2);
		const pending = new Map<number, ReturnType<typeof deferred<ImageBitmap>>>();
		let running = 0;
		let peak = 0;
		const render = (page: number) => () => {
			running++;
			peak = Math.max(peak, running);
			const task = deferred<ImageBitmap>();
			pending.set(page, task);
			return task.promise.finally(() => { running--; });
		};
		const promises = [1, 2, 3].map((page) => queue.enqueue(
			page, { visible: true, distance: page, currentPage: 1 }, render(page)
		));

		await vi.waitFor(() => expect(pending.size).toBe(2));
		pending.get(1)!.resolve(bitmap());
		await promises[0];
		await vi.waitFor(() => expect(pending.has(3)).toBe(true));
		pending.get(2)!.resolve(bitmap());
		pending.get(3)!.resolve(bitmap());
		await Promise.all(promises.slice(1));
		expect(peak).toBe(2);
	});

	it('prioritizes visible pages, then pages nearest the current page', async () => {
		const queue = new ThumbnailQueue(1);
		const first = deferred<ImageBitmap>();
		const pending = new Map<number, ReturnType<typeof deferred<ImageBitmap>>>([[1, first]]);
		const order = [1];
		const render = (page: number) => () => {
			order.push(page);
			const task = deferred<ImageBitmap>();
			pending.set(page, task);
			return task.promise;
		};
		const firstPromise = queue.enqueue(1, { visible: true, distance: 0, currentPage: 5 }, () => first.promise);
		await vi.waitFor(() => expect(order).toEqual([1]));
		const promises = [
			firstPromise,
			queue.enqueue(4, { visible: false, distance: 0, currentPage: 5 }, render(4)),
			queue.enqueue(7, { visible: true, distance: 0, currentPage: 5 }, render(7)),
			queue.enqueue(6, { visible: true, distance: 1, currentPage: 5 }, render(6))
		];

		first.resolve(bitmap());
		await promises[0];
		await vi.waitFor(() => expect(order).toEqual([1, 6]));
		pending.get(6)!.resolve(bitmap());
		await promises[3];
		await vi.waitFor(() => expect(order).toEqual([1, 6, 7]));
		pending.get(7)!.resolve(bitmap());
		await promises[2];
		await vi.waitFor(() => expect(order).toEqual([1, 6, 7, 4]));
		pending.get(4)!.resolve(bitmap());
		await promises[1];
	});

	it('aborts queued and active renders', async () => {
		const queue = new ThumbnailQueue(1);
		const active = deferred<ImageBitmap>();
		let activeSignal: AbortSignal | undefined;
		const activePromise = queue.enqueue(1, { visible: true, distance: 0, currentPage: 1 }, (signal) => {
			activeSignal = signal;
			return active.promise;
		});
		await vi.waitFor(() => expect(activeSignal).toBeDefined());
		const queuedPromise = queue.enqueue(2, { visible: false, distance: 2, currentPage: 1 }, () => Promise.resolve(bitmap()));
		void activePromise.catch(() => {});
		void queuedPromise.catch(() => {});

		queue.cancel(1);
		queue.cancel(2);

		await expect(activePromise).rejects.toMatchObject({ name: 'AbortError' });
		await expect(queuedPromise).rejects.toMatchObject({ name: 'AbortError' });
		expect(activeSignal?.aborted).toBe(true);
		active.resolve(bitmap());
	});
});
