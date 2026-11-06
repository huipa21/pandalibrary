import { api, ApiError, type ProblemDetails } from '#lib/api/client.js';
import type { HeapItem, HeapItemStatus } from './types.js';

export const BOOKHEAP_FILES_PATH = '/api/v1/admin/bookheap/files';

/** Minimal XMLHttpRequest surface used by `uploadHeapFile`, so tests can supply a fake. */
export interface UploadRequest {
	open(method: string, url: string): void;
	send(body: FormData): void;
	abort(): void;
	getResponseHeader(name: string): string | null;
	withCredentials: boolean;
	readonly status: number;
	readonly statusText: string;
	readonly responseText: string;
	readonly upload: { onprogress: ((event: ProgressEvent) => void) | null };
	onload: (() => void) | null;
	onerror: (() => void) | null;
	onabort: (() => void) | null;
	ontimeout: (() => void) | null;
}

export interface UploadHeapFileOptions {
	readonly signal?: AbortSignal;
	/** Called with bytes sent so far and the total request size when known. */
	readonly onprogress?: (loaded: number, total: number | null) => void;
	readonly createRequest?: () => UploadRequest;
}

function isProblemDetails(value: unknown): value is ProblemDetails {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		(candidate.type === undefined || typeof candidate.type === 'string') &&
		(candidate.title === undefined || typeof candidate.title === 'string') &&
		(candidate.status === undefined || typeof candidate.status === 'number') &&
		(candidate.detail === undefined || typeof candidate.detail === 'string') &&
		(candidate.instance === undefined || typeof candidate.instance === 'string')
	);
}

/** Mirrors `client.ts` problem parsing for an XMLHttpRequest response. */
export function apiErrorFromResponse(status: number, statusText: string, contentType: string | null, body: string): ApiError {
	const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase();
	if (mediaType !== 'application/problem+json') return new ApiError(status, statusText, body);
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		parsed = undefined;
	}
	if (!isProblemDetails(parsed)) {
		return new ApiError(status, statusText, body, undefined, `HTTP ${status}: invalid application/problem+json response`);
	}
	return new ApiError(status, statusText, body, parsed);
}

function abortError(): DOMException {
	return new DOMException('The upload was aborted.', 'AbortError');
}

/**
 * Uploads one file into the Bookheap (`POST /api/v1/admin/bookheap/files`, single multipart part
 * `file`). XMLHttpRequest is used instead of fetch so upload progress is observable. Rejects with
 * `ApiError` for HTTP errors, a `TypeError` for network failures and an `AbortError` when aborted.
 */
export function uploadHeapFile(
	file: File,
	{ signal, onprogress, createRequest = () => new XMLHttpRequest() as unknown as UploadRequest }: UploadHeapFileOptions = {}
): Promise<HeapItem> {
	return new Promise<HeapItem>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const request = createRequest();
		const onAbortSignal = () => request.abort();
		const settle = (action: () => void) => {
			signal?.removeEventListener('abort', onAbortSignal);
			action();
		};

		request.open('POST', BOOKHEAP_FILES_PATH);
		request.withCredentials = true;
		request.upload.onprogress = (event) => onprogress?.(event.loaded, event.lengthComputable ? event.total : null);
		request.onload = () =>
			settle(() => {
				if (request.status < 200 || request.status >= 300) {
					reject(apiErrorFromResponse(request.status, request.statusText, request.getResponseHeader('content-type'), request.responseText));
					return;
				}
				try {
					const body = JSON.parse(request.responseText) as { item?: HeapItem };
					if (!body.item || typeof body.item !== 'object') throw new Error('missing item');
					resolve(body.item);
				} catch {
					reject(new ApiError(request.status, request.statusText, request.responseText, undefined, `HTTP ${request.status}: invalid upload response`));
				}
			});
		request.onerror = () => settle(() => reject(new TypeError('Network request failed')));
		request.ontimeout = request.onerror;
		request.onabort = () => settle(() => reject(abortError()));
		signal?.addEventListener('abort', onAbortSignal, { once: true });

		const form = new FormData();
		form.append('file', file, file.name);
		request.send(form);
	});
}

// ---- BH4: list, scan, delete and assign (plan contract; assign is BH2's endpoint) ----

