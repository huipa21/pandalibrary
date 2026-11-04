import { api } from '#lib/api/client.js';
import { buildPagePath, type PageOptions } from '#lib/catalog/api.js';
import type { Book, Page } from '#lib/catalog/types.js';
import type { PageFetcher } from '#lib/paging/CursorPager.svelte.js';
import type { BuiltInSection } from './layout.js';

export const DASHBOARD_PAGE_SIZE = 12;

export function buildDashboardBooksPath(section: BuiltInSection, options: PageOptions = {}): string {
	return buildPagePath(`/dashboard/sections/${section}/books`, {
		limit: DASHBOARD_PAGE_SIZE,
		...options
	});
}

export function listDashboardBooks(
	section: BuiltInSection,
	options: PageOptions & { signal?: AbortSignal } = {}
): Promise<Page<Book>> {
	return api.request(buildDashboardBooksPath(section, options), { signal: options.signal });
}

/** Deduplicates live pages and rejects loops without interpreting the server's cursor. */
export function uniquePages<T extends { id: number }>(fetcher: PageFetcher<T>): PageFetcher<T> {
	const seenItems = new Set<number>();
	const seenCursors = new Set<string>();
	return async (cursor, signal) => {
		if (cursor === null) {
			seenItems.clear();
			seenCursors.clear();
		}
		const page = await fetcher(cursor, signal);
		if (signal.aborted) throw new DOMException('Request aborted.', 'AbortError');
		if (page.next_cursor !== null && seenCursors.has(page.next_cursor)) {
			throw new Error('The server returned a repeated pagination cursor.');
		}
		if (page.next_cursor !== null) seenCursors.add(page.next_cursor);
		const items = page.items.filter((item) => {
			if (seenItems.has(item.id)) return false;
			seenItems.add(item.id);
			return true;
		});
		return { items, next_cursor: page.next_cursor };
	};
}
