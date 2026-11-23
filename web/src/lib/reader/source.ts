import type { BookFile } from '#lib/catalog/types.js';
import {
	getReaderCacheSettings,
	RangeCache,
	type ReaderCacheBookMeta
} from '#lib/reader/range-cache.js';

/** Bytes fetched per HTTP Range request (2 MiB reduces round-trips on large scanned PDFs). */
export const RANGE_CHUNK_SIZE = 2 * 1024 * 1024;
/** Refuse to turn an ignored Range request into a large full download. */
export const MAX_RANGE_FALLBACK_BYTES = 32 * 1024 * 1024;
/** Default per-reader in-memory range cache budget. */
export const MAX_RANGE_CACHE_BYTES = 256 * 1024 * 1024;
/** Default sliding-window lookahead in chunks (4 * 2 MiB = 8 MiB ahead). */
export const DEFAULT_PREFETCH_WINDOW_CHUNKS = 4;
const MAX_CONCURRENT_PREFETCH = 2;

export interface HttpRangeSourceOptions extends ReaderCacheBookMeta {
	prefetchWindowChunks?: number;
}

export interface BlobLike {
	readonly size: number;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
	slice(start?: number, end?: number): BlobLike;
}

export interface ReaderSource extends BlobLike {
	readonly name: string;
	readonly type: string;
	readonly bookMeta?: ReaderCacheBookMeta;
	read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
	warmup?(): Promise<Uint8Array | null>;
	close(): void;
}

export class ReaderSourceError extends Error {
	constructor(message: string, readonly status?: number, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ReaderSourceError';
	}
}

export function isReaderSourceError(error: unknown): error is ReaderSourceError {
	return error instanceof ReaderSourceError;
}

export function isBlob(value: unknown): value is Blob {
	return typeof Blob !== 'undefined' && value instanceof Blob;
}

function sourceName(file: BookFile): string {
	return file.original_filename || `book.${file.format}`;
}

function contentType(format: string): string {
	switch (format.toLowerCase()) {
	case 'epub': return 'application/epub+zip';
	case 'pdf': return 'application/pdf';
	case 'mobi': return 'application/x-mobipocket-ebook';
	case 'azw3': return 'application/vnd.amazon.ebook';
	case 'fb2': return 'application/x-fictionbook+xml';
	case 'fbz': return 'application/x-zip-compressed-fb2';
	case 'cbz': return 'application/vnd.comicbook+zip';
	default: return 'application/octet-stream';
	}
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
	const present = signals.filter((signal): signal is AbortSignal => !!signal);
	if (present.length === 1) return present[0];
	if (typeof AbortSignal.any === 'function') return AbortSignal.any(present);
	const controller = new AbortController();
	for (const signal of present) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
	}
	return controller.signal;
}

/** A real Blob-backed source, used for explicit offline downloads. */
export class BlobSource implements ReaderSource {
	readonly size: number;
	readonly name: string;
	readonly type: string;
	readonly bookMeta?: ReaderCacheBookMeta;

	constructor(private readonly blob: Blob, file: BookFile, bookMeta?: ReaderCacheBookMeta) {
		this.size = blob.size;
		this.name = sourceName(file);
		this.type = blob.type || contentType(file.format);
		this.bookMeta = bookMeta;
	}

	slice(start = 0, end = this.size): BlobLike {
		return this.blob.slice(start, end);
	}

	arrayBuffer(): Promise<ArrayBuffer> {
		return this.blob.arrayBuffer();
	}

	text(): Promise<string> {
		return this.blob.text();
	}

	async read(offset: number, length: number): Promise<Uint8Array> {
		const start = Math.max(0, Math.min(this.size, Math.trunc(offset)));
		const end = Math.max(start, Math.min(this.size, start + Math.trunc(length)));
		return new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
	}

	close(): void {}
}

interface ContentRange {
	start: number;
	end: number;
	total: number;
}

