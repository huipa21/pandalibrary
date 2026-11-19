const CACHE_NAME = 'pandalibrary-book-ranges-v1';
const MAX_CHUNKS = 256; // ~64 MiB at the 256 KiB range size.

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

	constructor(account: number, url: URL) {
		const key = new URL('/__pandalibrary_range_cache__', url.origin);
		key.searchParams.set('account', String(account));
		key.searchParams.set('url', url.pathname + url.search);
		this.key = new Request(key);
	}

	static available(): boolean {
		return typeof caches !== 'undefined';
	}

	async get(index: number): Promise<Uint8Array | null> {
		try {
			const cache = await caches.open(CACHE_NAME);
			const response = await cache.match(this.request(index));
			return response ? new Uint8Array(await response.arrayBuffer()) : null;
		} catch {
			return null;
		}
	}

	async put(index: number, data: Uint8Array): Promise<void> {
		try {
			const cache = await caches.open(CACHE_NAME);
			const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
			await cache.put(this.request(index), new Response(body, {
				headers: { 'Content-Type': 'application/octet-stream' }
			}));
			await prune(cache);
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

async function prune(cache: Cache): Promise<void> {
	const keys = await cache.keys();
	for (let index = 0; index < keys.length - MAX_CHUNKS; index += 1) {
		await cache.delete(keys[index]);
	}
}
