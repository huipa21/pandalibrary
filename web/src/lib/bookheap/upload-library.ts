import type { Library } from '#lib/admin/types.js';

/** Remembers the last library used by the shared upload dialog across reloads. */
export const UPLOAD_LIBRARY_STORAGE_KEY = 'pandalibrary.bookheap.upload.library';

function positiveId(value: unknown): number | null {
	const id = typeof value === 'number' ? value : Number(value);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export function readLastUploadLibraryId(): number | null {
	try {
		return positiveId(storage()?.getItem(UPLOAD_LIBRARY_STORAGE_KEY));
	} catch {
		return null;
	}
}

export function rememberLastUploadLibraryId(id: number | null): void {
	try {
		const value = positiveId(id);
		if (value === null) storage()?.removeItem(UPLOAD_LIBRARY_STORAGE_KEY);
		else storage()?.setItem(UPLOAD_LIBRARY_STORAGE_KEY, String(value));
	} catch {
		// Restricted storage must not block uploads.
	}
}

/**
 * Prefers the only available library, then the current in-session choice, then
 * the last library used by the upload dialog.
 */
export function resolveUploadLibraryId(
	libraries: readonly Pick<Library, 'id'>[],
	current: number | null,
	stored: number | null = readLastUploadLibraryId()
): number | null {
	if (libraries.length === 1) return libraries[0]?.id ?? null;
	const valid = (id: number | null) => id !== null && libraries.some((library) => library.id === id) ? id : null;
	return valid(current) ?? valid(stored);
}
