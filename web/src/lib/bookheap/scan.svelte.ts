import { BoundedPoller } from '#lib/admin/poller.js';
import { getHeapScan, startHeapScan, type HeapScan } from './api.js';

/**
 * `idle`: nothing to show; `starting`: POST in flight; `running`: polling a running scan;
 * `completed`/`failed`: the scan finished (failed carries the server error); `error`: a request
 * failed, retry depends on `retryAction`; `stalled`: the poll budget ran out while still running.
 */
export type ScanState = 'idle' | 'starting' | 'running' | 'completed' | 'failed' | 'error' | 'stalled';

export interface ScanApi {
	start(): Promise<HeapScan>;
	get(signal?: AbortSignal): Promise<HeapScan | null>;
}

export interface ScanControllerOptions {
	readonly api?: ScanApi;
	readonly intervalMs?: number;
	/** Polls per attach/start before reporting `stalled`. */
	readonly maxTicks?: number;
	/** Called once whenever a scan this controller watched finishes. */
	readonly onfinish?: (scan: HeapScan) => void;
}

const defaultApi: ScanApi = { start: startHeapScan, get: getHeapScan };

export class ScanController {
	state = $state<ScanState>('idle');
	scan = $state<HeapScan | null>(null);
	error = $state<unknown>(null);
	/** What Retry does after an `error`: start a new scan or resume watching the current one. */
	retryAction = $state<'start' | 'attach'>('start');

	readonly #api: ScanApi;
	readonly #onfinish?: (scan: HeapScan) => void;
	readonly #maxTicks: number;
	readonly #poller: BoundedPoller;
	#ticks = 0;
	#generation = 0;
	#disposed = false;

	constructor({ api = defaultApi, intervalMs = 1000, maxTicks = 900, onfinish }: ScanControllerOptions = {}) {
		this.#api = api;
		this.#onfinish = onfinish;
		this.#maxTicks = maxTicks;
		// The tick budget is enforced here so a stall can be reported; the poller bound is a backstop.
		this.#poller = new BoundedPoller(() => this.#tick(), { intervalMs, maxTicks: maxTicks + 1 });
	}

	get busy(): boolean {
		return this.state === 'starting' || this.state === 'running';
	}

	/** Shows and follows a scan that is already running, for example on page load. */
	async attach(): Promise<void> {
		if (this.busy) return;
		const generation = ++this.#generation;
		try {
			const scan = await this.#api.get();
			if (generation !== this.#generation || this.#disposed) return;
			if (scan?.status === 'running') this.#follow(scan);
			else if (this.state === 'error' || this.state === 'stalled') this.#settle(scan, true);
		} catch (cause) {
			if (generation !== this.#generation || this.#disposed) return;
			this.#fail(cause, 'attach');
		}
	}

	/** Starts a scan; if one is already running the server returns it and this attaches to it. */
	async start(): Promise<void> {
		if (this.busy || this.#disposed) return;
		const generation = ++this.#generation;
		this.state = 'starting';
		this.error = null;
		try {
			const scan = await this.#api.start();
			if (generation !== this.#generation || this.#disposed) return;
			if (scan.status === 'running') this.#follow(scan);
			else this.#settle(scan, true);
		} catch (cause) {
			if (generation !== this.#generation || this.#disposed) return;
			this.#fail(cause, 'start');
		}
	}

	retry(): Promise<void> {
		return this.retryAction === 'attach' ? this.attach() : this.start();
	}

	/** Hides a finished result or error. */
	dismiss(): void {
		if (!this.busy) this.state = 'idle';
	}

	dispose(): void {
		this.#disposed = true;
		this.#generation += 1;
		this.#poller.stop();
	}

	#follow(scan: HeapScan): void {
		this.scan = scan;
		this.error = null;
		this.state = 'running';
		this.#ticks = 0;
		this.#poller.start();
	}

	async #tick(): Promise<boolean> {
		const generation = this.#generation;
		if (this.state !== 'running') return false;
		this.#ticks += 1;
		try {
			const scan = await this.#api.get();
			if (generation !== this.#generation || this.#disposed) return false;
			if (scan?.status === 'running') {
				this.scan = scan;
				if (this.#ticks >= this.#maxTicks) {
					this.state = 'stalled';
					this.retryAction = 'attach';
					return false;
				}
				return true;
			}
			this.#settle(scan, true);
		} catch (cause) {
			if (generation !== this.#generation || this.#disposed) return false;
			this.#fail(cause, 'attach');
		}
		return false;
	}

	/** A null scan means the server restarted and lost the in-memory status. */
	#settle(scan: HeapScan | null, notify: boolean): void {
		this.#poller.stop();
		if (!scan) {
			this.scan = null;
			this.state = 'idle';
			return;
		}
		this.scan = scan;
		this.error = null;
		this.state = scan.status === 'failed' ? 'failed' : 'completed';
		this.retryAction = 'start';
		if (notify) this.#onfinish?.(scan);
	}

	#fail(cause: unknown, retry: 'start' | 'attach'): void {
		this.#poller.stop();
		this.error = cause;
		this.retryAction = retry;
		this.state = 'error';
	}
}
