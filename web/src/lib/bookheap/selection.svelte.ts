import { SvelteMap } from 'svelte/reactivity';
import { MAX_BULK_IDS } from './api.js';
import type { HeapItem, HeapItemStatus } from './types.js';

export const MAX_SELECTION = MAX_BULK_IDS;

export type PageSelectionState = 'none' | 'some' | 'all';

/**
 * Selected heap items keyed by ID. The latest known snapshot of each item is kept so the bulk
 * actions can count assignable items even when the item is no longer in the loaded list.
 */
export class HeapSelection {
	readonly #items = new SvelteMap<number, HeapItem>();
	readonly max: number;

	constructor(max = MAX_SELECTION) {
		this.max = max;
	}

	get size(): number {
		return this.#items.size;
	}

	get full(): boolean {
		return this.#items.size >= this.max;
	}

	get ids(): number[] {
		return [...this.#items.keys()];
	}

	get items(): HeapItem[] {
		return [...this.#items.values()];
	}

	has(id: number): boolean {
		return this.#items.has(id);
	}

	/** Returns false when the item could not be selected because the selection is full. */
	toggle(item: HeapItem): boolean {
		if (this.#items.has(item.id)) {
			this.#items.delete(item.id);
			return true;
		}
		if (this.full) return false;
		this.#items.set(item.id, item);
		return true;
	}

	pageState(items: readonly HeapItem[]): PageSelectionState {
		if (items.length === 0) return 'none';
		const selected = items.filter((item) => this.#items.has(item.id)).length;
		if (selected === 0) return 'none';
		return selected === items.length ? 'all' : 'some';
	}

	/**
	 * Clears the shown items when all of them are selected, otherwise selects the unselected ones up
	 * to the cap. Returns how many items could not be selected because of the cap.
	 */
	togglePage(items: readonly HeapItem[]): number {
		if (this.pageState(items) === 'all') {
			for (const item of items) this.#items.delete(item.id);
			return 0;
		}
		let refused = 0;
		for (const item of items) {
			if (this.#items.has(item.id)) continue;
			if (this.full) refused += 1;
			else this.#items.set(item.id, item);
		}
		return refused;
	}

	remove(ids: Iterable<number>): void {
		for (const id of ids) this.#items.delete(id);
	}

	clear(): void {
		this.#items.clear();
	}

	/**
	 * Refreshes snapshots from a reloaded list. When `complete` (the reload reached the end of the
	 * filtered list), selected items that are no longer listed are dropped because they are gone.
	 */
	sync(items: readonly HeapItem[], complete: boolean): void {
		const listed = new Map(items.map((item) => [item.id, item]));
		for (const id of [...this.#items.keys()]) {
			const fresh = listed.get(id);
			if (fresh) this.#items.set(id, fresh);
			else if (complete) this.#items.delete(id);
		}
	}
}

const ASSIGNABLE: readonly HeapItemStatus[] = ['ready', 'failed'];
const ACTIVE: readonly HeapItemStatus[] = ['queued', 'importing'];

export function isAssignable(item: Pick<HeapItem, 'status'>): boolean {
	return ASSIGNABLE.includes(item.status);
}

export function isActive(item: Pick<HeapItem, 'status'>): boolean {
	return ACTIVE.includes(item.status);
}

export interface AssignablePartition {
	readonly assignable: HeapItem[];
	readonly skipped: HeapItem[];
}

/** Only `ready` and `failed` items are sent to the assign endpoint; the rest are skipped. */
export function partitionAssignable(items: readonly HeapItem[]): AssignablePartition {
	const assignable: HeapItem[] = [];
	const skipped: HeapItem[] = [];
	for (const item of items) (isAssignable(item) ? assignable : skipped).push(item);
	return { assignable, skipped };
}
