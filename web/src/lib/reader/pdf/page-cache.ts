import {
	cacheEntryHeaders,
	getReaderCacheSettings,
	onReaderCacheCleared,
	openReaderCache,
	PDF_PAGE_CACHE_NAME,
	RangeCache,
	recordReaderCacheEntry,
	requestPersistentStorageOnce,
	touchReaderCacheEntry,
	type LedgerEntry
} from '../range-cache.js';

export interface PdfPageCacheOptions {
	account: number | null;
	bookId?: number;
	fileId?: number;
	bookTitle?: string;
	fingerprint: string;
	origin?: string;
}

interface MemoryEntry {
	page: number;
	rotation: number;
	scaleBucket: number;
	bitmap: ImageBitmap;
	bytes: number;
}

export function quantizeScale(scale: number): number {
	if (!Number.isFinite(scale) || scale <= 0) return 1;
	return Math.max(0.25, Math.min(4, Math.round(scale * 4) / 4));
}

async function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob | null> {
	if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
		try {
			return await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
		} catch {
			return canvas.convertToBlob().catch(() => null);
		}
	}
	if ('toBlob' in canvas && typeof canvas.toBlob === 'function') {
		return new Promise<Blob | null>((resolve) => {
			try {
				canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.82);
			} catch {
				resolve(null);
			}
		});
	}
	return null;
}

export class PdfPageCache {
	private readonly account: number | null;
	private readonly bookId: number;
	private readonly fileId: number;
	private readonly bookTitle: string;
	private readonly fingerprint: string;
	private readonly origin: string;
	private readonly memory = new Map<string, MemoryEntry>();
	private readonly persistedKeys = new Set<string>();
	private readonly inFlightPersistent = new Map<string, Promise<ImageBitmap | null>>();
	private memoryBytes = 0;
	private disposed = false;
	private readonly unsubscribeClear: () => void;

	constructor(options: PdfPageCacheOptions) {
		this.account = options.account;
		this.bookId = options.bookId ?? 0;
		this.fileId = options.fileId ?? 0;
		this.bookTitle = options.bookTitle ?? '';
		this.fingerprint = options.fingerprint || 'pdf';
		this.origin = options.origin ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost');
		this.unsubscribeClear = onReaderCacheCleared((account, bookId) => {
			if (account !== undefined && this.account !== null && account !== this.account) return;
			if (bookId !== undefined && this.bookId > 0 && bookId !== this.bookId) return;
			this.clearMemory();
			this.persistedKeys.clear();
		});
	}

	private memKey(page: number, rotation: number, scaleBucket: number): string {
		return `${page}:${rotation}:${scaleBucket}`;
	}

	hasMemory(page: number, rotation: number, scale: number): boolean {
		return this.memory.has(this.memKey(page, rotation, quantizeScale(scale)));
	}

	getMemory(page: number, rotation: number, scale: number): ImageBitmap | null {
		if (this.disposed) return null;
		const bucket = quantizeScale(scale);
		const exactKey = this.memKey(page, rotation, bucket);
		const exact = this.memory.get(exactKey);
		if (exact) {
			this.memory.delete(exactKey);
			this.memory.set(exactKey, exact);
			return exact.bitmap;
		}
		// Fallback to any cached scale for the same page and rotation so zoom/open paints immediately.
		let best: MemoryEntry | null = null;
		for (const entry of this.memory.values()) {
			if (entry.page === page && entry.rotation === rotation) {
				if (!best || Math.abs(entry.scaleBucket - bucket) < Math.abs(best.scaleBucket - bucket)) {
					best = entry;
				}
			}
		}
		return best?.bitmap ?? null;
	}

	async get(page: number, rotation: number, scale: number): Promise<ImageBitmap | null> {
		if (this.disposed) return null;
		const mem = this.getMemory(page, rotation, scale);
		if (mem) return mem;
		if (this.account === null || !RangeCache.available() || typeof createImageBitmap !== 'function') {
			return null;
		}
		const bucket = quantizeScale(scale);
		const mKey = this.memKey(page, rotation, bucket);
		const existing = this.inFlightPersistent.get(mKey);
		if (existing) return existing;
		const promise = this.loadFromStorage(page, rotation, bucket).finally(() => {
			this.inFlightPersistent.delete(mKey);
		});
		this.inFlightPersistent.set(mKey, promise);
		return promise;
	}

