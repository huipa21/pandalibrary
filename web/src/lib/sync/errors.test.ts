import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import { AccountChangedError, OfflineStorageError } from './db.js';
import { SyncProtocolError } from './engine.js';
import { syncFailureMessage } from './errors.js';

describe('sync failure diagnostics', () => {
	it('shows HTTP status without exposing arbitrary server responses', () => {
		const error = new ApiError(503, 'Unavailable', 'private response', { detail: 'private detail' });
		expect(syncFailureMessage(error)).toContain('HTTP 503');
		expect(syncFailureMessage(error)).not.toContain('private');
	});

	it('distinguishes connectivity, protocol, storage and account failures', () => {
		expect(syncFailureMessage(new TypeError('Failed to fetch'))).toContain('connection');
		expect(syncFailureMessage(new SyncProtocolError('The pull response is missing notes.')))
			.toContain('invalid response. Retry syncing or contact your administrator. The pull response is missing notes.');
		expect(syncFailureMessage(new OfflineStorageError('IndexedDB is unavailable.'))).toContain('offline storage');
		expect(syncFailureMessage(new DOMException('Full', 'QuotaExceededError'))).toContain('offline storage');
		for (const error of [new AccountChangedError(), new ApiError(401, 'Unauthorized', '')]) {
			expect(syncFailureMessage(error)).toContain('Sign in again');
		}
	});

	it('keeps unexpected failures visible without echoing untrusted error text', () => {
		expect(syncFailureMessage(new Error('private data'))).toContain('failed unexpectedly');
		expect(syncFailureMessage('private data')).not.toContain('private data');
	});
});
