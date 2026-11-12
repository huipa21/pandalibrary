import type { Mutation } from '#lib/reader/api.js';

type FlushOptions = { keepalive?: boolean; signal?: AbortSignal };

export interface InnerProgressWriter {
	schedule(mutation: Mutation): void;
	flush(options: FlushOptions): Promise<void>;
}

function positionKey(mutation: Mutation): string {
	const { book_id, book_file_id, locator } = mutation.data;
	return JSON.stringify([book_id, book_file_id, locator ?? null]);
}

/**
 * Saves the latest reading position at most once per interval, and only when it changed.
 * The first position (book opened) is saved immediately.
 */
export class PeriodicProgressWriter {
	private latest: Mutation | null = null;
	private forwardedKey: string | null = null;
	private timer: ReturnType<typeof setInterval> | null;

	constructor(private readonly inner: InnerProgressWriter, intervalMs = 10_000) {
		this.timer = setInterval(() => this.forward(), intervalMs);
	}

	schedule(mutation: Mutation): void {
		this.latest = mutation;
		if (this.forwardedKey === null) this.forward();
	}

	async flush(options: FlushOptions = {}): Promise<void> {
		this.forward();
		await this.inner.flush(options);
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}

	private forward(): void {
		const mutation = this.latest;
		if (!mutation) return;
		const key = positionKey(mutation);
		if (key === this.forwardedKey) return;
		this.forwardedKey = key;
		this.inner.schedule(mutation);
	}
}
