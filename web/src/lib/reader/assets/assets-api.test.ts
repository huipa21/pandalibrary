import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveViewer } from '#lib/sync/db.js';
import { uploadAnnotationAsset, OfflineError } from './assets-api.js';
import type { PreparedAnnotationImage } from './prepare-image.js';

const fetcher = vi.fn<typeof fetch>();
// The shared API client captures fetch when constructed.
vi.mock('#lib/api/client.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('#lib/api/client.js')>();
	return { ...original, api: original.createApiClient({ fetcher: (...args) => fetcher(...args) }) };
});

const prepared: PreparedAnnotationImage = {
	blob: new Blob(['image'], { type: 'image/webp' }), width: 10, height: 20, media_type: 'image/webp'
};
const asset = { sha256: 'a'.repeat(64), media_type: 'image/webp', width: 10, height: 20, size: 5 };
const viewer = { id: 1, username: 'a', display_name: '', role: 'user', locale: 'en' as const };

beforeEach(async () => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal('IDBKeyRange', IDBKeyRange);
	vi.stubGlobal('navigator', { onLine: true, locks: { request: (_name: string, action: () => unknown) => action() } });
	fetcher.mockReset();
	await setActiveViewer(viewer);
});
afterEach(() => vi.unstubAllGlobals());

describe('annotation assets API', () => {
	it('uploads a raw prepared image and returns the asset', async () => {
		fetcher.mockResolvedValue(Response.json({ asset }, { status: 201 }));
		await expect(uploadAnnotationAsset(prepared)).resolves.toEqual(asset);
		const [path, request] = fetcher.mock.calls[0];
		expect(path).toBe('/api/v1/me/annotation-assets');
		expect(request).toMatchObject({ method: 'POST', body: prepared.blob, cache: 'no-store', credentials: 'same-origin' });
		expect(new Headers(request?.headers).get('content-type')).toBe('image/webp');
	});

	it('rejects offline uploads without sending a request', async () => {
		vi.stubGlobal('navigator', { onLine: false });
		await expect(uploadAnnotationAsset(prepared)).rejects.toBeInstanceOf(OfflineError);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each(['asset_too_large', 'unsupported_media_type', 'invalid_image', 'invalid_image_dimensions'])(
		'maps %s problems to localized typed errors', async (code) => {
			fetcher.mockResolvedValue(Response.json({ code }, { status: 400, headers: { 'content-type': 'application/problem+json' } }));
			await expect(uploadAnnotationAsset(prepared)).rejects.toMatchObject({ name: 'AnnotationImageError', code });
		}
	);

	it('preserves session and unexpected server errors', async () => {
		fetcher.mockResolvedValue(new Response(null, { status: 401 }));
		await expect(uploadAnnotationAsset(prepared)).rejects.toMatchObject({ name: 'ApiError', status: 401 });
		fetcher.mockRejectedValue(new TypeError('network'));
		await expect(uploadAnnotationAsset(prepared)).rejects.toThrow('network');
	});

	it('rejects malformed success responses and an account change during upload', async () => {
		fetcher.mockResolvedValue(Response.json({ asset: { ...asset, width: 0 } }));
		await expect(uploadAnnotationAsset(prepared)).rejects.toMatchObject({ code: 'invalid_response' });
		fetcher.mockImplementation(async () => {
			await setActiveViewer({ ...viewer, id: 2 });
			return Response.json({ asset });
		});
		await expect(uploadAnnotationAsset(prepared)).rejects.toMatchObject({ name: 'AccountChangedError' });
	});
});
