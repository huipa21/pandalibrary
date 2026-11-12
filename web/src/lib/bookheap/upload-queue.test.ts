import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import type { HeapItem } from './types.js';
import type { assignHeapItems } from './api.js';
import {
	MAX_UPLOAD_BYTES,
	UploadQueue,
	classifyUploadError,
	filesFromDataTransfer,
	formatBytes,
	uploadPercent,
	type Uploader
} from './upload-queue.svelte.js';

function file(name: string, size = 10, lastModified = 1): File {
	const result = new File([new Uint8Array(Math.min(size, 16))], name, { lastModified });
	if (size !== result.size) Object.defineProperty(result, 'size', { value: size });
	return result;
}

function item(id: number, title: string): HeapItem {
	return {
		id, file_name: `${title}.epub`, rel_path: `${title}.epub`, format: 'epub', size_bytes: 10, sha256: 'a'.repeat(64),
		title, authors: [], language: null, series: null, series_index: null, has_cover: false, cover_url: null,
		source: 'upload', status: 'ready', error: null, duplicate_of_book_id: null, duplicate_of_item_id: null,
		target_library_id: null, target_shelf_ids: [], import_job_id: null, added_by: 1,
		created_at: '2026-11-06T05:00:00Z', updated_at: '2026-11-06T05:00:00Z'
	};
}

function problem(status: number, extra: Record<string, unknown> = {}): ApiError {
	const body = { title: 'error', status, ...extra };
	return new ApiError(status, 'error', JSON.stringify(body), body);
}

interface Call {
	file: File;
	signal: AbortSignal;
	onprogress: (loaded: number, total: number | null) => void;
	resolve: (item: HeapItem) => void;
	reject: (error: unknown) => void;
}

