interface Job {
	priority: number | (() => number);
	signal: AbortSignal;
	run: () => Promise<void>;
	cancel: () => void;
}

export class OcrQueue {
	private jobs: Job[] = [];
	private running = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private ready = false;
	private readonly concurrency: number;

	constructor(cores = globalThis.navigator?.hardwareConcurrency ?? 1) {
		this.concurrency = cores >= 8 ? 2 : 1;
	}

	enqueue<T>(priority: number | (() => number), signal: AbortSignal, action: () => Promise<T>): Promise<T> {
		if (this.disposed || signal.aborted) return Promise.reject(new DOMException('OCR cancelled.', 'AbortError'));
		this.ready = false;
		clearTimeout(this.timer);
		const promise = new Promise<T>((resolve, reject) => {
			const job: Job = {
				priority, signal,
				cancel: () => {
					this.jobs = this.jobs.filter((entry) => entry !== job);
					reject(new DOMException('OCR cancelled.', 'AbortError'));
				},
				run: async () => {
					try {
						signal.throwIfAborted();
						const value = await action();
						signal.throwIfAborted();
						resolve(value);
					} catch (error) {
						reject(error);
					} finally {
						signal.removeEventListener('abort', job.cancel);
					}
				}
			};
			signal.addEventListener('abort', job.cancel, { once: true });
			this.jobs.push(job);
		});
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.ready = true;
			this.drain();
		}, 400);
		return promise;
	}

	private drain(): void {
		while (!this.disposed && this.ready && this.running < this.concurrency && this.jobs.length) {
			const priority = (job: Job) => typeof job.priority === 'number' ? job.priority : job.priority();
			this.jobs.sort((a, b) => priority(a) - priority(b));
			const job = this.jobs.shift()!;
			this.running++;
			void job.run().finally(() => {
				this.running--;
				this.drain();
			});
		}
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		for (const job of this.jobs) {
			job.signal.removeEventListener('abort', job.cancel);
			job.cancel();
		}
		this.jobs = [];
	}
}
