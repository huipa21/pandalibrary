/** Status of a Bookheap item; see the Bookheap plan's `HeapItem` DTO. */
export type HeapItemStatus = 'ready' | 'duplicate' | 'invalid' | 'queued' | 'importing' | 'failed';

/** `upload` for files sent through the API, `scan` for files discovered in the heap folder. */
export type HeapItemSource = 'upload' | 'scan';

/** Bookheap staging item. Timestamps are RFC3339 UTC. */
export interface HeapItem {
	readonly id: number;
	readonly file_name: string;
	readonly rel_path: string;
	/** `null` for `invalid` items. */
	readonly format: string | null;
	readonly size_bytes: number;
	readonly sha256: string;
	/** Falls back to the file name without its extension when metadata has none. */
	readonly title: string;
	readonly authors: string[];
	readonly language: string | null;
	readonly series: string | null;
	readonly series_index: number | null;
	readonly has_cover: boolean;
	readonly cover_url: string | null;
	readonly source: HeapItemSource;
	readonly status: HeapItemStatus;
	readonly error: string | null;
	readonly duplicate_of_book_id: number | null;
	readonly duplicate_of_item_id: number | null;
	readonly target_library_id: number | null;
	readonly target_shelf_ids: number[];
	readonly import_job_id: number | null;
	readonly added_by: number | null;
	readonly created_at: string;
	readonly updated_at: string;
}
