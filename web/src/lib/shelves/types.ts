export type ShelfKind = 'private' | 'shared';
export type ShelfMode = 'manual' | 'automatic';

export interface SystemShelf {
	readonly key: 'favorites' | 'unshelved';
	readonly name: string;
	readonly mode: ShelfMode;
	readonly visible_book_count: number;
	readonly shelf_id: number | null;
	readonly description?: string | null;
}

export interface RuleCondition {
	field: string;
	op: string;
	value: string | number;
	not?: boolean;
}

export interface RuleSet {
	match: 'all' | 'any';
	conditions: RuleCondition[];
}

export interface RuleGroup {
	id: string;
	name: string;
	rules: RuleSet;
}

/** SH1/UX2 shelf metadata. `visible_book_count` already applies the viewer's grants and hide list. */
export interface Shelf {
	readonly id: number;
	readonly icon?: string | null;
	readonly kind: ShelfKind;
	readonly owner_id: number | null;
	readonly name: string;
	readonly description: string | null;
	readonly created_by: number | null;
	readonly visible_book_count: number;
	readonly created_at: string;
	readonly updated_at: string;
	readonly mode?: ShelfMode;
	readonly system_key?: string | null;
	readonly rules?: RuleSet | null;
	readonly rule_groups?: RuleGroup[];
}

export interface ShelfInput {
	readonly icon?: string;
	readonly kind: ShelfKind;
	readonly name: string;
	readonly description: string | null;
	readonly mode?: ShelfMode;
	readonly rules?: RuleSet | null;
	readonly rule_groups?: RuleGroup[];
}

/** Omitted fields are unchanged; null clears the description and an empty string clears the icon. */
export interface ShelfPatch {
	readonly icon?: string;
	readonly name?: string;
	readonly description?: string | null;
	readonly rules?: RuleSet | null;
	readonly rule_groups?: RuleGroup[];
	readonly remove_rule_books?: boolean;
}

export interface SessionViewer {
	readonly id: number;
	readonly username: string;
	readonly display_name: string;
	readonly role: string;
}
