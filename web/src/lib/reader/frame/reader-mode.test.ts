import { afterEach, describe, expect, it, vi } from 'vitest';
import { READER_MODE_KEY, readReaderMode, storeReaderMode } from './reader-mode.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('reader mode preference', () => {
	it('defaults to off and stores a boolean as a string', () => {
		const values = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value)
		});
		expect(readReaderMode()).toBe(false);
		storeReaderMode(true);
		expect(values.get(READER_MODE_KEY)).toBe('true');
		expect(readReaderMode()).toBe(true);
		storeReaderMode(false);
		expect(readReaderMode()).toBe(false);
	});

	it('falls back to off when storage is blocked', () => {
		vi.stubGlobal('localStorage', {
			getItem() { throw new Error('SecurityError'); },
			setItem() { throw new Error('QuotaExceededError'); }
		});
		expect(readReaderMode()).toBe(false);
		expect(() => storeReaderMode(true)).not.toThrow();
	});
});
