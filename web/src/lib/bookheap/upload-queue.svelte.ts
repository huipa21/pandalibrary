import { ApiError } from '#lib/api/client.js';
import { uploadHeapFile } from './api.js';
import { notifyBookheapChanged } from './events.js';
import type { HeapItem } from './types.js';

/** Formats the extract registry sniffs; the server remains authoritative. */
export const SUPPORTED_EXTENSIONS = ['.epub', '.pdf', '.mobi', '.azw3', '.fb2', '.fbz', '.cbz'] as const;
export const UPLOAD_ACCEPT = SUPPORTED_EXTENSIONS.join(',');
/** Mirrors the server's default `--max-upload-mb` (1024 MiB); the server remains authoritative. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_CONCURRENCY = 2;

export type UploadRowStatus = 'pending' | 'uploading' | 'done' | 'error';

export type UploadErrorKind =
	| 'duplicate_book'
	| 'duplicate_item'
	| 'duplicate'
	| 'too_large'
	| 'unsupported'
	| 'invalid'
	| 'unauthorized'
	| 'forbidden'
	| 'network'
	| 'server'
	| 'unknown';

export interface UploadRow {
	readonly id: number;
	readonly key: string;
	readonly file: File;
	status: UploadRowStatus;
	/** Bytes sent and request size reported by the last progress event. */
	loaded: number;
	total: number;
	item: HeapItem | null;
	error: UploadErrorKind | null;
	/** Book or Bookheap item id for duplicate errors. */
	duplicateOf: number | null;
}

export interface UploadNotice {
	readonly unsupported: string[];
	readonly tooLarge: string[];
	/** Dropped directories and non-file items. */
	readonly ignored: number;
}

export interface AddResult {
	readonly added: number;
	readonly duplicates: number;
	readonly unsupported: string[];
	readonly tooLarge: string[];
}

export type Uploader = (
	file: File,
	options: { signal: AbortSignal; onprogress: (loaded: number, total: number | null) => void }
) => Promise<HeapItem>;

export interface UploadQueueOptions {
	readonly upload?: Uploader;
	readonly notify?: () => void;
	readonly concurrency?: number;
	readonly maxBytes?: number;
}

export function fileKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
	return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export function hasSupportedExtension(name: string): boolean {
	const lower = name.toLowerCase();
	return SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension) && lower.length > extension.length);
}

