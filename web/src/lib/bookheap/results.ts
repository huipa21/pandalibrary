import { ApiError } from '#lib/api/client.js';
import { adminErrorKey } from '#lib/admin/form.js';
import type { HeapItemResult } from './api.js';

export type BulkKind = 'assign' | 'delete';

export interface BulkFailure {
	readonly id: number;
	readonly title: string;
	/** Paraglide message key describing the per-item error. */
	readonly messageKey: string;
}

export interface BulkOutcome {
	readonly succeeded: number[];
	readonly failures: BulkFailure[];
}

/**
 * Maps a per-item error code to a message key. Codes without a specific message (for example
 * `changed` and `failed`) are shown as a generic failure.
 */
export function bulkErrorKey(kind: BulkKind, code: string | null): string {
	switch (code) {
		case 'not_found':
			return 'bh4.result.not_found';
		case 'busy':
			return kind === 'delete' ? 'bh4.result.busy' : 'bh4.result.failed';
		case 'not_assignable':
			return kind === 'assign' ? 'bh4.result.not_assignable' : 'bh4.result.failed';
		default:
			return 'bh4.result.failed';
	}
}

/**
 * Splits bulk results into succeeded IDs and failures with titles. IDs that were sent but missing
 * from the response are reported as generic failures rather than silently treated as done.
 */
export function summarizeResults(
	kind: BulkKind,
	sent: readonly number[],
	results: readonly HeapItemResult[],
	titleOf: (id: number) => string
): BulkOutcome {
	const byId = new Map(results.map((result) => [result.id, result]));
	const succeeded: number[] = [];
	const failures: BulkFailure[] = [];
	for (const id of sent) {
		const result = byId.get(id);
		if (result?.ok) succeeded.push(id);
		else failures.push({ id, title: titleOf(id), messageKey: bulkErrorKey(kind, result?.error ?? null) });
	}
	return { succeeded, failures };
}

export type HeapAction = 'load' | 'more' | 'scan' | 'delete' | 'assign' | 'load_targets';

/** Maps a failed request to a localized message key without echoing server text. */
export function heapErrorKey(error: unknown, action: HeapAction): string {
	if (action === 'assign' && error instanceof ApiError) {
		if (error.status === 404) return 'bh4.assign.error_missing';
		if (error.status === 400 || error.status === 422) return 'bh4.assign.error_invalid';
	}
	if (action === 'scan' && error instanceof ApiError && error.status === 503) return 'bh4.scan.error_stopping';
	return adminErrorKey(error, action === 'more' ? 'more' : action === 'load_targets' ? 'load_libraries' : 'load');
}
