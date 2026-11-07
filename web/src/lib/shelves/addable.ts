import { getSessionViewer, listAllShelves } from './api.js';
import { offersShelfManagement } from './form.js';
import type { SessionViewer, Shelf } from './types.js';

/** Manual shelves the viewer is offered to add a book to; the server still authorizes each add. */
export function addableShelves(shelves: readonly Shelf[], viewer: SessionViewer | null): Shelf[] {
	return shelves.filter((shelf) =>
		offersShelfManagement(shelf, viewer) && shelf.mode !== 'automatic' && shelf.system_key !== 'unshelved'
	);
}

export async function loadAddableShelves(signal?: AbortSignal): Promise<Shelf[]> {
	const [all, viewer] = await Promise.all([listAllShelves(signal), getSessionViewer()]);
	return addableShelves(all, viewer);
}
