import { ApiError, type ProblemDetails } from '#lib/api/client.js';
import type { HeapItem } from './types.js';

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
