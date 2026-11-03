import { ApiError } from '#lib/api/client.js';

export type RequestErrorKind =
	| 'invalid'
	| 'unauthorized'
	| 'forbidden'
	| 'not_found'
	| 'conflict'
	| 'api'
	| 'connection';

/** Classifies a request failure without exposing server-provided details to the UI. */
export function requestErrorKind(error: unknown): RequestErrorKind {
	if (!(error instanceof ApiError)) return 'connection';
	switch (error.status) {
		case 400:
		case 422:
			return 'invalid';
		case 401:
			return 'unauthorized';
		case 403:
			return 'forbidden';
		case 404:
			return 'not_found';
		case 409:
			return 'conflict';
		default:
			return 'api';
	}
}
