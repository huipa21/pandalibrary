import type { JsonValue } from '#lib/api/client.js';
import type { Book } from '#lib/catalog/types.js';
import type { Bookmark, Highlight, Note, PageAnnotation, Progress, Setting } from '#lib/reader/types.js';

export const SYNC_SCHEMA = 2;

export interface OfflineViewer {
	id: number;
	username: string;
	display_name: string;
	role: string;
	locale: 'en' | 'zh';
}

export type SyncMutation = {
	entity: 'user_books' | 'reading_progress' | 'highlights' | 'bookmarks' | 'page_annotations' | 'notes' | 'user_settings' | 'reading_sessions';
	op: 'upsert' | 'delete';
	data: { [key: string]: JsonValue };
	updated_at: number;
} & ({ id: string } | { key: string });

export interface OutboxEntry {
	sequence: number;
	account: number;
	mutation: SyncMutation;
	status: 'pending' | 'applied' | 'stale' | 'rejected';
	reason?: string;
	conflictChecked?: boolean;
}

export interface UserBookRow {
	book_id: number;
	status: string;
	rating: number | null;
	started_at: string | null;
	finished_at: string | null;
	updated_at: string;
	rev: number;
	reading_cycle?: number;
	resume_status?: 'reading' | 'rereading';
}

export type ProgressRow = Progress & { book_id: number };

export interface PullResponse {
	cursor: number;
	user_books: UserBookRow[];
	reading_progress: ProgressRow[];
	highlights: Highlight[];
	bookmarks: Bookmark[];
	page_annotations: PageAnnotation[];
	notes: Note[];
	user_settings: Setting[];
}

export type StoredRow =
	| { account: number; entity: 'user_books'; key: string; value: UserBookRow }
	| { account: number; entity: 'reading_progress'; key: string; value: ProgressRow }
	| { account: number; entity: 'highlights'; key: string; value: Highlight }
	| { account: number; entity: 'bookmarks'; key: string; value: Bookmark }
	| { account: number; entity: 'page_annotations'; key: string; value: PageAnnotation }
	| { account: number; entity: 'notes'; key: string; value: Note }
	| { account: number; entity: 'user_settings'; key: string; value: Setting };

export interface StoredBook {
	account: number;
	bookId: number;
	book: Book;
	cover: Blob | null;
}

export interface StoredFile {
	account: number;
	bookId: number;
	fileId: number;
	url: string;
	blob: Blob;
}

export interface DownloadedBook {
	book: Book;
	fileIds: number[];
	cover: Blob | null;
}

export interface CursorState {
	cursor: number;
	pulledAt: number;
	schema?: number;
}

export interface MutationResult {
	index: number;
	status: 'applied' | 'stale' | 'rejected';
	reason?: string;
}
