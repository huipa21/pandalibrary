import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import * as readerApi from '#lib/reader/api.js';
import { enqueue, outbox, persistPull, recordResults, setActiveViewer } from '#lib/sync/db.js';
import type { OfflineViewer, PullResponse, SyncMutation } from '#lib/sync/types.js';
import { DASHBOARD_SETTING, DEFAULT_SECTIONS } from './layout.js';
import { LayoutNotSyncedError, readDashboardLayout, saveDashboardLayout } from './storage.js';

const state = vi.hoisted(() => ({ account: 1, durable: true, save: vi.fn() }));
vi.mock('#lib/sync/client.js', () => ({
	currentAccount: () => state.account,
	offlineAvailable: () => state.durable,
	saveMutation: state.save
}));

const viewer: OfflineViewer = { id: 1, username: 'reader', display_name: '', role: 'user', locale: 'en' };
const timestamp = '2026-11-04T00:00:00Z';
const pull = (): PullResponse => ({
	cursor: 1, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
});
const mutation = (sections: string[]): SyncMutation => ({
	entity: 'user_settings', key: DASHBOARD_SETTING, op: 'upsert', updated_at: Date.parse(timestamp),
	data: { value: { version: 1, sections: sections.map((id) => ({ id })) } }
});

beforeEach(async () => {
	state.account = 1;
	state.durable = true;
	state.save.mockReset();
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal('IDBKeyRange', IDBKeyRange);
	vi.stubGlobal('navigator', {
		onLine: false,
		locks: { request: async (_name: string, action: () => Promise<unknown>) => action() }
	});
	await setActiveViewer(viewer);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('durable dashboard settings', () => {
	it('does not mistake an unsynchronized offline account for a missing setting', async () => {
		await expect(readDashboardLayout(1)).rejects.toBeInstanceOf(LayoutNotSyncedError);
		await persistPull(1, 0, pull(), true);
		expect((await readDashboardLayout(1)).layout).toEqual({
			valid: true, sections: DEFAULT_SECTIONS, missing: true
		});
	});

	it('replays queued offline layouts, keeps empty layouts, and surfaces rejected writes', async () => {
		const snapshot = pull();
		snapshot.user_settings.push({
			key: DASHBOARD_SETTING, value: { version: 1, sections: [] }, updated_at: timestamp, rev: 1
		});
		await persistPull(1, 0, snapshot, true);
		expect((await readDashboardLayout(1)).layout).toMatchObject({ sections: [], missing: false });
		await enqueue(1, mutation(['read', 'shelf:7']));
		expect(await readDashboardLayout(1)).toMatchObject({
			layout: { valid: true, sections: ['read', 'shelf:7'] }, conflict: false
		});
		const entries = await outbox(1);
		await recordResults(1, entries, [{ index: 0, status: 'stale' }]);
		expect(await readDashboardLayout(1)).toMatchObject({
			layout: { valid: true, sections: [] }, conflict: true
		});
	});

	it('isolates layouts and outboxes across active accounts', async () => {
		await enqueue(1, mutation(['read']));
		state.account = 2;
		await setActiveViewer({ ...viewer, id: 2 });
		await persistPull(2, 0, pull(), true);
		expect((await readDashboardLayout(2)).layout).toMatchObject({ sections: DEFAULT_SECTIONS });
		await expect(readDashboardLayout(1)).rejects.toThrow('account has changed');
		state.account = 1;
		await setActiveViewer(viewer);
		expect((await readDashboardLayout(1)).layout).toMatchObject({ sections: ['read'] });
	});

	it('does not silently replace an online authorization or server error with defaults', async () => {
		vi.stubGlobal('navigator', {
			onLine: true,
			locks: { request: async (_name: string, action: () => Promise<unknown>) => action() }
		});
		vi.spyOn(api, 'request').mockRejectedValue(new ApiError(403, 'Forbidden', ''));
		await expect(readDashboardLayout(1)).rejects.toMatchObject({ status: 403 });
	});

	it('reports malformed settings responses instead of treating them as a missing layout', async () => {
		vi.stubGlobal('navigator', {
			onLine: true,
			locks: { request: async (_name: string, action: () => Promise<unknown>) => action() }
		});
		await persistPull(1, 0, pull(), true);
		vi.spyOn(api, 'request').mockResolvedValue({});
		await expect(readDashboardLayout(1)).rejects.toThrow('invalid dashboard settings');
	});

	it('saves the exact account setting through the durable mutation helper and propagates errors', async () => {
		state.save.mockResolvedValueOnce('queued');
		await expect(saveDashboardLayout(1, [])).resolves.toBe('queued');
		expect(state.save).toHaveBeenCalledWith({
			entity: 'user_settings', key: DASHBOARD_SETTING, op: 'upsert',
			data: { value: { version: 1, sections: [] } }, updated_at: expect.any(Number)
		});
		state.save.mockRejectedValueOnce(new readerApi.SyncError('rejected', 'denied'));
		await expect(saveDashboardLayout(1, ['read'])).rejects.toMatchObject({ status: 'rejected' });
	});
});
