import type { HeapItem, HeapItemStatus } from './types.js';
import { HEAP_PAGE_SIZE, listHeapItems, type HeapListOptions, type HeapPage } from './api.js';

/** Status filter values shown in the toolbar. `active` combines `queued` and `importing`. */
export const HEAP_STATUS_FILTERS = ['', 'ready', 'duplicate', 'invalid', 'active', 'failed'] as const;
export type HeapStatusFilter = (typeof HEAP_STATUS_FILTERS)[number];

/** Mirrors the server's search limit so a pasted URL cannot produce a rejected request. */
export const MAX_HEAP_QUERY_LENGTH = 200;

export interface HeapQuery {
	readonly status: HeapStatusFilter;
	readonly q: string;
}

export const EMPTY_HEAP_QUERY: HeapQuery = { status: '', q: '' };

export function isHeapStatusFilter(value: string): value is HeapStatusFilter {
	return (HEAP_STATUS_FILTERS as readonly string[]).includes(value);
}

/** Reads the filter from the page URL, ignoring unknown status values. */
export function heapQueryFromSearch(params: Pick<URLSearchParams, 'get'>): HeapQuery {
	const status = params.get('status') ?? '';
	const q = [...(params.get('q') ?? '').trim()].slice(0, MAX_HEAP_QUERY_LENGTH).join('');
	return { status: isHeapStatusFilter(status) ? status : '', q };
}

/** Writes the filter into a copy of `params`, dropping empty values. */
export function heapQueryToSearch(query: HeapQuery, params: { toString(): string } = new URLSearchParams()): URLSearchParams {
	const next = new URLSearchParams(params.toString());
	if (query.status) next.set('status', query.status);
	else next.delete('status');
	const q = query.q.trim();
	if (q) next.set('q', q);
	else next.delete('q');
	return next;
}

export function heapQueryKey(query: HeapQuery): string {
	return `${query.status}\u0000${query.q.trim()}`;
}

export function isFiltered(query: HeapQuery): boolean {
	return query.status !== '' || query.q.trim() !== '';
}

export type HeapLister = (options: HeapListOptions) => Promise<HeapPage>;

const ACTIVE_STATUSES = ['queued', 'importing'] as const satisfies readonly HeapItemStatus[];
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

/** Cursor for the combined Queued/Importing filter: a server cursor per status, or null once exhausted. */
interface ActiveCursor {
	readonly c: Record<ActiveStatus, string | null>;
	readonly t: Record<ActiveStatus, number>;
}

function parseActiveCursor(cursor: string): ActiveCursor {
	const parsed = JSON.parse(cursor) as ActiveCursor;
	if (typeof parsed !== 'object' || parsed === null || typeof parsed.c !== 'object' || typeof parsed.t !== 'object') {
		throw new Error('Invalid Bookheap cursor');
	}
	return parsed;
}

export function compareHeapItems(a: HeapItem, b: HeapItem): number {
	if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
	return b.id - a.id;
}

/**
 * Fetches one page for the toolbar filter. The server filters by a single status, so the combined
 * Queued/Importing filter pages both statuses side by side and merges them in list order.
 */
export async function fetchHeapPage(
	query: HeapQuery,
	cursor: string | null,
	signal?: AbortSignal,
	list: HeapLister = listHeapItems,
	limit = HEAP_PAGE_SIZE
): Promise<HeapPage> {
	const q = query.q.trim() || undefined;
	if (query.status !== 'active') {
		return list({ status: query.status || undefined, q, cursor, limit, signal });
	}
	const state: ActiveCursor = cursor === null
		? { c: { queued: '', importing: '' }, t: { queued: 0, importing: 0 } }
		: parseActiveCursor(cursor);
	const next: ActiveCursor = { c: { ...state.c }, t: { ...state.t } };
	const pages = await Promise.all(
		ACTIVE_STATUSES.map(async (status) => {
			const statusCursor = state.c[status];
			if (statusCursor === null) return null;
			const page = await list({ status, q, cursor: statusCursor || null, limit, signal });
			next.c[status] = page.next_cursor;
			next.t[status] = page.total;
			return page;
		})
	);
	const items = pages.flatMap((page) => page?.items ?? []).sort(compareHeapItems);
	const more = ACTIVE_STATUSES.some((status) => next.c[status] !== null);
	return { items, next_cursor: more ? JSON.stringify(next) : null, total: next.t.queued + next.t.importing };
}
