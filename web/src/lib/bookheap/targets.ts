import * as m from '#lib/paraglide/messages.js';
import { listAllAdminLibraries } from '#lib/admin/api.js';
import type { Library } from '#lib/admin/types.js';
import { getSessionViewer, listAllShelves } from '#lib/shelves/api.js';
import type { SessionViewer, Shelf } from '#lib/shelves/types.js';

/**
 * Shelves an administrator can target when assigning heap items: Favorites and custom manual
 * shelves they can write (shared shelves, or private shelves they own). Automatic shelves and
 * Unshelved are excluded. Favorites comes first, then the rest by name.
 */
export function writableManualShelves(shelves: readonly Shelf[], viewer: Pick<SessionViewer, 'id'>): Shelf[] {
	const byId = new Map<number, Shelf>();
	for (const shelf of shelves) {
		if (shelf.mode === 'automatic' || shelf.rules) continue;
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

/** Loads every library and the writable manual shelves for the Assign dialog. */
export async function loadAssignTargets(signal?: AbortSignal): Promise<AssignTargets> {
	const [libraries, shelves, viewer] = await Promise.all([
		listAllAdminLibraries(signal),
		listAllShelves(signal),
		getSessionViewer()
	]);
	return {
		libraries: [...libraries].sort((a, b) => a.name.localeCompare(b.name)),
		shelves: writableManualShelves(shelves, viewer)
	};
}
