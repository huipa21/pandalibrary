import { api, toApiError } from '#lib/api/client.js';
import { activeViewer, AccountChangedError } from '#lib/sync/db.js';
import { withSessionLock } from '#lib/sync/engine.js';
import { AnnotationImageError, assetRequestError, OfflineError } from './errors.js';
import type { PreparedAnnotationImage } from './prepare-image.js';

export { prepareAnnotationImage } from './prepare-image.js';
export { AnnotationImageError, OfflineError } from './errors.js';

export interface AnnotationAsset {
	readonly sha256: string;
	readonly media_type: 'image/png' | 'image/jpeg' | 'image/webp';
	readonly size: number;
	readonly width: number;
	readonly height: number;
}

export function validAssetHash(hash: string): boolean {
	return /^[a-f0-9]{64}$/.test(hash);
}

function isAsset(value: unknown): value is AnnotationAsset {
	if (typeof value !== 'object' || value === null) return false;
	const asset = value as Record<string, unknown>;
	return typeof asset.sha256 === 'string' && validAssetHash(asset.sha256) &&
		['image/png', 'image/jpeg', 'image/webp'].includes(String(asset.media_type)) &&
		typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= (5 << 20) &&
		typeof asset.width === 'number' && Number.isInteger(asset.width) && asset.width >= 1 && asset.width <= 8192 &&
		typeof asset.height === 'number' && Number.isInteger(asset.height) && asset.height >= 1 && asset.height <= 8192;
}

export function requireOnline(): void {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new OfflineError();
}

export async function requireAssetAccount(expected?: number): Promise<number> {
	const viewer = await activeViewer();
	if (!viewer || expected !== undefined && viewer.id !== expected) throw new AccountChangedError();
	return viewer.id;
}

export async function uploadAnnotationAsset(prepared: PreparedAnnotationImage): Promise<AnnotationAsset> {
	requireOnline();
	return withSessionLock(async () => {
		const account = await requireAssetAccount();
		try {
			const response = await api.request<{ asset: unknown }, Blob>('/me/annotation-assets', {
				method: 'POST', body: prepared.blob, headers: { 'content-type': prepared.media_type },
				credentials: 'same-origin', cache: 'no-store', redirect: 'error'
			});
			await requireAssetAccount(account);
			if (!isAsset(response?.asset)) throw new AnnotationImageError('invalid_response');
			return response.asset;
		} catch (error) {
			throw assetRequestError(error);
		}
	}, true);
}

export async function downloadAnnotationAsset(hash: string, signal?: AbortSignal): Promise<Blob> {
	if (!validAssetHash(hash)) throw new AnnotationImageError('invalid_asset_hash');
	requireOnline();
	const response = await fetch(`/api/v1/me/annotation-assets/${hash}`, {
		credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal
	});
	if (!response.ok) throw assetRequestError(await toApiError(response));
	const blob = await response.blob();
	if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || blob.size < 1 || blob.size > (5 << 20)) {
		throw new AnnotationImageError('invalid_response');
	}
	return blob;
}
