import { ApiError } from '#lib/api/client.js';
import * as m from '#lib/paraglide/messages.js';

export type ImageErrorCode =
	| 'unsupported_media_type' | 'input_too_large' | 'asset_too_large'
	| 'invalid_image' | 'invalid_image_dimensions' | 'invalid_asset_hash'
	| 'asset_not_found' | 'offline' | 'invalid_response';

export class AnnotationImageError extends Error {
	constructor(readonly code: ImageErrorCode, options?: ErrorOptions) {
		super(imageErrorMessage(code), options);
		this.name = 'AnnotationImageError';
	}
}

export class OfflineError extends AnnotationImageError {
	constructor() {
		super('offline');
		this.name = 'OfflineError';
	}
}

function imageErrorMessage(code: ImageErrorCode): string {
	switch (code) {
		case 'unsupported_media_type': return m['pv7.error.unsupported_media_type']();
		case 'input_too_large': return m['pv7.error.input_too_large']();
		case 'asset_too_large': return m['pv7.error.asset_too_large']();
		case 'invalid_image': return m['pv7.error.invalid_image']();
		case 'invalid_image_dimensions': return m['pv7.error.invalid_image_dimensions']();
		case 'invalid_asset_hash': return m['pv7.error.invalid_asset_hash']();
		case 'asset_not_found': return m['pv7.error.asset_not_found']();
		case 'offline': return m['pv7.error.offline']();
		case 'invalid_response': return m['pv7.error.invalid_response']();
	}
}

export function assetRequestError(error: unknown): unknown {
	if (!(error instanceof ApiError)) return error;
	switch (error.problem?.code) {
		case 'unsupported_media_type': case 'asset_too_large': case 'invalid_image':
		case 'invalid_image_dimensions': case 'invalid_asset_hash': case 'asset_not_found':
			return new AnnotationImageError(error.problem.code, { cause: error });
		default: return error;
	}
}
