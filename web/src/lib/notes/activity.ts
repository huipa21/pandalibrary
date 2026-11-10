import { api } from '#lib/api/client.js';
import type { InkData, PageAnnotationLocator } from '#lib/reader/types.js';

interface Activity {
	readonly id: string;
	readonly book_id: number;
	readonly book_title: string;
	readonly cover_url: string | null;
	readonly content: string;
	readonly anchor?: string;
	readonly book_file_id?: number;
	readonly highlight_id?: string;
	readonly created_at: string;
	readonly updated_at: string;
}

export type PersonalActivity = Activity & (
	| { readonly kind: 'ink'; readonly data: InkData; readonly locator: PageAnnotationLocator }
	| { readonly kind: 'text' | 'image'; readonly locator: PageAnnotationLocator }
	| { readonly kind: 'review' | 'comment' | 'book_note' | 'highlight' | 'underline' | 'strikeout' }
);

export interface PersonalActivityPage {
	readonly items: PersonalActivity[];
	readonly next_cursor: string | null;
}

export function listPersonalActivity(options: {
	cursor?: string | null;
	limit?: number;
	signal?: AbortSignal;
} = {}): Promise<PersonalActivityPage> {
	const limit = options.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new RangeError('Activity page limit must be between 1 and 100.');
	}
	const params = new URLSearchParams({ limit: String(limit) });
	if (options.cursor) params.set('cursor', options.cursor);
	return api.request(`/me/notes?${params}`, options.signal === undefined ? {} : { signal: options.signal });
}