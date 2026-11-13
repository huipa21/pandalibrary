import { api } from '#lib/api/client.js';

export interface HistoryRow {
	date: string;
	book_id: number;
	title: string;
	authors: string[];
	cover_url: string | null;
	cycle: number;
	active_seconds: number;
	session_count: number;
	day_active_seconds: number;
	day_session_count: number;
}

export interface HistoryMonth {
	month: string;
	books: number;
	active_seconds: number;
	session_count: number;
}

export interface HistorySummary {
	books: number;
	active_seconds: number;
	session_count: number;
	active_days: number;
	/** All twelve calendar months, including months without activity. */
	months: HistoryMonth[];
	records: {
		busiest_day: { date: string; active_seconds: number; session_count: number } | null;
		longest_session_seconds: number;
		most_read_book: { book_id: number; title: string; session_count: number } | null;
	};
}

export interface HistoryPage {
	year: number;
	timezone: string;
	items: HistoryRow[];
	next_cursor: string | null;
	summary: HistorySummary;
}

export interface HistoryCache {
	load(year: number, timeZone: string, cursor?: string | null, signal?: AbortSignal): Promise<HistoryPage>;
	clear(): void;
}

export const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
export const HISTORY_CACHE_MAX_PAGES = 30;

// A refresh also invalidates requests still running in an older navigation.
const userRevisions = new Map<number, number>();

interface CachedPage {
	key: string;
	expiresAt: number;
	page: HistoryPage;
}

interface PendingPage {
	controller: AbortController;
	promise: Promise<HistoryPage>;
	readers: number;
}

export function formatHistoryDuration(seconds: number): string {
	const minutes = Number.isFinite(seconds) ? Math.floor(Math.max(0, seconds) / 60) : 0;
	return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`;
}

/**
 * Keeps up to 30 pages per user in this tab for five minutes (LRU eviction).
 * Recreate on navigation with the authenticated user's ID; clear before refresh.
 * Storage failures warn and fall back to memory without blocking network requests.
 */
export function createHistoryCache(userId: number): HistoryCache {
	if (!Number.isSafeInteger(userId) || userId <= 0) throw new RangeError('Invalid history user ID.');

	const storageKey = `pandalibrary:history:v1:${userId}`;
	const pages = new Map<string, CachedPage>();
	const pending = new Map<string, PendingPage>();
	let generation = userRevisions.get(userId) ?? 0;
	let storageFailed = false;

	function storage(): Storage | undefined {
		return typeof window === 'undefined' ? undefined : window.sessionStorage;
	}

	function prune(): void {
		const now = Date.now();
		for (const [key, entry] of pages) {
			if (entry.expiresAt <= now) pages.delete(key);
		}
		while (pages.size > HISTORY_CACHE_MAX_PAGES) {
			pages.delete(pages.keys().next().value!);
		}
	}

	function read(): void {
		const revision = userRevisions.get(userId) ?? 0;
		if (generation !== revision) {
			generation = revision;
			pages.clear();
			pending.clear();
		}
		prune();
		if (storageFailed) return;
		try {
			const store = storage();
			if (!store) return;
			const raw = store.getItem(storageKey);
			const entries: CachedPage[] = raw === null ? [] : JSON.parse(raw);
			if (
				!Array.isArray(entries) ||
				!entries.every((entry) =>
					entry && typeof entry.key === 'string' && Number.isFinite(entry.expiresAt) &&
					entry.expiresAt <= Date.now() + HISTORY_CACHE_TTL_MS &&
					entry.page && typeof entry.page.year === 'number' &&
					typeof entry.page.timezone === 'string' && Array.isArray(entry.page.items) &&
					entry.page.summary && (entry.page.next_cursor === null || typeof entry.page.next_cursor === 'string')
				)
			) throw new Error('Invalid stored history cache.');
			pages.clear();
			for (const entry of entries) pages.set(entry.key, entry);
		} catch (error) {
			storageFailed = true;
			console.warn('Could not read history cache; continuing without persistent cache.', error);
		}
		prune();
	}

	function write(): void {
		prune();
		if (storageFailed) return;
		try {
			storage()?.setItem(storageKey, JSON.stringify([...pages.values()]));
		} catch (error) {
			storageFailed = true;
			console.warn('Could not save history cache; continuing with in-memory cache.', error);
		}
	}

	function subscribe(request: PendingPage, key: string, signal?: AbortSignal): Promise<HistoryPage> {
		request.readers++;
		return new Promise((resolve, reject) => {
			let settled = false;
			function finish(): boolean {
				if (settled) return false;
				settled = true;
				signal?.removeEventListener('abort', abort);
				request.readers--;
				return true;
			}
			function abort(): void {
				if (!finish()) return;
				if (request.readers === 0) {
					request.controller.abort();
					if (pending.get(key) === request) pending.delete(key);
				}
				reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
			}
			signal?.addEventListener('abort', abort, { once: true });
			if (signal?.aborted) abort();
			request.promise.then(
				(page) => { if (finish()) resolve(page); },
				(error: unknown) => { if (finish()) reject(error); }
			);
		});
	}

	return {
		async load(year, timeZone, cursor = null, signal) {
			signal?.throwIfAborted();
			const key = JSON.stringify([year, timeZone, cursor]);
			read();
			const cached = pages.get(key);
			if (cached) {
				pages.delete(key);
				pages.set(key, cached);
				write();
				return cached.page;
			}

			let request = pending.get(key);
			if (!request) {
				const controller = new AbortController();
				const version = generation;
				const params = new URLSearchParams({ year: String(year), timezone: timeZone, limit: '50' });
				if (cursor !== null) params.set('cursor', cursor);
				const next: PendingPage = {
					controller,
					readers: 0,
					promise: api.request<HistoryPage>(`/stats/history?${params}`, {
						method: 'GET', signal: controller.signal, cache: 'no-store'
					}).then((page) => {
						controller.signal.throwIfAborted();
						if ((userRevisions.get(userId) ?? 0) === version) {
							read();
							pages.delete(key);
							pages.set(key, { key, expiresAt: Date.now() + HISTORY_CACHE_TTL_MS, page });
							write();
						}
						return page;
					}).finally(() => {
						if (pending.get(key) === next) pending.delete(key);
					})
				};
				request = next;
				pending.set(key, request);
			}
			return subscribe(request, key, signal);
		},
		clear() {
			generation = (userRevisions.get(userId) ?? 0) + 1;
			userRevisions.set(userId, generation);
			pages.clear();
			pending.clear();
			try {
				storage()?.removeItem(storageKey);
			} catch (error) {
				storageFailed = true;
				console.warn('Could not clear stored history cache.', error);
			}
		}
	};
}
