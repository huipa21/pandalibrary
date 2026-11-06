import { describe, expect, it } from 'vitest';
import { HeapSelection, MAX_SELECTION, isActive, isAssignable, partitionAssignable } from './selection.svelte.js';
import { heapItem } from './test-fixtures.js';

describe('HeapSelection', () => {
	it('caps the selection at 500 IDs', () => {
		expect(MAX_SELECTION).toBe(500);
	});

	it('toggles single items and refuses new ones when full', () => {
		const selection = new HeapSelection(2);
		expect(selection.toggle(heapItem(1))).toBe(true);
		expect(selection.toggle(heapItem(2))).toBe(true);
		expect(selection.full).toBe(true);
		expect(selection.toggle(heapItem(3))).toBe(false);
		expect(selection.ids).toEqual([1, 2]);
		expect(selection.toggle(heapItem(1))).toBe(true);
		expect(selection.has(1)).toBe(false);
	});

	it('selects and clears the shown page and reports what the cap refused', () => {
		const selection = new HeapSelection(3);
		const page = [heapItem(1), heapItem(2), heapItem(3), heapItem(4)];
		expect(selection.pageState(page)).toBe('none');
		selection.toggle(page[0]);
		expect(selection.pageState(page)).toBe('some');
		expect(selection.togglePage(page)).toBe(1);
		expect(selection.ids).toEqual([1, 2, 3]);
		expect(selection.pageState(page.slice(0, 3))).toBe('all');
		expect(selection.togglePage(page.slice(0, 3))).toBe(0);
		expect(selection.size).toBe(0);
		expect(selection.pageState([])).toBe('none');
	});

	it('keeps selections across pages and syncs snapshots after reloads', () => {
		const selection = new HeapSelection();
		selection.togglePage([heapItem(1), heapItem(2)]);
		selection.togglePage([heapItem(3)]);
		expect(selection.size).toBe(3);
		selection.sync([heapItem(1, { status: 'queued' })], false);
		expect(selection.size).toBe(3);
		expect(selection.items.find((item) => item.id === 1)?.status).toBe('queued');
		selection.sync([heapItem(1)], true);
		expect(selection.ids).toEqual([1]);
		selection.remove([1]);
		expect(selection.size).toBe(0);
	});
});

describe('assignability', () => {
	it('only sends ready and failed items to assign', () => {
		const items = (['ready', 'duplicate', 'invalid', 'queued', 'importing', 'failed'] as const).map((status, index) =>
			heapItem(index + 1, { status })
		);
		const { assignable, skipped } = partitionAssignable(items);
		expect(assignable.map((item) => item.status)).toEqual(['ready', 'failed']);
		expect(skipped.map((item) => item.status)).toEqual(['duplicate', 'invalid', 'queued', 'importing']);
		expect(isAssignable({ status: 'failed' })).toBe(true);
		expect(isActive({ status: 'importing' })).toBe(true);
		expect(isActive({ status: 'ready' })).toBe(false);
	});
});