/** Path below `/api/v1` used with the shared JSON client. */
const BOOKHEAP_API = '/admin/bookheap';
export const HEAP_PAGE_SIZE = 50;
/** Server limit for bulk delete/assign requests. */
export const MAX_BULK_IDS = 500;
/** Server limit for shelves in one assign request. */
export const MAX_ASSIGN_SHELVES = 20;

export type HeapScanStatus = 'running' | 'completed' | 'failed';

/** In-memory scan status from `GET/POST /api/v1/admin/bookheap/scan`. */
export interface HeapScan {
	readonly id: number;
	readonly status: HeapScanStatus;
	readonly started_at: string;
	readonly finished_at: string | null;
	readonly added: number;
	readonly updated: number;
	readonly removed: number;
	readonly unchanged: number;
	readonly invalid: number;
	readonly duplicates: number;
	readonly skipped: number;
	readonly in_progress: number;
	readonly error: string | null;
}

export interface HeapPage {
	readonly items: HeapItem[];
	readonly next_cursor: string | null;
	readonly total: number;
}

export interface HeapListOptions {
	readonly status?: HeapItemStatus;
	readonly q?: string;
	readonly limit?: number;
	readonly cursor?: string | null;
	readonly signal?: AbortSignal;
}

/** Per-item outcome of a bulk request. */
export interface HeapItemResult {
	readonly id: number;
	readonly ok: boolean;
	readonly error: string | null;
}

export interface HeapAssignResult extends HeapItemResult {
	readonly import_job_id: number | null;
}

export interface HeapAssignInput {
	readonly ids: readonly number[];
	readonly library_id: number;
	readonly shelf_ids: readonly number[];
}

export function buildHeapItemsPath({ status, q, limit = HEAP_PAGE_SIZE, cursor }: Omit<HeapListOptions, 'signal'> = {}): string {
	const params = new URLSearchParams();
	if (status) params.set('status', status);
	const query = q?.trim();
	if (query) params.set('q', query);
	params.set('limit', String(Math.max(1, Math.min(limit, 100))));
	if (cursor !== undefined && cursor !== null) params.set('cursor', cursor);
	return `${BOOKHEAP_API}/items?${params.toString()}`;
}

export async function listHeapItems(options: HeapListOptions = {}): Promise<HeapPage> {
	return api.request<HeapPage>(buildHeapItemsPath(options), { signal: options.signal });
}

export async function getHeapItem(id: number, signal?: AbortSignal): Promise<HeapItem> {
	return (await api.request<{ item: HeapItem }>(`${BOOKHEAP_API}/items/${id}`, { signal })).item;
}

/** Starts a scan, or returns the one already running. */
export async function startHeapScan(): Promise<HeapScan> {
	return (await api.request<{ scan: HeapScan }>(`${BOOKHEAP_API}/scan`, { method: 'POST' })).scan;
}

/** Latest scan of this server process, or null when none ran yet. */
export async function getHeapScan(signal?: AbortSignal): Promise<HeapScan | null> {
	return (await api.request<{ scan: HeapScan | null }>(`${BOOKHEAP_API}/scan`, { signal })).scan;
}

export async function deleteHeapItems(ids: readonly number[]): Promise<HeapItemResult[]> {
	return (
		await api.request<{ results: HeapItemResult[] }>(`${BOOKHEAP_API}/items/delete`, {
			method: 'POST',
			body: { ids: [...ids] }
		})
	).results;
}

export async function assignHeapItems({ ids, library_id, shelf_ids }: HeapAssignInput): Promise<HeapAssignResult[]> {
	return (
		await api.request<{ results: HeapAssignResult[] }>(`${BOOKHEAP_API}/assign`, {
			method: 'POST',
			body: { ids: [...ids], library_id, shelf_ids: [...shelf_ids] }
		})
	).results;
}

/** Thumbnail URL for a heap item's cover, or null when it has none. */
export function heapThumbnailUrl(item: Pick<HeapItem, 'has_cover' | 'cover_url'>): string | null {
	if (!item.has_cover || !item.cover_url) return null;
	return `${item.cover_url}${item.cover_url.includes('?') ? '&' : '?'}thumbnail=1`;
}