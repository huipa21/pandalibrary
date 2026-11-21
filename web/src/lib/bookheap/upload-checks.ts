/** Formats the extract registry sniffs; the server remains authoritative. */
export const SUPPORTED_EXTENSIONS = ['.epub', '.pdf', '.mobi', '.azw3', '.fb2', '.fbz', '.cbz'] as const;
export const UPLOAD_ACCEPT = SUPPORTED_EXTENSIONS.join(',');
/** Mirrors the server's default `--max-upload-mb` (1024 MiB); the server remains authoritative. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const PREFIX_BYTES = 64 << 10;

export type UploadFileProblem = 'unsupported' | 'too_large' | 'invalid';

export function hasSupportedExtension(name: string): boolean {
	const lower = name.toLowerCase();
	return SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension) && lower.length > extension.length);
}

/** Mirrors importer.ValidFilename closely enough to reject invalid names before upload. */
export function isValidUploadName(name: string): boolean {
	return (
		name.length > 0 &&
		name !== '.' &&
		name !== '..' &&
		name.trim() === name &&
		new TextEncoder().encode(name).length <= 255 &&
		!/[/\\:<>"|?*\u0000-\u001f\u007f-\u009f]/.test(name) &&
		!name.endsWith('.')
	);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array): string {
	let result = '';
	for (const byte of bytes) result += String.fromCharCode(byte);
	return result;
}

function hasBookSignature(name: string, prefix: Uint8Array): boolean {
	const extension = name.toLowerCase().slice(name.lastIndexOf('.'));
	switch (extension) {
		case '.pdf':
			return startsWith(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d]);
		case '.mobi':
		case '.azw3':
			return prefix.length >= 68 && ascii(prefix.subarray(60, 68)) === 'BOOKMOBI';
		case '.fb2':
			return ascii(prefix).includes('<FictionBook');
		case '.epub':
		case '.fbz':
		case '.cbz':
			return (
				startsWith(prefix, [0x50, 0x4b, 0x03, 0x04]) ||
				startsWith(prefix, [0x50, 0x4b, 0x05, 0x06]) ||
				startsWith(prefix, [0x50, 0x4b, 0x07, 0x08])
			);
		default:
			return false;
	}
}

/**
 * Pre-upload checks that are possible without parsing the whole book. The
 * upload endpoint still sniffs and extracts the complete file.
 */
export async function inspectBookFile(
	file: File,
	{ maxBytes = MAX_UPLOAD_BYTES }: { readonly maxBytes?: number } = {}
): Promise<UploadFileProblem | null> {
	if (!isValidUploadName(file.name)) return 'invalid';
	if (!hasSupportedExtension(file.name)) return 'unsupported';
	if (file.size <= 0) return 'invalid';
	if (file.size > maxBytes) return 'too_large';
	const prefix = new Uint8Array(await file.slice(0, Math.min(file.size, PREFIX_BYTES)).arrayBuffer());
	if (!hasBookSignature(file.name, prefix)) return 'unsupported';
	return null;
}
