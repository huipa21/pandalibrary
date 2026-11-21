import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	UPLOAD_LIBRARY_STORAGE_KEY,
	readLastUploadLibraryId,
	rememberLastUploadLibraryId,
	resolveUploadLibraryId
} from './upload-library.js';

const libraries = [{ id: 2 }, { id: 3 }];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('upload library defaulting', () => {
	it('selects the only library regardless of the current or stored choice', () => {
		expect(resolveUploadLibraryId([{ id: 7 }], 2, 3)).toBe(7);
		expect(resolveUploadLibraryId([{ id: 7 }], null, null)).toBe(7);
		expect(resolveUploadLibraryId([], 2, 3)).toBeNull();
	});

	it('keeps a valid current choice before the stored choice', () => {
		expect(resolveUploadLibraryId(libraries, 3, 2)).toBe(3);
		expect(resolveUploadLibraryId(libraries, null, 2)).toBe(2);
	});

	it('ignores choices that are no longer available', () => {
		expect(resolveUploadLibraryId(libraries, 9, 3)).toBe(3);
		expect(resolveUploadLibraryId(libraries, 8, 9)).toBeNull();
	});

	it('reads and writes the last library safely', () => {
		const values = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key)
		});
		expect(readLastUploadLibraryId()).toBeNull();
		rememberLastUploadLibraryId(4);
		expect(values.get(UPLOAD_LIBRARY_STORAGE_KEY)).toBe('4');
		expect(readLastUploadLibraryId()).toBe(4);
		rememberLastUploadLibraryId(0);
		expect(values.has(UPLOAD_LIBRARY_STORAGE_KEY)).toBe(false);
		vi.stubGlobal('localStorage', {
			getItem() { throw new Error('SecurityError'); },
			setItem() { throw new Error('QuotaExceededError'); },
			removeItem() { throw new Error('SecurityError'); }
		});
		expect(readLastUploadLibraryId()).toBeNull();
		expect(() => rememberLastUploadLibraryId(4)).not.toThrow();
		expect(() => rememberLastUploadLibraryId(null)).not.toThrow();
	});
});
