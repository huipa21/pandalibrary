export const RANGE_CACHE_NAME = 'pandalibrary-book-ranges-v1';
export const PDF_PAGE_CACHE_NAME = 'pandalibrary-pdf-pages-v1';

const SETTINGS_STORAGE_KEY = 'pandalibrary.reader-cache-settings.v1';
const LEDGER_STORAGE_KEY = 'pandalibrary.reader-cache-ledger.v1';

export const DEFAULT_DISK_CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const DEFAULT_MEMORY_CACHE_LIMIT_BYTES = 256 * 1024 * 1024; // 256 MiB

export const DISK_CACHE_LIMIT_OPTIONS = [
	512 * 1024 * 1024,
	1024 * 1024 * 1024,
	2 * 1024 * 1024 * 1024,
	4 * 1024 * 1024 * 1024,
	8 * 1024 * 1024 * 1024
] as const;

export const MEMORY_CACHE_LIMIT_OPTIONS = [
	128 * 1024 * 1024,
	256 * 1024 * 1024,
	512 * 1024 * 1024,
	1024 * 1024 * 1024
] as const;

export interface ReaderCacheSettings {
	diskLimitBytes: number;
	memoryLimitBytes: number;
}

export interface ReaderCacheBookMeta {
	bookId?: number;
	fileId?: number;
	bookTitle?: string;
}

export interface CachedBookSummary {
	account: number;
	bookId: number;
	title: string;
	rangeBytes: number;
	pageBytes: number;
	totalBytes: number;
	chunkCount: number;
	pageCount: number;
	updatedAt: number;
}

export interface LedgerEntry {
	key: string;
	cache: 'range' | 'page';
	account: number;
	bookId: number;
	fileId: number;
	title: string;
	bytes: number;
	updatedAt: number;
}

const openCaches = new Map<string, Promise<Cache>>();
const clearListeners = new Set<(account?: number, bookId?: number) => void>();
let cachedSettings: ReaderCacheSettings | null = null;
let ledgerLoaded = false;
const ledger = new Map<string, LedgerEntry>();
let totalLedgerBytes = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pruning: Promise<void> | null = null;
let persistenceRequested = false;

function parsePositiveInt(value: unknown, fallback: number): number {
	const num = Number(value);
	return Number.isFinite(num) && num >= 16 * 1024 * 1024 ? Math.trunc(num) : fallback;
}

function browserStorage(): Storage | null {
	try {
		const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		if (desc && 'value' in desc) return (desc.value as Storage | undefined) ?? null;
		if (typeof window !== 'undefined' && 'localStorage' in window) return window.localStorage;
	} catch {
		// Ignore SecurityError in sandboxed contexts.
	}
	return null;
}

export function getReaderCacheSettings(): ReaderCacheSettings {
	if (cachedSettings) return cachedSettings;
	let diskLimitBytes = DEFAULT_DISK_CACHE_LIMIT_BYTES;
	let memoryLimitBytes = DEFAULT_MEMORY_CACHE_LIMIT_BYTES;
	try {
		const raw = browserStorage()?.getItem(SETTINGS_STORAGE_KEY) ?? null;
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<ReaderCacheSettings>;
			diskLimitBytes = parsePositiveInt(parsed.diskLimitBytes, DEFAULT_DISK_CACHE_LIMIT_BYTES);
			memoryLimitBytes = parsePositiveInt(parsed.memoryLimitBytes, DEFAULT_MEMORY_CACHE_LIMIT_BYTES);
		}
	} catch {
		// Ignore unavailable or malformed localStorage in private browsing / tests.
	}
	cachedSettings = { diskLimitBytes, memoryLimitBytes };
	return cachedSettings;
}