export function formatBytes(bytes: number, locale?: string): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let size = bytes / 1024;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`;
}

function positiveId(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Maps an upload failure to a localized error kind; `stop` halts the rest of the queue. */
export function classifyUploadError(error: unknown): { kind: UploadErrorKind; duplicateOf: number | null; stop: boolean } {
	if (error instanceof ApiError) {
		switch (error.status) {
			case 409: {
				const book = positiveId(error.problem?.duplicate_of_book_id);
				if (book !== null) return { kind: 'duplicate_book', duplicateOf: book, stop: false };
				const item = positiveId(error.problem?.duplicate_of_item_id);
				if (item !== null) return { kind: 'duplicate_item', duplicateOf: item, stop: false };
				return { kind: 'duplicate', duplicateOf: null, stop: false };
			}
			case 413:
				return { kind: 'too_large', duplicateOf: null, stop: false };
			case 415:
				return { kind: 'unsupported', duplicateOf: null, stop: false };
			case 400:
				return { kind: 'invalid', duplicateOf: null, stop: false };
			case 401:
				return { kind: 'unauthorized', duplicateOf: null, stop: true };
			case 403:
				return { kind: 'forbidden', duplicateOf: null, stop: true };
		}
		return { kind: error.status >= 500 ? 'server' : 'unknown', duplicateOf: null, stop: false };
	}
	return { kind: error instanceof TypeError ? 'network' : 'unknown', duplicateOf: null, stop: false };
}

export function isDuplicateError(kind: UploadErrorKind | null): boolean {
	return kind === 'duplicate_book' || kind === 'duplicate_item' || kind === 'duplicate';
}

/** Errors that may succeed on a later attempt without changing the file. */
export function isRetryableError(kind: UploadErrorKind | null): boolean {
	return kind === 'network' || kind === 'server' || kind === 'unknown' || kind === 'unauthorized' || kind === 'forbidden';
}

function isAbortError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

interface DropItem {
	readonly kind: string;
	getAsFile(): File | null;
	webkitGetAsEntry?: () => { readonly isFile: boolean } | null;
}

/**
 * Reads files from a drop. Directories are ignored; string items (links, text) are ignored and
 * reported only when the drop carries no file items, because file managers often add them.
 */
export function filesFromDataTransfer(transfer: {
	readonly items?: ArrayLike<DropItem> | null;
	readonly files?: ArrayLike<File> | null;
} | null): { files: File[]; ignored: number } {
	if (!transfer) return { files: [], ignored: 0 };
	const items = transfer.items ? Array.from(transfer.items) : [];
	if (items.length === 0) return { files: Array.from(transfer.files ?? []), ignored: 0 };
	const files: File[] = [];
	let ignored = 0;
	let strings = 0;
	let fileItems = 0;
	for (const item of items) {
		if (item.kind !== 'file') {
			strings += 1;
			continue;
		}
		fileItems += 1;
		const entry = item.webkitGetAsEntry?.();
		const file = entry && !entry.isFile ? null : item.getAsFile();
		if (file) files.push(file);
		else ignored += 1;
	}
	return { files, ignored: fileItems === 0 ? ignored + strings : ignored };
}

interface Run {
	readonly controller: AbortController;
	readonly done: Promise<void>;
	readonly finish: () => void;
	halted: boolean;
	uploaded: number;
}

/**
 * Upload list and queue for the Bookheap dialog. Files are deduplicated by name, size and
 * modification time, uploaded `concurrency` at a time, and files added during a run join it.
 */
export class UploadQueue {
	rows = $state<UploadRow[]>([]);
	running = $state(false);
	notice = $state<UploadNotice | null>(null);
	/** Set when a 401/403 halted the last run; pending rows are kept. */
	stopped = $state<'unauthorized' | 'forbidden' | null>(null);

	readonly #upload: Uploader;
	readonly #notify: () => void;
	readonly #concurrency: number;
	readonly #maxBytes: number;
	#nextId = 1;
	#active = 0;
	#run: Run | null = null;

	constructor({ upload = uploadHeapFile, notify = notifyBookheapChanged, concurrency = UPLOAD_CONCURRENCY, maxBytes = MAX_UPLOAD_BYTES }: UploadQueueOptions = {}) {
		this.#upload = upload;
		this.#notify = () => notify();
		this.#concurrency = Math.max(1, concurrency);
		this.#maxBytes = maxBytes;
	}

	get maxBytes(): number {
		return this.#maxBytes;
	}

	get totalBytes(): number {
		return this.rows.reduce((sum, row) => sum + row.file.size, 0);
	}

	get counts(): { pending: number; uploading: number; uploaded: number; duplicates: number; failed: number; retryable: number } {
		const counts = { pending: 0, uploading: 0, uploaded: 0, duplicates: 0, failed: 0, retryable: 0 };
		for (const row of this.rows) {
			if (row.status === 'pending') counts.pending += 1;
			else if (row.status === 'uploading') counts.uploading += 1;
			else if (row.status === 'done') counts.uploaded += 1;
			else if (isDuplicateError(row.error)) counts.duplicates += 1;
			else {
				counts.failed += 1;
				if (isRetryableError(row.error)) counts.retryable += 1;
			}
		}
		return counts;
	}

	/** Appends supported, new files; rejected names are reported through `notice`. */
	add(files: Iterable<File>, ignored = 0): AddResult {
		const known = new Set(this.rows.map((row) => row.key));
		const unsupported: string[] = [];
		const tooLarge: string[] = [];
		let added = 0;
		let duplicates = 0;
		for (const file of files) {
			const key = fileKey(file);
			if (known.has(key)) {
				duplicates += 1;
				continue;
			}
			if (!hasSupportedExtension(file.name)) {
				unsupported.push(file.name);
				continue;
			}
			if (file.size > this.#maxBytes) {
				tooLarge.push(file.name);
				continue;
			}
			known.add(key);
			this.rows.push({ id: this.#nextId++, key, file, status: 'pending', loaded: 0, total: file.size, item: null, error: null, duplicateOf: null });
			added += 1;
		}
		if (unsupported.length > 0 || tooLarge.length > 0 || ignored > 0) this.notice = { unsupported, tooLarge, ignored };
		if (added > 0) this.#pump();
		return { added, duplicates, unsupported, tooLarge };
	}

	/** Removes one row unless it is being uploaded. */
	remove(id: number): boolean {
		const index = this.rows.findIndex((row) => row.id === id);
		if (index === -1 || this.rows[index].status === 'uploading') return false;
		this.rows.splice(index, 1);
		return true;
	}

	/** Removes every row; ignored while uploading. */
	clear(): boolean {
		if (this.running) return false;
		this.rows = [];
		this.stopped = null;
		return true;
	}

	/** Drops successfully uploaded rows, keeping pending and failed rows for later. */
	dropDone(): void {
		if (this.rows.some((row) => row.status === 'done')) this.rows = this.rows.filter((row) => row.status !== 'done');
	}

	dismissNotice(): void {
		this.notice = null;
	}

	/** Uploads every pending row; resolves when the run ends. Files added meanwhile join the run. */
	start(): Promise<void> {
		const current = this.#run;
		if (current) {
			this.#pump();
			return current.done;
		}
		let finish!: () => void;
		const done = new Promise<void>((resolve) => (finish = resolve));
		this.#run = { controller: new AbortController(), done, finish, halted: false, uploaded: 0 };
		this.running = true;
		this.stopped = null;
		this.#pump();
		return done;
	}

	/** Re-queues retryable failures and starts uploading them. */
	retryFailed(): Promise<void> {
		for (const row of this.rows) {
			if (row.status === 'error' && isRetryableError(row.error)) this.#reset(row);
		}
		return this.start();
	}

	/** Aborts in-flight uploads and leaves unstarted rows pending; resolves when the run has ended. */
	abort(): Promise<void> {
		const run = this.#run;
		if (!run) return Promise.resolve();
		run.halted = true;
		run.controller.abort();
		return run.done;
	}

	#reset(row: UploadRow): void {
		row.status = 'pending';
		row.loaded = 0;
		row.total = row.file.size;
		row.error = null;
		row.duplicateOf = null;
	}

	#pump(): void {
		const run = this.#run;
		if (!run) return;
		while (!run.halted && this.#active < this.#concurrency) {
			const row = this.rows.find((candidate) => candidate.status === 'pending');
			if (!row) break;
			this.#active += 1;
			void this.#send(run, row);
		}
		if (this.#active === 0) this.#finish(run);
	}

	async #send(run: Run, row: UploadRow): Promise<void> {
		row.status = 'uploading';
		row.loaded = 0;
		row.error = null;
		try {
			const item = await this.#upload(row.file, {
				signal: run.controller.signal,
				onprogress: (loaded, total) => {
					row.total = total ?? row.file.size;
					row.loaded = Math.min(loaded, row.total);
				}
			});
			row.status = 'done';
			row.loaded = row.total;
			row.item = item;
			run.uploaded += 1;
		} catch (error) {
			if (run.controller.signal.aborted && isAbortError(error)) {
				this.#reset(row);
			} else {
				const failure = classifyUploadError(error);
				row.status = 'error';
				row.error = failure.kind;
				row.duplicateOf = failure.duplicateOf;
				if (failure.stop) {
					run.halted = true;
					this.stopped = failure.kind as 'unauthorized' | 'forbidden';
				}
			}
		} finally {
			this.#active -= 1;
			this.#pump();
		}
	}

	#finish(run: Run): void {
		if (this.#run !== run) return;
		this.#run = null;
		this.running = false;
		if (run.uploaded > 0) this.#notify();
		run.finish();
	}
}

/** Shared queue so the header dialog and the Bookheap page show the same uploads until reload. */
export const uploadQueue = new UploadQueue();

export function uploadPercent(row: Pick<UploadRow, 'loaded' | 'total'>): number {
	if (row.total <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((row.loaded / row.total) * 100)));
}