/** Uploader whose requests stay in flight until the test settles them. */
function controlledUploader() {
	const calls: Call[] = [];
	const upload: Uploader = (file, { signal, onprogress }) =>
		new Promise<HeapItem>((resolve, reject) => {
			calls.push({ file, signal, onprogress, resolve, reject });
			signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
		});
	return { calls, upload };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('UploadQueue adding files', () => {
	it('deduplicates by name, size and modification time on reselect and drop', () => {
		const queue = new UploadQueue({ upload: vi.fn() });
		const a = file('a.epub', 10, 1);
		expect(queue.add([a, file('b.pdf')])).toMatchObject({ added: 2, duplicates: 0 });
		expect(queue.add([file('a.epub', 10, 1), file('a.epub', 11, 1), file('a.epub', 10, 2), file('c.cbz')])).toMatchObject({ added: 3, duplicates: 1 });
		expect(queue.add([a, a])).toMatchObject({ added: 0, duplicates: 2 });
		expect(queue.rows.map((row) => row.file.name)).toEqual(['a.epub', 'b.pdf', 'a.epub', 'a.epub', 'c.cbz']);
		expect(queue.rows.every((row) => row.status === 'pending')).toBe(true);
	});

	it('filters unsupported and oversize files and reports them in a dismissible notice', () => {
		const queue = new UploadQueue({ upload: vi.fn(), maxBytes: 100 });
		const result = queue.add([file('ok.AZW3', 100), file('notes.txt'), file('.epub'), file('big.fb2', 101), file('ok.fbz'), file('x.mobi')], 2);
		expect(result).toEqual({ added: 3, duplicates: 0, unsupported: ['notes.txt', '.epub'], tooLarge: ['big.fb2'] });
		expect(queue.notice).toEqual({ unsupported: ['notes.txt', '.epub'], tooLarge: ['big.fb2'], ignored: 2 });
		queue.dismissNotice();
		expect(queue.notice).toBeNull();
		queue.add([file('fine.epub')]);
		expect(queue.notice).toBeNull();
		expect(new UploadQueue().maxBytes).toBe(MAX_UPLOAD_BYTES);
	});

	it('removes one row and clears all, but not rows or lists that are uploading', async () => {
		const { calls, upload } = controlledUploader();
		const queue = new UploadQueue({ upload, notify: vi.fn(), concurrency: 1 });
		queue.add([file('a.epub'), file('b.epub'), file('c.epub')]);
		const [, b] = queue.rows;
		expect(queue.remove(b.id)).toBe(true);
		expect(queue.rows.map((row) => row.file.name)).toEqual(['a.epub', 'c.epub']);
		expect(queue.totalBytes).toBe(20);

		const run = queue.start();
		expect(queue.rows[0].status).toBe('uploading');
		expect(queue.remove(queue.rows[0].id)).toBe(false);
		expect(queue.clear()).toBe(false);
		expect(queue.remove(queue.rows[1].id)).toBe(true);
		calls[0].resolve(item(1, 'A'));
		await run;
		expect(queue.clear()).toBe(true);
		expect(queue.rows).toEqual([]);
		expect(queue.remove(999)).toBe(false);
	});
});

describe('UploadQueue uploading', () => {
	it('assigns uploads to the library captured for the run, including files added during it', async () => {
		const { calls, upload } = controlledUploader();
		const assign = vi.fn<typeof assignHeapItems>().mockImplementation(async ({ ids }) =>
			ids.map((id) => ({ id, ok: true, error: null, import_job_id: 100 + id }))
		);
		const queue = new UploadQueue({ upload, assign, notify: vi.fn(), concurrency: 1 });
		queue.libraryId = 2;
		queue.add([file('a.epub')]);
		const run = queue.start();
		queue.libraryId = 3;
		queue.add([file('b.epub')]);
		calls[0].resolve(item(1, 'A'));
		await flush();
		calls[1].resolve(item(2, 'B'));
		await run;
		expect(assign.mock.calls.map(([input]) => input)).toEqual([
			{ ids: [1], library_id: 2, shelf_ids: [] },
			{ ids: [2], library_id: 2, shelf_ids: [] }
		]);
		expect(queue.rows.map((row) => row.status)).toEqual(['done', 'done']);
	});

	it.each(['http', 'rejected', 'missing'] as const)('retries %s assignment failures without uploading the file again', async (failure) => {
		const upload = vi.fn<Uploader>().mockResolvedValue(item(1, 'A'));
		const assign = vi.fn<typeof assignHeapItems>();
		if (failure === 'http') assign.mockRejectedValueOnce(problem(503));
		else assign.mockResolvedValueOnce(failure === 'missing' ? [] : [{ id: 1, ok: false, error: 'failed', import_job_id: null }]);
		assign.mockResolvedValueOnce([{ id: 1, ok: true, error: null, import_job_id: 101 }]);
		const notify = vi.fn();
		const queue = new UploadQueue({ upload, assign, notify });
		queue.libraryId = 2;
		queue.add([file('a.epub')]);
		await queue.start();
		expect(queue.rows[0]).toMatchObject({ status: 'error', item: { id: 1 }, libraryId: 2 });
		expect(queue.counts).toMatchObject({ failed: 1, retryable: 1, duplicates: 0 });
		expect(notify).toHaveBeenCalledTimes(1);
		queue.libraryId = 3;
		await queue.retryFailed();
		expect(upload).toHaveBeenCalledTimes(1);
		expect(assign).toHaveBeenLastCalledWith({ ids: [1], library_id: 2, shelf_ids: [] });
		expect(queue.counts).toMatchObject({ uploaded: 1, failed: 0 });
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it('uploads at most two files at a time and moves rows through every status', async () => {
		const { calls, upload } = controlledUploader();
		const notify = vi.fn();
		const queue = new UploadQueue({ upload, notify });
		queue.add([file('a.epub'), file('b.epub'), file('c.epub'), file('d.epub')]);
		const run = queue.start();
		expect(queue.running).toBe(true);
		expect(calls.map((call) => call.file.name)).toEqual(['a.epub', 'b.epub']);
		expect(queue.rows.map((row) => row.status)).toEqual(['uploading', 'uploading', 'pending', 'pending']);

		calls[0].onprogress(25, 100);
		expect(queue.rows[0]).toMatchObject({ loaded: 25, total: 100 });
		expect(uploadPercent(queue.rows[0])).toBe(25);
		calls[0].onprogress(5, null);
		expect(queue.rows[0]).toMatchObject({ loaded: 5, total: 10 });
		expect(uploadPercent(queue.rows[0])).toBe(50);

		calls[0].resolve(item(1, 'Alpha'));
		await flush();
		expect(queue.rows[0]).toMatchObject({ status: 'done', item: { title: 'Alpha' } });
		expect(uploadPercent(queue.rows[0])).toBe(100);
		expect(calls).toHaveLength(3);

		queue.add([file('late.epub')]);
		expect(calls).toHaveLength(3);
		calls[1].reject(new TypeError('Network request failed'));
		await flush();
		expect(calls.map((call) => call.file.name)).toEqual(['a.epub', 'b.epub', 'c.epub', 'd.epub']);
		calls[2].resolve(item(3, 'C'));
		await flush();
		expect(calls.at(-1)?.file.name).toBe('late.epub');
		calls[3].resolve(item(4, 'D'));
		calls[4].resolve(item(5, 'Late'));
		await run;

		expect(queue.running).toBe(false);
		expect(queue.rows.map((row) => row.status)).toEqual(['done', 'error', 'done', 'done', 'done']);
		expect(queue.counts).toMatchObject({ uploaded: 4, duplicates: 0, failed: 1, retryable: 1, pending: 0 });
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it('adds files to a run when only one upload is left in flight', async () => {
		const { calls, upload } = controlledUploader();
		const queue = new UploadQueue({ upload, notify: vi.fn() });
		queue.add([file('a.epub')]);
		const run = queue.start();
		queue.add([file('b.epub'), file('c.epub')]);
		expect(calls.map((call) => call.file.name)).toEqual(['a.epub', 'b.epub']);
		for (const call of calls) call.resolve(item(1, call.file.name));
		await flush();
		calls[2].resolve(item(3, 'C'));
		await run;
		expect(queue.counts.uploaded).toBe(3);
	});

	it('maps duplicate, size, format and server errors to localized kinds', async () => {
		const errors = [
			problem(409, { duplicate_of_book_id: 42 }),
			problem(409, { duplicate_of_item_id: 7 }),
			problem(413),
			problem(415),
			problem(503),
			new TypeError('offline')
		];
		const upload = vi.fn<Uploader>().mockImplementation(async () => {
			throw errors.shift();
		});
		const notify = vi.fn();
		const queue = new UploadQueue({ upload, notify });
		queue.add(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => file(`${name}.epub`)));
		await queue.start();
		expect(queue.rows.map((row) => [row.error, row.duplicateOf])).toEqual([
			['duplicate_book', 42], ['duplicate_item', 7], ['too_large', null], ['unsupported', null], ['server', null], ['network', null]
		]);
		expect(queue.counts).toMatchObject({ uploaded: 0, duplicates: 2, failed: 4, retryable: 2 });
		expect(notify).not.toHaveBeenCalled();
	});

	it('stops the queue on 401/403 and keeps the remaining rows pending', async () => {
		const upload = vi.fn<Uploader>().mockRejectedValueOnce(problem(401)).mockResolvedValue(item(2, 'B'));
		const queue = new UploadQueue({ upload, notify: vi.fn(), concurrency: 1 });
		queue.add([file('a.epub'), file('b.epub'), file('c.epub')]);
		await queue.start();
		expect(upload).toHaveBeenCalledTimes(1);
		expect(queue.stopped).toBe('unauthorized');
		expect(queue.rows.map((row) => row.status)).toEqual(['error', 'pending', 'pending']);
		expect(queue.rows[0].error).toBe('unauthorized');

		upload.mockRejectedValueOnce(problem(403));
		await queue.start();
		expect(queue.stopped).toBe('forbidden');
		expect(queue.rows.map((row) => row.status)).toEqual(['error', 'error', 'pending']);
	});

	it('retries only retryable failures and dispatches one change event per run', async () => {
		const upload = vi
			.fn<Uploader>()
			.mockRejectedValueOnce(problem(500))
			.mockRejectedValueOnce(problem(409, { duplicate_of_item_id: 3 }))
			.mockRejectedValueOnce(problem(415))
			.mockResolvedValueOnce(item(4, 'D'))
			.mockResolvedValueOnce(item(1, 'A'));
		const notify = vi.fn();
		const queue = new UploadQueue({ upload, notify, concurrency: 1 });
		queue.add([file('a.epub'), file('b.epub'), file('c.epub'), file('d.epub')]);
		await queue.start();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(queue.counts).toMatchObject({ uploaded: 1, retryable: 1 });

		await queue.retryFailed();
		expect(upload).toHaveBeenCalledTimes(5);
		expect(upload.mock.calls[4][0].name).toBe('a.epub');
		expect(queue.rows.map((row) => row.status)).toEqual(['done', 'error', 'error', 'done']);
		expect(queue.counts).toMatchObject({ uploaded: 2, duplicates: 1, failed: 1, retryable: 0 });
		expect(notify).toHaveBeenCalledTimes(2);

		await queue.retryFailed();
		expect(upload).toHaveBeenCalledTimes(5);
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it('aborts in-flight uploads on a confirmed close and leaves unstarted rows unsent', async () => {
		const { calls, upload } = controlledUploader();
		const notify = vi.fn();
		const queue = new UploadQueue({ upload, notify });
		queue.add([file('a.epub'), file('b.epub'), file('c.epub'), file('d.epub')]);
		const run = queue.start();
		calls[0].resolve(item(1, 'A'));
		await flush();
		expect(calls).toHaveLength(3);
		calls[1].onprogress(5, 10);

		await queue.abort();
		await run;
		expect(calls).toHaveLength(3);
		expect(calls.slice(1).every((call) => call.signal.aborted)).toBe(true);
		expect(queue.running).toBe(false);
		expect(queue.rows.map((row) => row.status)).toEqual(['done', 'pending', 'pending', 'pending']);
		expect(queue.rows[1].loaded).toBe(0);
		expect(notify).toHaveBeenCalledTimes(1);

		queue.dropDone();
		expect(queue.rows.map((row) => row.file.name)).toEqual(['b.epub', 'c.epub', 'd.epub']);
		await expect(queue.abort()).resolves.toBeUndefined();
	});
});

describe('upload helpers', () => {
	it('classifies 409 without a reference and other statuses', () => {
		expect(classifyUploadError(problem(409))).toEqual({ kind: 'duplicate', duplicateOf: null, stop: false });
		expect(classifyUploadError(problem(409, { duplicate_of_book_id: 'x' })).kind).toBe('duplicate');
		expect(classifyUploadError(problem(400)).kind).toBe('invalid');
		expect(classifyUploadError(problem(403))).toMatchObject({ kind: 'forbidden', stop: true });
		expect(classifyUploadError(problem(422)).kind).toBe('unknown');
		expect(classifyUploadError(new Error('boom')).kind).toBe('unknown');
	});

	it('reads dropped files and ignores directories and non-file items', () => {
		const a = file('a.epub');
		const entry = (isFile: boolean) => () => ({ isFile });
		const items = [
			{ kind: 'file', getAsFile: () => a, webkitGetAsEntry: entry(true) },
			{ kind: 'file', getAsFile: () => file('folder'), webkitGetAsEntry: entry(false) },
			{ kind: 'string', getAsFile: () => null }
		];
		expect(filesFromDataTransfer({ items })).toEqual({ files: [a], ignored: 1 });
		expect(filesFromDataTransfer({ items: [{ kind: 'string', getAsFile: () => null }] })).toEqual({ files: [], ignored: 1 });
		expect(filesFromDataTransfer({ items: [], files: [a] })).toEqual({ files: [a], ignored: 0 });
		expect(filesFromDataTransfer(null)).toEqual({ files: [], ignored: 0 });
	});

	it('formats sizes', () => {
		expect(formatBytes(512, 'en')).toBe('512 B');
		expect(formatBytes(13_002_342, 'en')).toBe('12.4 MB');
		expect(formatBytes(MAX_UPLOAD_BYTES, 'en')).toBe('1 GB');
	});
});
