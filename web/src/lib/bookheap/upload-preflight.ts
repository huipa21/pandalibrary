import { precheckHeapFiles, type HeapPrecheckMatch } from './api.js';
import { hashFile } from './sha256.js';
import { inspectBookFile, type UploadFileProblem } from './upload-checks.js';
import type { UploadErrorKind } from './upload-queue.svelte.js';

/** Server caps one precheck request at 1000 hashes. */
const PRECHECK_BATCH_SIZE = 1000;

export interface PreflightInput {
	readonly file: File;
	readonly sha256: string | null;
}

export interface PreflightOutcome {
	sha256: string | null;
	error: UploadErrorKind | null;
	/** Book or Bookheap item id for duplicate errors. */
	duplicateOf: number | null;
}

export interface PreflightOptions {
	readonly libraryId: number;
	readonly signal: AbortSignal;
	readonly maxBytes?: number;
	readonly onprogress?: (index: number, loaded: number, total: number) => void;
	readonly hash?: typeof hashFile;
	readonly inspect?: typeof inspectBookFile;
	readonly check?: typeof precheckHeapFiles;
}

export type Preflighter = (
	inputs: readonly PreflightInput[],
	options: PreflightOptions
) => PreflightOutcome[] | Promise<PreflightOutcome[]>;

function abortError(): DOMException {
	return new DOMException('The upload was aborted.', 'AbortError');
}

/**
 * Preflights every selected file before an upload request is sent. Existing
 * hashes are reused on retries. The server still rechecks duplicates and parses
 * the complete file; this only prevents predictable work and duplicate traffic.
 */
export async function preflightFiles(
	inputs: readonly PreflightInput[],
	{
		libraryId,
		signal,
		maxBytes,
		onprogress,
		hash = hashFile,
		inspect = inspectBookFile,
		check = precheckHeapFiles
	}: PreflightOptions
): Promise<PreflightOutcome[]> {
	const results: PreflightOutcome[] = inputs.map(({ sha256 }) => ({ sha256, error: null, duplicateOf: null }));
	const hashes: string[] = [];

	for (let index = 0; index < inputs.length; index += 1) {
		if (signal.aborted) throw abortError();
		const input = inputs[index];
		let problem: UploadFileProblem | null = null;
		try {
			problem = await inspect(input.file, { maxBytes });
		} catch {
			if (signal.aborted) throw abortError();
			results[index].error = 'unknown';
			continue;
		}
		if (problem) {
			results[index].error = problem;
			continue;
		}

		let sha256 = input.sha256;
		if (sha256) {
			onprogress?.(index, input.file.size, input.file.size);
		} else {
			try {
				sha256 = await hash(input.file, {
					signal,
					onprogress: (loaded, total) => onprogress?.(index, loaded, total)
				});
			} catch (error) {
				if (signal.aborted) throw error;
				results[index].error = 'unknown';
				continue;
			}
		}
		results[index].sha256 = sha256;
		hashes.push(sha256);
	}

	const distinct = [...new Set(hashes)];
	const matches = new Map<string, HeapPrecheckMatch>();
	for (let offset = 0; offset < distinct.length; offset += PRECHECK_BATCH_SIZE) {
		const batch = await check(libraryId, distinct.slice(offset, offset + PRECHECK_BATCH_SIZE), signal);
		for (const [sha256, match] of batch) matches.set(sha256, match);
	}

	for (const result of results) {
		if (result.error || !result.sha256) continue;
		const match = matches.get(result.sha256);
		if (match?.duplicate_of_book_id) {
			result.error = 'duplicate_book';
			result.duplicateOf = match.duplicate_of_book_id;
		} else if (match?.duplicate_of_item_id) {
			result.error = 'duplicate_item';
			result.duplicateOf = match.duplicate_of_item_id;
		}
	}

	const seen = new Set<string>();
	for (const result of results) {
		if (result.error || !result.sha256) continue;
		if (seen.has(result.sha256)) {
			result.error = 'duplicate_selected';
			continue;
		}
		seen.add(result.sha256);
	}
	return results;
}
