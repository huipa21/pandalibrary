/**
 * Formats the server sniffs. These lists only filter file pickers and drops; the upload
 * endpoint decides support and size, so a rejection still arrives as 415 or 413.
 */
export const SUPPORTED_EXTENSIONS = ['.epub', '.pdf', '.mobi', '.azw', '.azw3', '.fb2', '.fbz', '.cbz'] as const;
export const UPLOAD_ACCEPT = SUPPORTED_EXTENSIONS.join(',');
/** Mirrors the server's default `--max-upload-mb` (1024 MiB); the server remains authoritative. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export function hasSupportedExtension(name: string): boolean {
	const lower = name.toLowerCase();
	return SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension) && lower.length > extension.length);
}
