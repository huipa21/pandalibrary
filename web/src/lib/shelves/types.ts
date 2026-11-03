export type ShelfKind = 'private' | 'shared';

/** SH1 shelf metadata. `visible_book_count` already applies the viewer's grants and hide list. */
export interface Shelf {
	readonly id: number;
	readonly kind: ShelfKind;
	readonly owner_id: number | null;
	readonly name: string;
	readonly description: string | null;
	readonly created_by: number | null;
	readonly visible_book_count: number;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface ShelfInput {
	readonly kind: ShelfKind;
	readonly name: string;
	readonly description: string | null;
}

/** Omitted fields are unchanged; an explicit null description clears it. */
export interface ShelfPatch {
	readonly name?: string;
	readonly description?: string | null;
}

export interface SessionViewer {
	readonly id: number;
	readonly username: string;
	readonly display_name: string;
	readonly role: string;
}
