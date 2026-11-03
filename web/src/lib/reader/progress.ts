import { DEVICE_NAME, pushMutation, type Mutation } from './api.js';
import { isLocatorForFormat, type Progress, type Reader, type ReaderFormat, type Relocation } from './types.js';

export function fraction(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export async function restorePosition(
	reader: Reader,
	progress: Progress | null,
	fileId: number,
	format: ReaderFormat
): Promise<'locator' | 'fraction'> {
	if (
		progress?.source === 'web' &&
		progress.book_file_id === fileId &&
		isLocatorForFormat(progress.locator, format)
	) {
		try {
			await reader.goTo(progress.locator);
			return 'locator';
		} catch {
			// A valid-looking locator can still refer to content from an older file.
		}
	}
	await reader.goTo(fraction(progress?.percentage ?? 0));
	return 'fraction';
}

export function progressMutation(
	bookId: number,
	fileId: number,
	deviceId: string,
	location: Relocation,
	updatedAt = Date.now()
): Mutation {
	return {
		entity: 'reading_progress',
		key: String(bookId),
		op: 'upsert',
		data: {
			book_id: bookId,
			book_file_id: fileId,
			source: 'web',
			locator: location.locator,
			percentage: fraction(location.fraction),
			device: DEVICE_NAME,
			device_id: deviceId
		},
		updated_at: updatedAt
	};
}

export class ProgressWriter {
	private pending: Mutation | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight: Promise<void> | null = null;

	constructor(
		private readonly onError: (error: unknown) => void,
		private readonly send = pushMutation,
		private readonly debounceMs = 1000
	) {}

	schedule(mutation: Mutation): void {
		this.pending = mutation;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.flush().catch(this.onError);
		}, this.debounceMs);
	}

	async flush(options: { keepalive?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		if (this.inFlight) {
			await this.inFlight;
			return this.flush(options);
		}
		if (!this.pending) return;
		const write = this.drain(options);
		this.inFlight = write;
		try {
			await write;
		} finally {
			if (this.inFlight === write) this.inFlight = null;
		}
	}

	private async drain(options: { keepalive?: boolean; signal?: AbortSignal }): Promise<void> {
		while (this.pending) {
			const mutation = this.pending;
			this.pending = null;
			try {
				await this.send(mutation, { keepalive: true, ...options });
			} catch (error) {
				this.pending ??= mutation;
				throw error;
			}
		}
	}
}
