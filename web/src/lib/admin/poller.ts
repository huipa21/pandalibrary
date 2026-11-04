export interface PollerOptions {
	/** Delay between the end of one tick and the start of the next. */
	readonly intervalMs: number;
	/** Maximum ticks per start(); polling then stops until started again. */
	readonly maxTicks: number;
}

/**
 * Repeats an async task while it returns true. Ticks never overlap because the next one
 * is scheduled only after the previous one settles, the number of ticks is bounded, and
 * stop() prevents any further tick (including one scheduled by an in-flight task).
 */
export class BoundedPoller {
	#task: () => Promise<boolean>;
	#options: PollerOptions;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#generation = 0;
	#remaining = 0;
	#running = false;
	#startRequested = false;

	constructor(task: () => Promise<boolean>, options: PollerOptions) {
		this.#task = task;
		this.#options = options;
	}

	get active(): boolean {
		return this.#timer !== null || this.#running;
	}

	/** Starts polling after one interval, or renews the tick budget if already polling. */
	start(): void {
		this.#remaining = this.#options.maxTicks;
		if (this.#running) {
			// Schedule after the in-flight tick, whatever it returns.
			this.#startRequested = true;
			return;
		}
		this.#clearTimer();
		this.#schedule();
	}

	stop(): void {
		this.#generation += 1;
		this.#remaining = 0;
		this.#startRequested = false;
		this.#clearTimer();
	}

	#schedule(): void {
		if (this.#remaining <= 0) return;
		const generation = this.#generation;
		this.#timer = setTimeout(() => void this.#tick(generation), this.#options.intervalMs);
	}

	async #tick(generation: number): Promise<void> {
		this.#timer = null;
		if (generation !== this.#generation) return;
		this.#remaining -= 1;
		this.#running = true;
		this.#startRequested = false;
		let again = false;
		try {
			again = await this.#task();
		} catch {
			again = false;
		} finally {
			this.#running = false;
		}
		const restart = this.#startRequested;
		this.#startRequested = false;
		if (restart || (again && generation === this.#generation)) this.#schedule();
	}

	#clearTimer(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}
}
