export const READER_MODE_KEY = 'pandalibrary.reader-mode';

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export function readReaderMode(): boolean {
	try {
		return storage()?.getItem(READER_MODE_KEY) === 'true';
	} catch {
		return false;
	}
}

export function storeReaderMode(value: boolean): void {
	try {
		storage()?.setItem(READER_MODE_KEY, value ? 'true' : 'false');
	} catch {
		// A blocked storage area only costs the preference; reading still works.
	}
}
