import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeapScan } from './api.js';
import { ScanController, type ScanApi } from './scan.svelte.js';

function scan(status: HeapScan['status'], overrides: Partial<HeapScan> = {}): HeapScan {
	return {
		id: 7,
		status,
		started_at: '2026-01-01T00:00:00Z',
		finished_at: status === 'running' ? null : '2026-01-01T00:00:05Z',
		added: 2,
		updated: 1,
		removed: 0,
		unchanged: 3,
		invalid: 1,
		duplicates: 1,
		skipped: 0,
		in_progress: 0,
		error: status === 'failed' ? 'boom' : null,
		...overrides
	};
}

function fakeApi(start: () => Promise<HeapScan>, polls: Array<HeapScan | null | Error>): ScanApi & { get: ReturnType<typeof vi.fn> } {
	const get = vi.fn(async () => {
		const next = polls.shift();
		if (next instanceof Error) throw next;
		return next ?? null;
	});
	return { start, get };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ScanController', () => {
	it('starts a scan, polls while running, and reports the completed summary once', async () => {
		const onfinish = vi.fn();
		const api = fakeApi(async () => scan('running', { added: 0 }), [scan('running', { added: 1 }), scan('completed')]);
		const controller = new ScanController({ api, intervalMs: 100, onfinish });
		const started = controller.start();
		expect(controller.state).toBe('starting');
		expect(controller.busy).toBe(true);
		await started;
		expect(controller.state).toBe('running');
		await vi.advanceTimersByTimeAsync(100);
		expect(controller.scan?.added).toBe(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(controller.state).toBe('completed');
		expect(controller.scan?.added).toBe(2);
		expect(onfinish).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(api.get).toHaveBeenCalledTimes(2);
		controller.dismiss();
		expect(controller.state).toBe('idle');
		controller.dispose();
	});

	it('shows a failed scan with retry starting a new one', async () => {
		const api = fakeApi(async () => scan('failed'), []);
		const controller = new ScanController({ api, intervalMs: 100 });
		await controller.start();
		expect(controller.state).toBe('failed');
		expect(controller.retryAction).toBe('start');
		controller.dispose();
	});

	it('attaches to a scan already running on page load and ignores finished ones', async () => {
		const idle = new ScanController({ api: fakeApi(async () => scan('running'), [scan('completed')]), intervalMs: 100 });
		await idle.attach();
		expect(idle.state).toBe('idle');
		idle.dispose();

		const api = fakeApi(async () => scan('running'), [scan('running'), scan('completed')]);
		const controller = new ScanController({ api, intervalMs: 100 });
		await controller.attach();
		expect(controller.state).toBe('running');
		await vi.advanceTimersByTimeAsync(100);
		expect(controller.state).toBe('completed');
		controller.dispose();
	});

	it('reports request errors with the right retry action', async () => {
		const api = fakeApi(async () => {
			throw new Error('down');
		}, [scan('running'), new Error('poll')]);
		const controller = new ScanController({ api, intervalMs: 100 });
		await controller.start();
		expect(controller.state).toBe('error');
		expect(controller.retryAction).toBe('start');
		await controller.attach();
		expect(controller.state).toBe('running');
		await vi.advanceTimersByTimeAsync(100);
		expect(controller.state).toBe('error');
		expect(controller.retryAction).toBe('attach');
		controller.dispose();
	});

	it('stops polling and reports a stall when the budget runs out', async () => {
		const api = fakeApi(async () => scan('running'), [scan('running'), scan('running'), scan('running')]);
		const controller = new ScanController({ api, intervalMs: 100, maxTicks: 2 });
		await controller.start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(controller.state).toBe('stalled');
		expect(controller.retryAction).toBe('attach');
		expect(api.get).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	it('returns to idle when the server forgets the scan', async () => {
		const api = fakeApi(async () => scan('running'), [null]);
		const controller = new ScanController({ api, intervalMs: 100 });
		await controller.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(controller.state).toBe('idle');
		controller.dispose();
	});

	it('does not start a second scan while one is running', async () => {
		const start = vi.fn(async () => scan('running'));
		const controller = new ScanController({ api: fakeApi(start, []), intervalMs: 100 });
		await controller.start();
		await controller.start();
		expect(start).toHaveBeenCalledTimes(1);
		controller.dispose();
	});
});
