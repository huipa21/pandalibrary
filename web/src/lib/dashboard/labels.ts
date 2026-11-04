import * as m from '#lib/paraglide/messages.js';
import type { Shelf } from '#lib/shelves/types.js';
import type { SectionId } from './layout.js';

export type ShelfState =
	| { status: 'loading' | 'unavailable' | 'error' }
	| { status: 'ready'; shelf: Shelf };

export function shelfLabel(shelf: Shelf): string {
	return shelf.system_key === 'favorites' ? m['ux3.shelves.favorites']() : shelf.name;
}

export function sectionLabel(id: SectionId, shelf?: ShelfState): string {
	switch (id) {
		case 'continue_reading': return m['ux5.section.continue_reading']();
		case 'recently_added': return m['ux5.section.recently_added']();
		case 'read': return m['ux5.section.read']();
		case 'unread': return m['ux5.section.unread']();
		case 'want_to_read': return m['ux5.section.want_to_read']();
		default:
			if (shelf?.status === 'ready') return shelfLabel(shelf.shelf);
			if (shelf?.status === 'unavailable') return m['ux5.section.shelf_unavailable']();
			return m['ux5.section.shelf']();
	}
}