export function saveReaderCacheSettings(partial: Partial<ReaderCacheSettings>): ReaderCacheSettings {
	const current = getReaderCacheSettings();
	const next: ReaderCacheSettings = {
		diskLimitBytes: parsePositiveInt(partial.diskLimitBytes ?? current.diskLimitBytes, current.diskLimitBytes),
		memoryLimitBytes: parsePositiveInt(partial.memoryLimitBytes ?? current.memoryLimitBytes, current.memoryLimitBytes)
	};
	cachedSettings = next;
	try {
		browserStorage()?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Best effort.
	}
	void pruneReaderCachesToLimit();
	return next;
}

export function onReaderCacheCleared(listener: (account?: number, bookId?: number) => void): () => void {
	clearListeners.add(listener);
	return () => { clearListeners.delete(listener); };
}

export function openReaderCache(name: string): Promise<Cache> {
	let promise = openCaches.get(name);
	if (!promise) {
		promise = caches.open(name).catch((error) => {
			openCaches.delete(name);
			throw error;
		});
		openCaches.set(name, promise);
	}
	return promise;
}

export function requestPersistentStorageOnce(): void {
	if (persistenceRequested) return;
	persistenceRequested = true;
	try {
		if (typeof navigator !== 'undefined' && typeof navigator.storage?.persist === 'function') {
			void navigator.storage.persist().catch(() => {});
		}
	} catch {
		// Ignore environments without StorageManager.
	}
}

function ensureLedgerLoaded(): void {
	if (ledgerLoaded) return;
	ledgerLoaded = true;
	ledger.clear();
	totalLedgerBytes = 0;
	try {
		const raw = browserStorage()?.getItem(LEDGER_STORAGE_KEY) ?? null;
		if (!raw) return;
		const rows = JSON.parse(raw) as LedgerEntry[];
		if (!Array.isArray(rows)) return;
		for (const row of rows) {
			if (!row || typeof row.key !== 'string' || typeof row.bytes !== 'number' || row.bytes < 0) continue;
			ledger.set(row.key, row);
			totalLedgerBytes += row.bytes;
		}
	} catch {
		ledger.clear();
		totalLedgerBytes = 0;
	}
}

function scheduleLedgerSave(): void {
	if (persistTimer !== null) return;
	persistTimer = setTimeout(() => {
		persistTimer = null;
		flushLedgerSave();
	}, 250);
}

function flushLedgerSave(): void {
	if (persistTimer !== null) {
		clearTimeout(persistTimer);
		persistTimer = null;
	}
	try {
		browserStorage()?.setItem(LEDGER_STORAGE_KEY, JSON.stringify([...ledger.values()]));
	} catch {
		// Best effort.
	}
}

export function recordReaderCacheEntry(entry: LedgerEntry): void {
	ensureLedgerLoaded();
	const previous = ledger.get(entry.key);
	if (previous) {
		totalLedgerBytes = Math.max(0, totalLedgerBytes - previous.bytes);
		if (!entry.title && previous.title) entry = { ...entry, title: previous.title };
	}
	ledger.set(entry.key, entry);
	totalLedgerBytes += entry.bytes;
	scheduleLedgerSave();
	if (totalLedgerBytes > getReaderCacheSettings().diskLimitBytes) {
		void pruneReaderCachesToLimit();
	}
}

export function touchReaderCacheEntry(key: string): void {
	ensureLedgerLoaded();
	const existing = ledger.get(key);
	if (!existing) return;
	existing.updatedAt = Date.now();
	scheduleLedgerSave();
}

export function removeReaderCacheEntry(key: string): void {
	ensureLedgerLoaded();
	const existing = ledger.get(key);
	if (!existing) return;
	totalLedgerBytes = Math.max(0, totalLedgerBytes - existing.bytes);
	ledger.delete(key);
	scheduleLedgerSave();
}

