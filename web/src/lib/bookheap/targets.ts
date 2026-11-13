import * as m from '#lib/paraglide/messages.js';
import { listAllAdminLibraries } from '#lib/admin/api.js';
import type { Library } from '#lib/admin/types.js';
import { getSessionViewer, listAllShelves } from '#lib/shelves/api.js';
import type { SessionViewer, Shelf } from '#lib/shelves/types.js';

/**
 * Assignment accepts manual additions to rule-based collections too. Private
 * targets must belong to the importing account; Favorites sorts first.
 */
export function writableCollections(shelves: readonly Shelf[], viewer: Pick<SessionViewer, 'id'>): Shelf[] {
	const byId = new Map<number, Shelf>();
	for (const shelf of shelves) {
		if (shelf.system_key && shelf.system_key !== 'favorites') continue;
		if (shelf.kind !== 'shared' && shelf.owner_id !== viewer.id) continue;
		byId.set(shelf.id, shelf);
	}
	return [...byId.values()].sort((a, b) => {
		const favorite = Number(b.system_key === 'favorites') - Number(a.system_key === 'favorites');
		return favorite || a.name.localeCompare(b.name);
	});
}

export function shelfLabel(shelf: Shelf): string {
	return shelf.system_key === 'favorites' ? m['ux3.shelves.favorites']() : shelf.name;
}

export interface AssignTargets {
	readonly libraries: Library[];
	readonly shelves: Shelf[];
}

/** Loads every library and writable collection for the Assign dialog. */
export async function loadAssignTargets(signal?: AbortSignal): Promise<AssignTargets> {
	const [libraries, shelves, viewer] = await Promise.all([
		listAllAdminLibraries(signal),
		listAllShelves(signal),
		getSessionViewer()
	]);
	return {
		libraries: [...libraries].sort((a, b) => a.name.localeCompare(b.name)),
		shelves: writableCollections(shelves, viewer)
	};
}
