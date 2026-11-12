import { ApiError } from '#lib/api/client.js';
import * as m from '#lib/paraglide/messages.js';
import { AccountChangedError, OfflineStorageError } from './db.js';
import { SyncProtocolError } from './engine.js';

export function syncFailureMessage(error: unknown): string {
	if (error instanceof AccountChangedError ||
		(error instanceof ApiError && (error.status === 401 || error.status === 409))) {
		return m['offline.failure.account']();
	}
	if (error instanceof ApiError) return m['offline.failure.http']({ status: error.status });
	if (error instanceof SyncProtocolError) return `${m['offline.failure.protocol']()} ${error.message}`;
	if (error instanceof OfflineStorageError || (error instanceof DOMException &&
		['QuotaExceededError', 'InvalidStateError', 'SecurityError', 'UnknownError'].includes(error.name))) {
		return m['offline.failure.storage']();
	}
	if (error instanceof TypeError) return m['offline.failure.network']();
	return m['offline.failure.unknown']();
}
