interface Priority {
	visible: boolean;
	distance: number;
	currentPage: number;
}

interface Job {
	page: number;
	priority: Priority;
	controller: AbortController;
	render: (signal: AbortSignal) => Promise<ImageBitmap>;
	waiters: Array<{ resolve(bitmap: ImageBitmap): void; reject(error: unknown): void }>;
	started: boolean;
}

function abortError(): DOMException {
	return new DOMException('The thumbnail render was aborted.', 'AbortError');
}

export class ThumbnailQueue {
	private readonly jobs = new Map<number, Job>();
	private active = 0;
	private scheduled = false;

	constructor(private readonly concurrency = 2) {
		if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
			throw new RangeError('Thumbnail render concurrency must be a positive integer.');
		}
	}

	enqueue(
		page: number,
		priority: Priority,
		render: (signal: AbortSignal) => Promise<ImageBitmap>
	): Promise<ImageBitmap> {
		const existing = this.jobs.get(page);
		if (existing) {
			existing.priority = priority;
			this.pump();
			return new Promise((resolve, reject) => existing.waiters.push({ resolve, reject }));
		}

		const promise = new Promise<ImageBitmap>((resolve, reject) => {
			this.jobs.set(page, {
				page,
				priority,
				controller: new AbortController(),
				render,
				waiters: [{ resolve, reject }],
				started: false
			});
		});
		this.pump();
		return promise;
	}

	cancel(page: number): void {
		const job = this.jobs.get(page);
		if (!job) return;
		this.jobs.delete(page);
		job.controller.abort();
		this.reject(job, abortError());
		this.pump();
	}

	cancelAll(): void {
		for (const job of this.jobs.values()) {
			job.controller.abort();
			this.reject(job, abortError());
		}
		this.jobs.clear();
	}

	private resolve(job: Job, bitmap: ImageBitmap): void {
		for (const waiter of job.waiters) waiter.resolve(bitmap);
		job.waiters = [];
	}

	private reject(job: Job, error: unknown): void {
		for (const waiter of job.waiters) waiter.reject(error);
		job.waiters = [];
	}

	private pump(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => this.runQueue());
	}

	private runQueue(): void {
		this.scheduled = false;
		while (this.active < this.concurrency) {
			const next = [...this.jobs.values()]
				.filter((job) => !job.started)
				.sort((a, b) =>
					Number(b.priority.visible) - Number(a.priority.visible) ||
					Math.abs(a.page - a.priority.currentPage) - Math.abs(b.page - b.priority.currentPage) ||
					a.priority.distance - b.priority.distance ||
					a.page - b.page
				)[0];
			if (!next) return;
			next.started = true;
			this.active++;
			void next.render(next.controller.signal).then((bitmap) => {
				if (next.controller.signal.aborted) bitmap.close();
				else this.resolve(next, bitmap);
			}, (error: unknown) => {
				if (!next.controller.signal.aborted) this.reject(next, error);
			}).finally(() => {
				if (this.jobs.get(next.page) === next) this.jobs.delete(next.page);
				this.active--;
				this.pump();
			});
		}
	}
}