function parseContentRange(value: string | null): ContentRange | null {
	const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value?.trim() ?? '');
	if (!match) return null;
	return {
		start: Number(match[1]),
		end: Number(match[2]),
		total: match[3] === '*' ? Number.NaN : Number(match[3])
	};
}

class LazySlice implements BlobLike {
	constructor(
		private readonly source: HttpRangeSource,
		private readonly start: number,
		private readonly end: number
	) {}

	get size(): number {
		return this.end - this.start;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const data = await this.source.read(this.start, this.size);
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(await this.source.read(this.start, this.size));
	}

	slice(start = 0, end = this.size): BlobLike {
		const from = this.start + Math.max(0, Math.min(this.size, Math.trunc(start)));
		const requested = this.start + Math.max(0, Math.min(this.size, Math.trunc(end)));
		return new LazySlice(this.source, from, Math.max(from, requested));
	}
}

/**
 * Reads an authorized, immutable book URL with HTTP Range requests.
 * Chunks are aligned, deduplicated, prefetched in a sliding window, and kept in an LRU cache.
 */
export class HttpRangeSource implements ReaderSource {
	readonly size: number;
	readonly name: string;
	readonly type: string;
	readonly bookMeta?: ReaderCacheBookMeta;

	private readonly chunks = new Map<number, Uint8Array>();
	private readonly inFlight = new Map<number, Promise<Uint8Array>>();
	private readonly prefetchControllers = new Map<number, AbortController>();
	private prefetchQueue: number[] = [];
	private activePrefetches = 0;
	private lastReadChunk: number | null = null;
	private direction: 1 | -1 = 1;
	private readonly prefetchWindow: number;
	private readonly controller = new AbortController();
	private readonly rangeCache: RangeCache | null;
	private cachedBytes = 0;
	private closed = false;
	private fullFallback: Uint8Array | null = null;

	constructor(
		private readonly url: URL,
		file: BookFile,
		private readonly fetcher: typeof fetch = fetch,
		account: number | null = null,
		options: HttpRangeSourceOptions = {}
	) {
		this.bookMeta = {
			bookId: options.bookId,
			fileId: options.fileId ?? file.id,
			bookTitle: options.bookTitle
		};
		this.rangeCache = account === null ? null : new RangeCache(account, url, this.bookMeta);
		this.size = file.size_bytes;
		this.name = sourceName(file);
		this.type = contentType(file.format);
		this.prefetchWindow = options.prefetchWindowChunks !== undefined
			? Math.max(0, Math.trunc(options.prefetchWindowChunks))
			: (account !== null ? DEFAULT_PREFETCH_WINDOW_CHUNKS : 0);
	}

	slice(start = 0, end = this.size): BlobLike {
		const from = Math.max(0, Math.min(this.size, Math.trunc(start)));
		const to = Math.max(0, Math.min(this.size, Math.trunc(end)));
		return new LazySlice(this, Math.min(from, to), Math.max(from, to));
	}

	async arrayBuffer(signal?: AbortSignal): Promise<ArrayBuffer> {
		const data = await this.read(0, this.size, signal);
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	}

	async text(signal?: AbortSignal): Promise<string> {
		return new TextDecoder().decode(await this.read(0, this.size, signal));
	}

	/**
	 * Warms the first chunk (PDF header / linearized objects) and final chunk
	 * (PDF trailer / XRef table) in parallel to accelerate initial document open.
	 */
	async warmup(): Promise<Uint8Array | null> {
		if (this.closed || this.size <= 0) return null;
		const lastIndex = Math.floor((this.size - 1) / RANGE_CHUNK_SIZE);
		const headPromise = this.chunk(0);
		const tailPromise = lastIndex > 0 ? this.chunk(lastIndex).catch(() => null) : Promise.resolve(null);
		try {
			const [head] = await Promise.all([headPromise, tailPromise]);
			return head;
		} catch {
			return null;
		}
	}

