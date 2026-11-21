import { describe, expect, it } from 'vitest';
import { inspectBookFile, isValidUploadName } from './upload-checks.js';

const encoder = new TextEncoder();
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

function book(name: string, bytes: string | Uint8Array<ArrayBuffer>): File {
	return new File([typeof bytes === 'string' ? encoder.encode(bytes) : bytes], name);
}

describe('inspectBookFile', () => {
	it('accepts supported signatures', async () => {
		await expect(inspectBookFile(book('a.epub', zip))).resolves.toBeNull();
		await expect(inspectBookFile(book('a.cbz', zip))).resolves.toBeNull();
		await expect(inspectBookFile(book('a.pdf', '%PDF-1.7'))).resolves.toBeNull();
		await expect(inspectBookFile(book('a.fb2', '<?xml version="1.0"?><FictionBook>'))).resolves.toBeNull();
		const mobi = new Uint8Array(80);
		mobi.set(encoder.encode('BOOKMOBI'), 60);
		await expect(inspectBookFile(book('a.mobi', mobi))).resolves.toBeNull();
	});

	it('rejects unsupported, empty, invalid, and oversized files', async () => {
		await expect(inspectBookFile(book('a.txt', zip))).resolves.toBe('unsupported');
		await expect(inspectBookFile(book('a.epub', 'not a zip'))).resolves.toBe('unsupported');
		await expect(inspectBookFile(book('a.epub', new Uint8Array()))).resolves.toBe('invalid');
		await expect(inspectBookFile(book(' bad.epub', zip))).resolves.toBe('invalid');
		await expect(inspectBookFile(book('a.epub', zip), { maxBytes: 1 })).resolves.toBe('too_large');
	});

	it('mirrors the server filename rules', () => {
		expect(isValidUploadName('a.epub')).toBe(true);
		expect(isValidUploadName('a/b.epub')).toBe(false);
		expect(isValidUploadName('a.epub ')).toBe(false);
		expect(isValidUploadName('a.epub.')).toBe(false);
		expect(isValidUploadName('a\u0085.epub')).toBe(false);
	});
});
