import type { HeapItem } from './types.js';

/** Builds a Bookheap item for unit tests. */
export function heapItem(id: number, overrides: Partial<HeapItem> = {}): HeapItem {
	return {
		id,
		file_name: `book-${id}.epub`,
		rel_path: `book-${id}.epub`,
		format: 'epub',
		size_bytes: 1024,
		sha256: `sha-${id}`,
		title: `Book ${id}`,
		authors: [],
		language: null,
		series: null,
		series_index: null,
		has_cover: false,
		cover_url: null,
		source: 'scan',
		status: 'ready',
		error: null,
		duplicate_of_book_id: null,
		duplicate_of_item_id: null,
		target_library_id: null,
		target_shelf_ids: [],
		import_job_id: null,
		added_by: 1,
		created_at: `2026-01-01T00:00:${String(id % 60).padStart(2, '0')}Z`,
		updated_at: '2026-01-01T00:00:00Z',
		...overrides
	};
}
