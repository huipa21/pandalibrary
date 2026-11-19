import { api } from '#lib/api/client.js';
import type { BookState, Setting } from '#lib/reader/types.js';
import { currentAccount, offlineAvailable, saveMutation } from '#lib/sync/client.js';
import { AccountChangedError, cursorState, OfflineStorageError, outbox, rows } from '#lib/sync/db.js';
import { SyncProtocolError, withSessionLock } from '#lib/sync/engine.js';
import { replayMutations } from '#lib/sync/state.js';
import { DASHBOARD_SETTING, layoutValue, parseLayout, type ParsedLayout, type SectionId } from './layout.js';

const EMPTY_BOOK_STATE: BookState = { user_book: null, progress: null, highlights: [], notes: [], bookmarks: [] };

export class LayoutNotSyncedError extends Error {
	constructor() {
		super('The dashboard settings have not been synchronized on this device.');
		this.name = 'LayoutNotSyncedError';
	}
}

export interface DashboardLayoutResult {
	layout: ParsedLayout;
	conflict: boolean;
}

function assertAccount(account: number): void {
	if (currentAccount() !== account) throw new AccountChangedError();
}

let prefetched: { account: number; settings: Promise<Setting[]> } | null = null;

/** Starts the dashboard settings request while the shell finishes activating the session. */
export function prefetchDashboardSettings(account: number): void {
	if (typeof navigator !== 'undefined' && !navigator.onLine) return;
	if (prefetched?.account === account) return;
	prefetched = { account, settings: fetchSettings() };
	// The shell may redirect to login before the dashboard consumes it.
	void prefetched.settings.catch(() => undefined);
}

async function takeSettings(account: number): Promise<Setting[]> {
	const pending = prefetched?.account === account ? prefetched.settings : null;
	prefetched = null;
	return pending ?? fetchSettings();
}

async function fetchSettings(): Promise<Setting[]> {
	const response = await api.request<{ settings: Setting[] }>('/me/settings', { cache: 'no-store' });
	if (!response || !Array.isArray(response.settings) || response.settings.some((setting) =>
		typeof setting !== 'object' || setting === null || typeof setting.key !== 'string' ||
		!('value' in setting) || typeof setting.updated_at !== 'string' ||
		!Number.isSafeInteger(setting.rev)
	)) {
		throw new SyncProtocolError('The server returned invalid dashboard settings.');
	}
	return response.settings;
}

export async function readDashboardLayout(account: number): Promise<DashboardLayoutResult> {
	assertAccount(account);
	if (!offlineAvailable()) {
		if (!navigator.onLine) throw new OfflineStorageError('Offline storage is unavailable.');
		const settings = await takeSettings(account);
		assertAccount(account);
		return { layout: parseLayout(settings.find((item) => item.key === DASHBOARD_SETTING)), conflict: false };
	}

	return withSessionLock(async () => {
		assertAccount(account);
		let onlineSettings: Setting[] | undefined;
		if (navigator.onLine) {
			try {
				onlineSettings = await takeSettings(account);
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
				console.warn('Could not reach dashboard settings; using synchronized offline data', error);
			}
		}
		const [stored, queued, cursor] = await Promise.all([rows(account), outbox(account), cursorState(account)]);
		const settings = onlineSettings ?? stored.flatMap((row) =>
			row.entity === 'user_settings' ? [row.value] : []
		);
		const hasLocalLayout = settings.some((item) => item.key === DASHBOARD_SETTING) ||
			queued.some(({ mutation, status }) => mutation.entity === 'user_settings' &&
				'key' in mutation && mutation.key === DASHBOARD_SETTING &&
				(status === 'pending' || status === 'applied'));
		if (onlineSettings === undefined && cursor.pulledAt === 0 && !hasLocalLayout) {
			throw new LayoutNotSyncedError();
		}
		const replayed = replayMutations(0, EMPTY_BOOK_STATE, settings, queued).settings;
		assertAccount(account);
		return {
			layout: parseLayout(replayed.find((item) => item.key === DASHBOARD_SETTING)),
			conflict: queued.some(({ mutation, status }) => mutation.entity === 'user_settings' &&
				'key' in mutation && mutation.key === DASHBOARD_SETTING &&
				(status === 'stale' || status === 'rejected'))
		};
	}, true);
}

export async function saveDashboardLayout(
	account: number,
	sections: readonly SectionId[]
): Promise<'applied' | 'queued'> {
	assertAccount(account);
	const result = await saveMutation({
		entity: 'user_settings',
		key: DASHBOARD_SETTING,
		op: 'upsert',
		data: { value: layoutValue(sections) },
		updated_at: Date.now()
	});
	assertAccount(account);
	return result;
}
