import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, SUPPORTED_EXTENSIONS, hasSupportedExtension } from './upload-checks.js';

describe('hasSupportedExtension', () => {
	it('accepts every format the server sniffs', () => {
		for (const extension of SUPPORTED_EXTENSIONS) expect(hasSupportedExtension(`book${extension}`)).toBe(true);
		expect(hasSupportedExtension('BOOK.EPUB')).toBe(true);
		expect(hasSupportedExtension('book.azw')).toBe(true);
	});

	it('rejects unknown and bare extensions', () => {
		expect(hasSupportedExtension('book.txt')).toBe(false);
		expect(hasSupportedExtension('book.epub.exe')).toBe(false);
		expect(hasSupportedExtension('.epub')).toBe(false);
		expect(hasSupportedExtension('epub')).toBe(false);
	});

	it('mirrors the server upload limit', () => {
		expect(MAX_UPLOAD_BYTES).toBe(1024 * 1024 * 1024);
	});
});
