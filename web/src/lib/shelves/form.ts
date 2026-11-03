import { requestErrorKind } from '#lib/paging/errors.js';
import { MAX_SHELF_DESCRIPTION_BYTES, MAX_SHELF_NAME_BYTES } from './api.js';
import type { SessionViewer, Shelf, ShelfKind } from './types.js';

export type ShelfFieldError = 'name_required' | 'name_too_long' | 'name_invalid' | 'description_too_long';

export type ShelfDraftResult =
	| { readonly ok: true; readonly name: string; readonly description: string | null }
	| { readonly ok: false; readonly error: ShelfFieldError };

export interface ShelfFormValue {
	readonly kind: ShelfKind;
	readonly name: string;
	readonly description: string | null;
}

const encoder = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Mirrors SH1's documented input limits so obvious mistakes are reported before submitting. */
export function validateShelfDraft(draft: { readonly name: string; readonly description: string }): ShelfDraftResult {
	const name = draft.name.trim();
	if (!name) return { ok: false, error: 'name_required' };
	if (encoder.encode(name).length > MAX_SHELF_NAME_BYTES) return { ok: false, error: 'name_too_long' };
	if (CONTROL_CHARACTERS.test(name)) return { ok: false, error: 'name_invalid' };
	const description = draft.description.trim() ? draft.description : null;
	if (description !== null && encoder.encode(description).length > MAX_SHELF_DESCRIPTION_BYTES) {
		return { ok: false, error: 'description_too_long' };
	}
	return { ok: true, name, description };
}

export function isAdministrator(viewer: SessionViewer | null): boolean {
	return viewer?.role === 'admin';
}

/**
 * Decides whether to *offer* management controls. The server remains the authority and
 * every mutation still handles 403/404 responses.
 */
export function offersShelfManagement(shelf: Shelf, viewer: SessionViewer | null): boolean {
	if (!viewer) return false;
	if (isAdministrator(viewer)) return true;
	return shelf.kind === 'private' && shelf.owner_id === viewer.id;
}

export type ShelfAction =
	| 'load'
	| 'more_shelves'
	| 'load_books'
	| 'more_books'
	| 'save'
	| 'delete'
	| 'add_book'
	| 'remove_book';

/** Maps a failed shelf request to a message key without revealing whether a hidden resource exists. */
export function shelfErrorKey(error: unknown, action: ShelfAction): string {
	const kind = requestErrorKind(error);
	switch (kind) {
		case 'connection':
			return 'shelves.error.connection';
		case 'unauthorized':
			return 'shelves.error.session';
		case 'forbidden':
			return 'shelves.error.forbidden';
		case 'not_found':
			return action === 'add_book' || action === 'remove_book'
				? 'shelves.error.book_unavailable'
				: 'shelves.error.not_found';
		case 'conflict':
			return 'shelves.error.conflict';
		case 'invalid':
			if (action === 'more_shelves') return 'shelves.error.list_stale';
			if (action === 'more_books' || action === 'load_books') return 'shelves.error.stale';
			if (action === 'save') return 'shelves.error.invalid';
			return 'shelves.error.api';
		default:
			return 'shelves.error.api';
	}
}

export function fieldErrorKey(error: ShelfFieldError): string {
	return `shelves.form.error.${error}`;
}
