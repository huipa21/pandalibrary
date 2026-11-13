import { describe, expect, it } from 'vitest';
import type { Shelf } from '#lib/shelves/types.js';
import { writableCollections } from './targets.js';

function shelf(id: number, overrides: Partial<Shelf> = {}): Shelf {
	return {
		id,
		kind: 'shared',
		owner_id: null,
		name: `Shelf ${id}`,
		description: null,
		created_by: 1,
		visible_book_count: 0,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		...overrides
	};
}

describe('writableCollections', () => {
	it('accepts rule collections while keeping ownership and system restrictions', () => {
		const shelves = [
			shelf(1, { name: 'Zebra' }),
			shelf(2, { name: 'Alpha', kind: 'private', owner_id: 1 }),
			shelf(3, { name: 'Theirs', kind: 'private', owner_id: 2 }),
			shelf(4, { name: 'Smart', mode: 'automatic' }),
			shelf(5, { name: 'Unshelved', kind: 'private', owner_id: 1, system_key: 'unshelved' }),
			shelf(6, { name: 'Favorites', kind: 'private', owner_id: 1, system_key: 'favorites' }),
			shelf(1, { name: 'Zebra' })
		];
		expect(writableCollections(shelves, { id: 1 }).map((entry) => entry.id)).toEqual([6, 2, 4, 1]);
	});
});