	async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
		if (this.closed) throw new ReaderSourceError('The book file was closed.');
		if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) return new Uint8Array();
		const start = Math.max(0, Math.min(this.size, Math.trunc(offset)));
		const end = Math.max(start, Math.min(this.size, start + Math.trunc(length)));
		if (end <= start) return new Uint8Array();
		const first = Math.floor(start / RANGE_CHUNK_SIZE);
		const last = Math.floor((end - 1) / RANGE_CHUNK_SIZE);
		if (this.lastReadChunk !== null) {
			if (first < this.lastReadChunk) this.direction = -1;
			else if (last > this.lastReadChunk) this.direction = 1;
		}
		this.lastReadChunk = this.direction === 1 ? last : first;

		const pending: Promise<Uint8Array>[] = [];
		for (let index = first; index <= last; index += 1) {
			// Promote any in-flight background prefetch to a non-cancellable foreground read.
			this.prefetchControllers.delete(index);
			pending.push(this.chunk(index, signal));
		}
		const chunks = await Promise.all(pending);
		const output = new Uint8Array(end - start);
		let written = 0;
		for (let index = first; index <= last; index += 1) {
			const chunk = chunks[index - first];
			const chunkStart = index * RANGE_CHUNK_SIZE;
			const from = Math.max(start, chunkStart) - chunkStart;
			const to = Math.min(end, chunkStart + chunk.length) - chunkStart;
			if (to > from) {
				output.set(chunk.subarray(from, to), written);
				written += to - from;
			}
		}
		if (written !== output.length) throw new ReaderSourceError('The server returned incomplete book content.');
		if (this.prefetchWindow > 0 && !this.closed) {
			this.updateSlidingWindow(first, last);
		}
		return output;
	}

	private updateSlidingWindow(first: number, last: number): void {
		if (this.closed || this.fullFallback || this.size <= 0) return;
		const totalChunks = Math.ceil(this.size / RANGE_CHUNK_SIZE);
		const targets: number[] = [];
		for (let step = 1; step <= this.prefetchWindow; step += 1) {
			const candidate = this.direction === 1 ? last + step : first - step;
			if (candidate >= 0 && candidate < totalChunks) {
				targets.push(candidate);
			}
		}
		const keepWindow = new Set<number>(targets);
		for (let index = Math.max(0, first - 1); index <= Math.min(totalChunks - 1, last + 1); index += 1) {
			keepWindow.add(index);
		}
		for (const [index, controller] of this.prefetchControllers.entries()) {
			if (!keepWindow.has(index)) {
				this.prefetchControllers.delete(index);
				this.inFlight.delete(index);
				controller.abort();
			}
		}
		this.prefetchQueue = targets.filter((index) => !this.chunks.has(index) && !this.inFlight.has(index));
		this.pumpPrefetchQueue();
	}

	private pumpPrefetchQueue(): void {
		if (this.closed || this.fullFallback) return;
		while (this.activePrefetches < MAX_CONCURRENT_PREFETCH && this.prefetchQueue.length > 0) {
			const next = this.prefetchQueue.shift()!;
			if (this.chunks.has(next) || this.inFlight.has(next)) continue;
			const controller = new AbortController();
			this.prefetchControllers.set(next, controller);
			this.activePrefetches += 1;
			void this.chunk(next, controller.signal).catch(() => {}).finally(() => {
				this.prefetchControllers.delete(next);
				this.activePrefetches = Math.max(0, this.activePrefetches - 1);
				if (!this.closed) this.pumpPrefetchQueue();
			});
		}
	}

	private async chunk(index: number, signal?: AbortSignal): Promise<Uint8Array> {
		const cached = this.chunks.get(index);
		if (cached) {
			this.chunks.delete(index);
			this.chunks.set(index, cached);
			return cached;
		}
		const pending = this.inFlight.get(index);
		if (pending) return pending;
		const request = this.fetchChunk(index, signal).finally(() => {
			if (this.inFlight.get(index) === request) {
				this.inFlight.delete(index);
			}
		});
		this.inFlight.set(index, request);
		return request;
	}

	private async fetchChunk(index: number, signal?: AbortSignal): Promise<Uint8Array> {
		if (this.closed) throw new ReaderSourceError('The book file was closed.');
		if (this.fullFallback) return this.chunkFromFull(index);
		const persisted = await this.rangeCache?.get(index);
		if (persisted) {
			this.remember(index, persisted);
			return persisted;
		}
		const start = index * RANGE_CHUNK_SIZE;
		if (start >= this.size) return new Uint8Array();
		const end = Math.min(this.size, start + RANGE_CHUNK_SIZE) - 1;
		const requestSignal = combineSignals([this.controller.signal, signal]);
		let response: Response;
		try {
			response = await this.fetcher(this.url.href, {
				method: 'GET',
				headers: { Range: `bytes=${start}-${end}` },
				credentials: 'same-origin',
				redirect: 'error',
				// Book URLs are content-hash versioned and the server marks them immutable.
				// Letting the browser cache ranges avoids re-downloading the same pages on
				// every open; `no-store` forced a full re-fetch each time.
				cache: 'default',
				signal: requestSignal
			});
		} catch (error) {
			if (requestSignal.aborted) throw error;
			throw new ReaderSourceError('Could not read the book file.', undefined, { cause: error });
		}

		if (response.status === 200) {
			if (this.size > MAX_RANGE_FALLBACK_BYTES) {
				throw new ReaderSourceError('The server did not honor a range request for this large book file.');
			}
			const data = new Uint8Array(await response.arrayBuffer());
			if (data.length !== this.size) throw new ReaderSourceError('The book file size did not match the catalog.');
			this.fullFallback = data;
			return this.chunkFromFull(index);
		}
		if (response.status === 206) {
			const range = parseContentRange(response.headers.get('Content-Range'));
			if (!range || range.start !== start || range.end > end ||
				(Number.isFinite(range.total) && range.total !== this.size)) {
				throw new ReaderSourceError('The server returned an invalid range for this book file.');
			}
			const data = new Uint8Array(await response.arrayBuffer());
			if (data.length !== range.end - range.start + 1) {
				throw new ReaderSourceError('The server returned an incomplete range for this book file.');
			}
			this.remember(index, data);
			// Cache writes must not delay the page paint; the next open reads whatever completed.
			void this.rangeCache?.put(index, data);
			return data;
		}
		if (response.status === 403 || response.status === 404) {
			throw new ReaderSourceError('The book file is no longer available.', response.status);
		}
		throw new ReaderSourceError('Could not read the book file.', response.status);
	}

	private chunkFromFull(index: number): Uint8Array {
		const full = this.fullFallback;
		if (!full) throw new ReaderSourceError('The book file is unavailable.');
		const start = index * RANGE_CHUNK_SIZE;
		return full.subarray(start, Math.min(full.length, start + RANGE_CHUNK_SIZE));
	}

	private memoryCacheBudget(): number {
		const configured = getReaderCacheSettings().memoryLimitBytes;
		return Math.max(32 * 1024 * 1024, Math.floor(configured * 0.6));
	}

	private remember(index: number, data: Uint8Array): void {
		const previous = this.chunks.get(index);
		if (previous) {
			this.cachedBytes -= previous.byteLength;
			this.chunks.delete(index);
		}
		this.chunks.set(index, data);
		this.cachedBytes += data.byteLength;
		const limit = this.memoryCacheBudget();
		while (this.cachedBytes > limit) {
			const oldest = this.chunks.entries().next().value as [number, Uint8Array] | undefined;
			if (!oldest) break;
			this.chunks.delete(oldest[0]);
			this.cachedBytes -= oldest[1].byteLength;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		for (const controller of this.prefetchControllers.values()) {
			controller.abort();
		}
		this.prefetchControllers.clear();
		this.prefetchQueue = [];
		this.chunks.clear();
		this.inFlight.clear();
		this.fullFallback = null;
		this.cachedBytes = 0;
	}
}
