import { v7 as uuidv7 } from 'uuid';
import { DEVICE_NAME, pushMutation, type Mutation } from './api.js';
import { fraction } from './progress.js';

export const IDLE_MS = 5 * 60 * 1000;
const MIN_SESSION_MS = 30 * 1000;

interface ActiveSession {
	startedAt: number;
	lastActivity: number;
	startPercentage: number;
}

export class ReadingSessions {
	private active: ActiveSession | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly bookId: number,
		private readonly currentFraction: () => number,
		private readonly completed: (mutation: Mutation) => void,
		private readonly now = Date.now
	) {}

	start(): void {
		if (this.active) return;
		const now = this.now();
		this.active = { startedAt: now, lastActivity: now, startPercentage: fraction(this.currentFraction()) };
		this.scheduleIdle();
	}

	activity(): void {
		const now = this.now();
		if (this.active && now >= this.active.lastActivity + IDLE_MS) this.stop();
		if (!this.active) {
			this.start();
			return;
		}
		this.active.lastActivity = now;
		this.scheduleIdle();
	}

	stop(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		const active = this.active;
		this.active = null;
		if (!active) return;
		const endedAt = Math.max(active.startedAt, Math.min(this.now(), active.lastActivity + IDLE_MS));
		if (endedAt - active.startedAt < MIN_SESSION_MS) return;
		this.completed({
			entity: 'reading_sessions',
			id: uuidv7(),
			op: 'upsert',
			updated_at: endedAt,
			data: {
				book_id: this.bookId,
				source: 'web',
				device: DEVICE_NAME,
				started_at: active.startedAt,
				ended_at: endedAt,
				active_seconds: Math.floor((endedAt - active.startedAt) / 1000),
				start_percentage: active.startPercentage,
				end_percentage: fraction(this.currentFraction())
			}
		});
	}

	private scheduleIdle(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.stop(), IDLE_MS);
	}
}

export class SessionWriter {
	private pending: Mutation[] = [];
	private inFlight: Promise<void> | null = null;

	constructor(
		private readonly onError: (error: unknown) => void,
		private readonly send = pushMutation
	) {}

	enqueue(mutation: Mutation): void {
		this.pending.push(mutation);
		void this.flush().catch(this.onError);
	}

	async flush(options: { keepalive?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		if (this.inFlight) {
			await this.inFlight;
			return this.flush(options);
		}
		if (!this.pending.length) return;
		const write = this.drain(options);
		this.inFlight = write;
		try {
			await write;
		} finally {
			if (this.inFlight === write) this.inFlight = null;
		}
	}

	private async drain(options: { keepalive?: boolean; signal?: AbortSignal }): Promise<void> {
		while (this.pending.length) {
			await this.send(this.pending[0], { keepalive: true, ...options });
			this.pending.shift();
		}
	}
}
