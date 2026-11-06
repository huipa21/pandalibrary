import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import { bulkErrorKey, heapErrorKey, summarizeResults } from './results.js';

describe('bulk results', () => {
	it('maps per-item error codes to localized keys', () => {
		expect(bulkErrorKey('delete', 'not_found')).toBe('bh4.result.not_found');
		expect(bulkErrorKey('delete', 'busy')).toBe('bh4.result.busy');
		expect(bulkErrorKey('delete', 'changed')).toBe('bh4.result.failed');
		expect(bulkErrorKey('assign', 'not_assignable')).toBe('bh4.result.not_assignable');
		expect(bulkErrorKey('assign', 'not_found')).toBe('bh4.result.not_found');
		expect(bulkErrorKey('assign', 'whatever')).toBe('bh4.result.failed');
		expect(bulkErrorKey('assign', null)).toBe('bh4.result.failed');
	});

	it('splits successes from failures and treats missing results as failures', () => {
		const outcome = summarizeResults(
			'delete',
			[1, 2, 3],
			[
				{ id: 1, ok: true, error: null },
				{ id: 2, ok: false, error: 'busy' }
			],
			(id) => `Book ${id}`
		);
		expect(outcome.succeeded).toEqual([1]);
		expect(outcome.failures).toEqual([
			{ id: 2, title: 'Book 2', messageKey: 'bh4.result.busy' },
			{ id: 3, title: 'Book 3', messageKey: 'bh4.result.failed' }
		]);
	});
});

describe('heapErrorKey', () => {
	const error = (status: number) => new ApiError(status, 'x', '');

	it('explains assign target errors', () => {
		expect(heapErrorKey(error(404), 'assign')).toBe('bh4.assign.error_missing');
		expect(heapErrorKey(error(400), 'assign')).toBe('bh4.assign.error_invalid');
		expect(heapErrorKey(error(422), 'assign')).toBe('bh4.assign.error_invalid');
	});

	it('explains a scan rejected during shutdown and falls back to admin messages', () => {
		expect(heapErrorKey(error(503), 'scan')).toBe('bh4.scan.error_stopping');
		expect(heapErrorKey(error(403), 'load')).toBe('admin.error.forbidden');
		expect(heapErrorKey(new TypeError('offline'), 'delete')).toBe('admin.error.connection');
	});
});