	private async loadFromStorage(page: number, rotation: number, scaleBucket: number): Promise<ImageBitmap | null> {
		try {
			const cache = await openReaderCache(PDF_PAGE_CACHE_NAME);
			const req = this.request(page, rotation, scaleBucket);
			const res = await cache.match(req);
			if (!res || this.disposed) return null;
			touchReaderCacheEntry(req.url);
			const blob = await res.blob();
			if (this.disposed) return null;
			const bitmap = await createImageBitmap(blob);
			if (this.disposed) {
				bitmap.close();
				return null;
			}
			this.persistedKeys.add(this.memKey(page, rotation, scaleBucket));
			this.storeMemory(page, rotation, scaleBucket, bitmap);
			return bitmap;
		} catch {
			return null;
		}
	}

	putBitmap(page: number, rotation: number, scale: number, bitmap: ImageBitmap): void {
		if (this.disposed) {
			bitmap.close();
			return;
		}
		this.storeMemory(page, rotation, quantizeScale(scale), bitmap);
	}

	async captureCanvas(
		page: number,
		rotation: number,
		scale: number,
		canvas: HTMLCanvasElement | OffscreenCanvas
	): Promise<void> {
		if (this.disposed || canvas.width <= 0 || canvas.height <= 0) return;
		const scaleBucket = quantizeScale(scale);
		const mKey = this.memKey(page, rotation, scaleBucket);
		if (typeof createImageBitmap === 'function' && !this.memory.has(mKey)) {
			try {
				const bitmap = await createImageBitmap(canvas);
				if (this.disposed) {
					bitmap.close();
					return;
				}
				this.storeMemory(page, rotation, scaleBucket, bitmap);
			} catch {
				// Ignore tainted or zero-sized canvas failures.
			}
		}
		if (this.account === null || !RangeCache.available() || this.persistedKeys.has(mKey)) return;
		this.persistedKeys.add(mKey);
		try {
			const blob = await canvasToBlob(canvas);
			if (!blob || this.disposed) return;
			requestPersistentStorageOnce();
			const cache = await openReaderCache(PDF_PAGE_CACHE_NAME);
			const req = this.request(page, rotation, scaleBucket);
			const now = Date.now();
			const entry: Omit<LedgerEntry, 'key' | 'cache'> = {
				account: this.account,
				bookId: this.bookId,
				fileId: this.fileId,
				title: this.bookTitle,
				bytes: blob.size,
				updatedAt: now
			};
			await cache.put(req, new Response(blob, {
				headers: cacheEntryHeaders(entry, blob.type || 'image/webp')
			}));
			recordReaderCacheEntry({
				...entry,
				key: req.url,
				cache: 'page'
			});
		} catch {
			this.persistedKeys.delete(mKey);
		}
	}

	private memoryBudget(): number {
		const configured = getReaderCacheSettings().memoryLimitBytes;
		return Math.max(32 * 1024 * 1024, Math.floor(configured * 0.4));
	}

	private storeMemory(page: number, rotation: number, scaleBucket: number, bitmap: ImageBitmap): void {
		const key = this.memKey(page, rotation, scaleBucket);
		const previous = this.memory.get(key);
		if (previous) {
			this.memoryBytes = Math.max(0, this.memoryBytes - previous.bytes);
			if (previous.bitmap !== bitmap) previous.bitmap.close();
			this.memory.delete(key);
		}
		const bytes = Math.max(1024, (bitmap.width || 1000) * (bitmap.height || 1400) * 4);
		this.memory.set(key, { page, rotation, scaleBucket, bitmap, bytes });
		this.memoryBytes += bytes;
		const limit = this.memoryBudget();
		while (this.memoryBytes > limit && this.memory.size > 1) {
			const oldest = this.memory.entries().next().value as [string, MemoryEntry] | undefined;
			if (!oldest) break;
			this.memory.delete(oldest[0]);
			this.memoryBytes = Math.max(0, this.memoryBytes - oldest[1].bytes);
			oldest[1].bitmap.close();
		}
	}

	private request(page: number, rotation: number, scaleBucket: number): Request {
		const url = new URL('/__pandalibrary_pdf_page_cache__', this.origin);
		url.searchParams.set('account', String(this.account));
		if (this.bookId > 0) url.searchParams.set('book', String(this.bookId));
		if (this.fileId > 0) url.searchParams.set('file', String(this.fileId));
		url.searchParams.set('fp', this.fingerprint);
		url.searchParams.set('page', String(page));
		url.searchParams.set('rot', String(rotation));
		url.searchParams.set('scale', String(scaleBucket));
		return new Request(url);
	}

	clearMemory(): void {
		for (const entry of this.memory.values()) {
			entry.bitmap.close();
		}
		this.memory.clear();
		this.memoryBytes = 0;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeClear();
		this.clearMemory();
		this.persistedKeys.clear();
		this.inFlightPersistent.clear();
	}
}