export function cacheEntryHeaders(entry: Omit<LedgerEntry, 'key' | 'cache'>, contentType = 'application/octet-stream'): HeadersInit {
	return {
		'Content-Type': contentType,
		'X-Panda-Account': String(entry.account),
		'X-Panda-Book-Id': String(entry.bookId),
		'X-Panda-File-Id': String(entry.fileId),
		'X-Panda-Title': encodeURIComponent(entry.title || ''),
		'X-Panda-Bytes': String(entry.bytes),
		'X-Panda-Updated': String(entry.updatedAt)
	};
}

function parseEntryFromCached(request: Request, response: Response | undefined, cacheKind: 'range' | 'page'): LedgerEntry | null {
	try {
		const url = new URL(request.url);
		const account = Number(response?.headers.get('X-Panda-Account') ?? url.searchParams.get('account') ?? 0);
		if (!Number.isFinite(account) || account <= 0) return null;
		const bookFromUrl = Number(url.searchParams.get('book') ?? 0) ||
			Number(/\/api\/v1\/books\/(\d+)\/files\//.exec(url.searchParams.get('url') ?? '')?.[1] ?? 0);
		const bookId = Number(response?.headers.get('X-Panda-Book-Id') ?? bookFromUrl) || bookFromUrl;
		const fileFromUrl = Number(url.searchParams.get('file') ?? 0) ||
			Number(/\/api\/v1\/books\/\d+\/files\/(\d+)/.exec(url.searchParams.get('url') ?? '')?.[1] ?? 0);
		const fileId = Number(response?.headers.get('X-Panda-File-Id') ?? fileFromUrl) || fileFromUrl;
		const rawTitle = response?.headers.get('X-Panda-Title') ?? url.searchParams.get('title') ?? '';
		let title = '';
		try {
			title = decodeURIComponent(rawTitle);
		} catch {
			title = rawTitle;
		}
		const bytes = Math.max(0, Number(response?.headers.get('X-Panda-Bytes') ?? 0));
		const updatedAt = Number(response?.headers.get('X-Panda-Updated') ?? Date.now()) || Date.now();
		return {
			key: request.url,
			cache: cacheKind,
			account,
			bookId,
			fileId,
			title,
			bytes,
			updatedAt
		};
	} catch {
		return null;
	}
}

export async function pruneReaderCachesToLimit(): Promise<void> {
	if (pruning) return pruning;
	pruning = (async () => {
		try {
			ensureLedgerLoaded();
			const limit = getReaderCacheSettings().diskLimitBytes;
			if (totalLedgerBytes <= limit) return;
			const target = Math.floor(limit * 0.9);
			const sorted = [...ledger.values()].sort((a, b) => a.updatedAt - b.updatedAt);
			const rangeCache = typeof caches !== 'undefined' ? await openReaderCache(RANGE_CACHE_NAME).catch(() => null) : null;
			const pageCache = typeof caches !== 'undefined' ? await openReaderCache(PDF_PAGE_CACHE_NAME).catch(() => null) : null;
			for (const item of sorted) {
				if (totalLedgerBytes <= target) break;
				removeReaderCacheEntry(item.key);
				const targetCache = item.cache === 'range' ? rangeCache : pageCache;
				if (targetCache) {
					await targetCache.delete(new Request(item.key)).catch(() => {});
				}
			}
			flushLedgerSave();
		} finally {
			pruning = null;
		}
	})();
	return pruning;
}

async function reconcileCacheStorage(): Promise<void> {
	ensureLedgerLoaded();
	if (typeof caches === 'undefined') return;
	for (const [name, kind] of [[RANGE_CACHE_NAME, 'range'], [PDF_PAGE_CACHE_NAME, 'page']] as const) {
		try {
			const cache = await openReaderCache(name);
			const requests = await cache.keys();
			const activeKeys = new Set<string>();
			for (const req of requests) {
				activeKeys.add(req.url);
				if (ledger.has(req.url)) continue;
				const res = await cache.match(req);
				const parsed = parseEntryFromCached(req, res, kind);
				if (!parsed) continue;
				if (parsed.bytes === 0 && res) {
					const buf = await res.clone().arrayBuffer().catch(() => null);
					if (buf) parsed.bytes = buf.byteLength;
				}
				ledger.set(parsed.key, parsed);
				totalLedgerBytes += parsed.bytes;
			}
			for (const [key, entry] of ledger.entries()) {
				if (entry.cache === kind && !activeKeys.has(key)) {
					totalLedgerBytes = Math.max(0, totalLedgerBytes - entry.bytes);
					ledger.delete(key);
				}
			}
		} catch {
			// Best effort if Cache Storage is unavailable.
		}
	}
	flushLedgerSave();
}

export async function listCachedBooks(account: number): Promise<CachedBookSummary[]> {
	await reconcileCacheStorage();
	const byBook = new Map<number, CachedBookSummary>();
	for (const entry of ledger.values()) {
		if (entry.account !== account || entry.bookId <= 0) continue;
		let summary = byBook.get(entry.bookId);
		if (!summary) {
			summary = {
				account,
				bookId: entry.bookId,
				title: entry.title || `#${entry.bookId}`,
				rangeBytes: 0,
				pageBytes: 0,
				totalBytes: 0,
				chunkCount: 0,
				pageCount: 0,
				updatedAt: entry.updatedAt
			};
			byBook.set(entry.bookId, summary);
		}
		if (entry.title && (summary.title === `#${entry.bookId}` || !summary.title)) {
			summary.title = entry.title;
		}
		if (entry.cache === 'range') {
			summary.rangeBytes += entry.bytes;
			summary.chunkCount += 1;
		} else {
			summary.pageBytes += entry.bytes;
			summary.pageCount += 1;
		}
		summary.totalBytes = summary.rangeBytes + summary.pageBytes;
		if (entry.updatedAt > summary.updatedAt) summary.updatedAt = entry.updatedAt;
	}
	return [...byBook.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.totalBytes - a.totalBytes);
}

export async function clearBookReaderCache(account: number, bookId: number): Promise<void> {
	ensureLedgerLoaded();
	for (const listener of clearListeners) {
		try { listener(account, bookId); } catch { /* ignore */ }
	}
	const keysToDelete: LedgerEntry[] = [];
	for (const entry of ledger.values()) {
		if (entry.account === account && entry.bookId === bookId) {
			keysToDelete.push(entry);
		}
	}
	for (const entry of keysToDelete) {
		removeReaderCacheEntry(entry.key);
	}
	if (typeof caches !== 'undefined') {
		for (const [name, kind] of [[RANGE_CACHE_NAME, 'range'], [PDF_PAGE_CACHE_NAME, 'page']] as const) {
			try {
				const cache = await openReaderCache(name);
				for (const entry of keysToDelete) {
					if (entry.cache === kind) await cache.delete(new Request(entry.key));
				}
				const remaining = await cache.keys();
				for (const req of remaining) {
					const parsed = parseEntryFromCached(req, undefined, kind);
					if (parsed && parsed.account === account && parsed.bookId === bookId) {
						removeReaderCacheEntry(req.url);
						await cache.delete(req);
					}
				}
			} catch {
				// Best effort.
			}
		}
	}
	flushLedgerSave();
}

export async function clearAllReaderCaches(account?: number): Promise<void> {
	ensureLedgerLoaded();
	for (const listener of clearListeners) {
		try { listener(account, undefined); } catch { /* ignore */ }
	}
	if (account === undefined) {
		ledger.clear();
		totalLedgerBytes = 0;
		flushLedgerSave();
		openCaches.clear();
		if (typeof caches !== 'undefined') {
			await Promise.all([
				caches.delete(RANGE_CACHE_NAME).catch(() => false),
				caches.delete(PDF_PAGE_CACHE_NAME).catch(() => false)
			]);
		}
		return;
	}
	const keysToDelete: LedgerEntry[] = [];
	for (const entry of ledger.values()) {
		if (entry.account === account) keysToDelete.push(entry);
	}
	for (const entry of keysToDelete) removeReaderCacheEntry(entry.key);
	if (typeof caches !== 'undefined') {
		for (const [name, kind] of [[RANGE_CACHE_NAME, 'range'], [PDF_PAGE_CACHE_NAME, 'page']] as const) {
			try {
				const cache = await openReaderCache(name);
				const requests = await cache.keys();
				for (const req of requests) {
					const parsed = parseEntryFromCached(req, undefined, kind);
					if (parsed && parsed.account === account) {
						removeReaderCacheEntry(req.url);
						await cache.delete(req);
					}
				}
			} catch {
				// Best effort.
			}
		}
	}
	flushLedgerSave();
}

export function resetReaderCacheStateForTests(): void {
	if (persistTimer !== null) {
		clearTimeout(persistTimer);
		persistTimer = null;
	}
	openCaches.clear();
	ledger.clear();
	totalLedgerBytes = 0;
	ledgerLoaded = false;
	cachedSettings = null;
	persistenceRequested = false;
}

/**
 * Persistent, account-scoped cache for immutable book ranges.
 *
 * Browsers do not reliably reuse HTTP Range responses across top-level
 * navigations (the reader is a full document load), so relying on the HTTP
 * cache made every reopen re-download the visible pages. Cache Storage is
 * explicit, survives navigations and stays local to this origin.
 */
export class RangeCache {
	private readonly key: Request;
	private readonly bookId: number;
	private readonly fileId: number;
	private readonly bookTitle: string;

	constructor(
		private readonly account: number,
		url: URL,
		meta: ReaderCacheBookMeta = {}
	) {
		const pathMatch = /\/api\/v1\/books\/(\d+)\/files\/(\d+)/.exec(url.pathname);
		this.bookId = meta.bookId ?? (pathMatch ? Number(pathMatch[1]) : 0);
		this.fileId = meta.fileId ?? (pathMatch ? Number(pathMatch[2]) : 0);
		this.bookTitle = meta.bookTitle ?? '';
		const key = new URL('/__pandalibrary_range_cache__', url.origin);
		key.searchParams.set('account', String(account));
		if (this.bookId > 0) key.searchParams.set('book', String(this.bookId));
		if (this.fileId > 0) key.searchParams.set('file', String(this.fileId));
		key.searchParams.set('url', url.pathname + url.search);
		this.key = new Request(key);
	}

	static available(): boolean {
		return typeof caches !== 'undefined';
	}

	async get(index: number): Promise<Uint8Array | null> {
		if (!RangeCache.available()) return null;
		try {
			const cache = await openReaderCache(RANGE_CACHE_NAME);
			const req = this.request(index);
			const response = await cache.match(req);
			if (!response) return null;
			touchReaderCacheEntry(req.url);
			return new Uint8Array(await response.arrayBuffer());
		} catch {
			return null;
		}
	}

	async put(index: number, data: Uint8Array): Promise<void> {
		if (!RangeCache.available()) return;
		try {
			requestPersistentStorageOnce();
			const cache = await openReaderCache(RANGE_CACHE_NAME);
			const req = this.request(index);
			const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
			const now = Date.now();
			const entry: Omit<LedgerEntry, 'key' | 'cache'> = {
				account: this.account,
				bookId: this.bookId,
				fileId: this.fileId,
				title: this.bookTitle,
				bytes: data.byteLength,
				updatedAt: now
			};
			await cache.put(req, new Response(body, {
				headers: cacheEntryHeaders(entry)
			}));
			recordReaderCacheEntry({
				...entry,
				key: req.url,
				cache: 'range'
			});
		} catch {
			// Best effort: private browsing and quota errors must not break reading.
		}
	}

	private request(index: number): Request {
		const request = new URL(this.key.url);
		request.searchParams.set('index', String(index));
		return new Request(request);
	}
}
