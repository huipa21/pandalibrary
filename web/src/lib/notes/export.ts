import { ApiError, type ProblemDetails } from '#lib/api/client.js';

/** E1 accepts 1–100 distinct positive book IDs in one `book_ids` parameter. */
export const MAX_EXPORT_BOOKS = 100;
export const EXPORT_PATH = '/api/v1/me/notes/export';

export type ExportFormat = 'markdown' | 'zip';

export function exportFormat(count: number): ExportFormat {
	return count > 1 ? 'zip' : 'markdown';
}

export interface SelectionChange {
	selection: number[];
	/** True when the request would have exceeded the export limit and was capped. */
	limited: boolean;
}

/** Toggles a book in the selection, refusing to grow it beyond the limit. */
export function toggleBook(selection: readonly number[], bookId: number, max = MAX_EXPORT_BOOKS): SelectionChange {
	if (selection.includes(bookId)) return { selection: selection.filter((id) => id !== bookId), limited: false };
	if (selection.length >= max) return { selection: [...selection], limited: true };
	return { selection: [...selection, bookId], limited: false };
}

/** Selects every distinct visible book, in result order, up to the limit. */
export function selectBooks(bookIds: readonly number[], max = MAX_EXPORT_BOOKS): SelectionChange {
	const distinct = [...new Set(bookIds)];
	return { selection: distinct.slice(0, max), limited: distinct.length > max };
}

function validBookId(id: number): boolean {
	return Number.isSafeInteger(id) && id > 0;
}

/** Builds E1's exact route with exactly one comma-separated `book_ids` parameter. */
export function buildExportPath(bookIds: readonly number[]): string {
	if (
		bookIds.length < 1 ||
		bookIds.length > MAX_EXPORT_BOOKS ||
		new Set(bookIds).size !== bookIds.length ||
		!bookIds.every(validBookId)
	) {
		throw new RangeError(`Select between 1 and ${MAX_EXPORT_BOOKS} distinct book IDs.`);
	}
	return `${EXPORT_PATH}?${new URLSearchParams({ book_ids: bookIds.join(',') })}`;
}

function splitParameters(header: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quoted = false;
	for (let index = 0; index < header.length; index += 1) {
		const char = header[index];
		if (quoted && char === '\\' && index + 1 < header.length) {
			current += char + header[index + 1];
			index += 1;
		} else if (char === '"') {
			quoted = !quoted;
			current += char;
		} else if (char === ';' && !quoted) {
			parts.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(.)/g, '$1');
	}
	return value;
}

function decodeExtendedValue(value: string): string | null {
	const match = /^([^']*)'[^']*'(.*)$/.exec(value);
	if (!match) return null;
	const charset = match[1].toLowerCase();
	const encoded = match[2];
	try {
		if (charset === 'utf-8') return decodeURIComponent(encoded);
		if (charset === 'iso-8859-1') {
			return encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Extracts the attachment filename, preferring RFC 5987 `filename*` (used by the server
 * for Unicode titles) over the plain `filename` parameter.
 */
export function parseContentDispositionFilename(header: string | null): string | null {
	if (!header) return null;
	let plain: string | null = null;
	let extended: string | null = null;
	for (const part of splitParameters(header).slice(1)) {
		const separator = part.indexOf('=');
		if (separator < 0) continue;
		const name = part.slice(0, separator).trim().toLowerCase();
		const value = part.slice(separator + 1).trim();
		if (name === 'filename*' && extended === null) extended = decodeExtendedValue(unquote(value));
		else if (name === 'filename' && plain === null) plain = unquote(value);
	}
	return extended || plain || null;
}

/**
 * Keeps the server-provided name but strips anything that could act as a path or
 * control sequence, falling back when nothing usable remains.
 */
export function safeDownloadName(name: string | null, fallback: string): string {
	const cleaned = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\]/g, '_').trim();
	return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

export function fallbackFilename(format: ExportFormat): string {
	return format === 'zip' ? 'PandaLibrary notes.zip' : 'PandaLibrary notes.md';
}

export type ExportErrorKind = 'invalid' | 'unauthorized' | 'not_found' | 'too_large' | 'unexpected' | 'api' | 'connection';

export class ExportError extends Error {
	readonly kind: ExportErrorKind;

	constructor(kind: ExportErrorKind, message: string, cause?: unknown) {
		super(message, { cause });
		this.name = 'ExportError';
		this.kind = kind;
	}
}

function mediaType(response: Response): string {
	return response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
}

async function problemFrom(response: Response): Promise<ApiError> {
	const body = await response.text().catch(() => '');
	let problem: ProblemDetails | undefined;
	if (mediaType(response) === 'application/problem+json') {
		try {
			const parsed: unknown = JSON.parse(body);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) problem = parsed as ProblemDetails;
		} catch {
			problem = undefined;
		}
	}
	return new ApiError(response.status, response.statusText, body, problem);
}

function errorKind(status: number): ExportErrorKind {
	switch (status) {
		case 400:
		case 422:
			return 'invalid';
		case 401:
			return 'unauthorized';
		case 404:
			return 'not_found';
		case 413:
			return 'too_large';
		default:
			return 'api';
	}
}

export interface ExportDownload {
	blob: Blob;
	filename: string;
	format: ExportFormat;
}

/**
 * Requests an export with same-origin credentials, no caching, and no redirects. Error
 * bodies (including problem+json) are never returned as a download.
 */
export async function requestNotesExport(bookIds: readonly number[], fetcher: typeof fetch = fetch): Promise<ExportDownload> {
	const path = buildExportPath(bookIds);
	const format = exportFormat(bookIds.length);
	let response: Response;
	try {
		response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
	} catch (cause) {
		throw new ExportError('connection', 'The export could not be reached.', cause);
	}
	if (!response.ok) {
		const problem = await problemFrom(response);
		throw new ExportError(errorKind(response.status), problem.message, problem);
	}
	const expected = format === 'zip' ? 'application/zip' : 'text/markdown';
	if (response.type === 'opaqueredirect' || response.redirected || mediaType(response) !== expected) {
		await response.body?.cancel().catch(() => undefined);
		throw new ExportError('unexpected', `Expected ${expected} but received ${mediaType(response) || 'no content type'}.`);
	}
	const blob = await response.blob();
	const filename = safeDownloadName(parseContentDispositionFilename(response.headers.get('content-disposition')), fallbackFilename(format));
	return { blob, filename, format };
}

export interface SaveDependencies {
	document: Document;
	createObjectURL: (blob: Blob) => string;
	revokeObjectURL: (url: string) => void;
	defer: (callback: () => void) => void;
}

/** Saves a blob through a temporary object URL, which is always revoked afterwards. */
export function saveBlob(blob: Blob, filename: string, dependencies?: Partial<SaveDependencies>): void {
	const {
		document: doc = globalThis.document,
		createObjectURL = (value: Blob) => URL.createObjectURL(value),
		revokeObjectURL = (url: string) => URL.revokeObjectURL(url),
		defer = (callback: () => void) => setTimeout(callback, 1000)
	} = dependencies ?? {};
	const url = createObjectURL(blob);
	try {
		const anchor = doc.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.rel = 'noopener';
		anchor.hidden = true;
		doc.body.append(anchor);
		anchor.click();
		anchor.remove();
	} finally {
		defer(() => revokeObjectURL(url));
	}
}
