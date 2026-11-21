import { describe, expect, it, vi } from 'vitest';
import type { HeapPrecheckMatch } from './api.js';
import { preflightFiles } from './upload-preflight.js';
import type { UploadFileProblem } from './upload-checks.js';

function file(name: string): File {
	return new File([new Uint8Array(4)], name);
}

describe('preflightFiles', () => {
	it('checks names, hashes, server duplicates, and duplicates within the selection', async () => {
		const signal = new AbortController().signal;
		const a = file('a.epub');
		const b = file('b.epub');
		const c = file('c.epub');
		const invalid = file('bad.txt');
		const big = file('big.fb2');
		const aHash = 'a'.repeat(64);
		const bHash = 'b'.repeat(64);
		const inspect = vi.fn(async (input: File): Promise<UploadFileProblem | null> => {
			if (input.name === 'bad.txt') return 'unsupported';
			if (input.name === 'big.fb2') return 'too_large';
			return null;
		});
		const hash = vi.fn(async (input: Blob): Promise<string> => (input instanceof File && input.name === 'a.epub' ? aHash : bHash));
		const check = vi.fn(async (_libraryId: number, hashes: readonly string[], _signal?: AbortSignal): Promise<Map<string, HeapPrecheckMatch>> => {
			const result = new Map<string, HeapPrecheckMatch>();
			if (hashes.includes(aHash)) result.set(aHash, { sha256: aHash, duplicate_of_book_id: 42, duplicate_of_item_id: null });
			return result;
		});

		const outcomes = await preflightFiles(
			[
				{ file: a, sha256: null },
				{ file: b, sha256: bHash },
				{ file: c, sha256: null },
				{ file: invalid, sha256: null },
				{ file: big, sha256: null }
			],
			{ libraryId: 7, signal, inspect, hash, check }
		);

		expect(hash).toHaveBeenCalledTimes(2);
		expect(check).toHaveBeenCalledTimes(1);
		expect(check.mock.calls[0][0]).toBe(7);
		expect(check.mock.calls[0][1]).toEqual([aHash, bHash]);
		expect(check.mock.calls[0][2]).toBe(signal);
		expect(outcomes).toEqual([
			{ sha256: aHash, error: 'duplicate_book', duplicateOf: 42 },
			{ sha256: bHash, error: null, duplicateOf: null },
			{ sha256: bHash, error: 'duplicate_selected', duplicateOf: null },
			{ sha256: null, error: 'unsupported', duplicateOf: null },
			{ sha256: null, error: 'too_large', duplicateOf: null }
		]);
	});

	it('batches duplicate lookups at the server limit', async () => {
		const hashes = Array.from({ length: 1001 }, (_, index) => index.toString(16).padStart(64, '0'));
		const inputs = hashes.map((sha256, index) => ({ file: file(`f${index}.epub`), sha256 }));
		const check = vi.fn(async (_libraryId: number, _hashes: readonly string[], _signal?: AbortSignal) => new Map<string, HeapPrecheckMatch>());
		const outcomes = await preflightFiles(inputs, {
			libraryId: 1,
			signal: new AbortController().signal,
			inspect: async () => null,
			hash: async () => '',
			check
		});
		expect(check).toHaveBeenCalledTimes(2);
		expect(check.mock.calls.map(([, batch]) => batch.length)).toEqual([1000, 1]);
		expect(outcomes.every((outcome) => outcome.error === null)).toBe(true);
	});

	it('does not inspect or hash after abort', async () => {
		const controller = new AbortController();
		controller.abort();
		const inspect = vi.fn(async () => null);
		await expect(
			preflightFiles([{ file: file('a.epub'), sha256: null }], {
				libraryId: 1,
				signal: controller.signal,
				inspect
			})
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(inspect).not.toHaveBeenCalled();
	});
});
