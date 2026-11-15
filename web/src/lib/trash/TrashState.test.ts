import { describe, expect, it, vi } from 'vitest';
import { TrashState } from './TrashState.svelte.js';
import { trashKey, type TrashItem } from './api.js';

const items: TrashItem[] = [
	{ id: '1', type: 'book', title: 'Book', deletedAt: '2026-11-15T00:00:00Z' },
	{ id: '1', type: 'wordbook', title: 'Wordbook', deletedAt: '2026-11-15T00:00:00Z' },
	{ id: 'highlight:1', type: 'annotation', title: 'Quote', deletedAt: '2026-11-15T00:00:00Z' }
];

function setup() {
	const client = { list: vi.fn().mockResolvedValue(items), act: vi.fn().mockResolvedValue(undefined) };
	return { state: new TrashState(client), client };
}

describe('Trash selection and actions', () => {
	it('distinguishes equal IDs in different types and toggles all visible results', async () => {
		const { state } = setup();
		await state.load();
		state.toggle(items[0]);
		expect(state.has(items[1])).toBe(false);
		expect(state.selectedItems).toEqual([items[0]]);
		expect(state.allSelected).toBe(false);
		state.toggleAll();
		expect(state.selectedItems).toEqual(items);
		expect(state.allSelected).toBe(true);
		state.toggle(items[0]);
		expect(state.selectedItems).toEqual(items.slice(1));
		state.toggleAll();
		state.toggleAll();
		expect(state.selected).toEqual([]);
	});

	it('clears selection on searches and filters, and ignores stale results', async () => {
		const { state, client } = setup();
		await state.load();
		state.toggleAll();
		let resolveOld!: (value: TrashItem[]) => void;
		client.list.mockImplementationOnce(() => new Promise<TrashItem[]>((resolve) => { resolveOld = resolve; }));
		const old = state.load(' older ', 'book');
		const oldSignal = client.list.mock.calls[1][2] as AbortSignal;
		client.list.mockResolvedValueOnce([items[1]]);
		await state.load(' words ', 'wordbook');
		resolveOld([items[0]]);
		await old;
		expect(oldSignal.aborted).toBe(true);
		expect(state.search).toBe('words');
		expect(state.filter).toBe('wordbook');
		expect(state.selected).toEqual([]);
		expect(state.items).toEqual([items[1]]);
		expect(client.list).toHaveBeenLastCalledWith('words', 'wordbook', expect.any(AbortSignal));
	});

	it('restores one item without accidentally restoring another selected item', async () => {
		const { state, client } = setup();
		await state.load();
		state.toggleAll();
		client.list.mockResolvedValueOnce(items.slice(1));
		await expect(state.act('restore', [items[0]])).resolves.toBe(true);
		expect(client.act).toHaveBeenCalledWith('restore', [items[0]], expect.any(AbortSignal));
		expect(state.items).toEqual(items.slice(1));
		expect(state.selected).toEqual([]);
	});

	it('keeps selections and surfaces action failures, then supports retrying a group delete', async () => {
		const { state, client } = setup();
		await state.load();
		state.toggleAll();
		const failure = new Error('Conflict');
		client.act.mockRejectedValueOnce(failure);
		await expect(state.act('delete', state.selectedItems)).resolves.toBe(false);
		expect(state.actionError).toBe(failure);
		expect(state.items).toEqual(items);
		expect(state.selected).toEqual(items.map(trashKey));
		expect(state.busy).toBe(false);
		client.list.mockResolvedValueOnce([]);
		await expect(state.act('delete', state.selectedItems)).resolves.toBe(true);
		expect(client.act).toHaveBeenLastCalledWith('delete', items, expect.any(AbortSignal));
		expect(state.actionError).toBeNull();
		expect(state.items).toEqual([]);
		expect(state.selectedItems).toEqual([]);
	});

	it('prevents repeated actions and selection changes while an action is pending', async () => {
		const { state, client } = setup();
		await state.load();
		state.toggle(items[0]);
		let finish!: () => void;
		client.act.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
		const pending = state.act('restore', state.selectedItems);
		state.toggle(items[1]);
		state.toggleAll();
		await expect(state.act('restore', [items[0]])).resolves.toBe(false);
		expect(state.selectedItems).toEqual([items[0]]);
		expect(client.act).toHaveBeenCalledOnce();
		finish();
		await pending;
	});

	it('shows list errors and cancels a pending load when disposed', async () => {
		const { state, client } = setup();
		const failure = new Error('Offline');
		client.list.mockRejectedValueOnce(failure);
		await state.load();
		expect(state.error).toBe(failure);
		expect(state.loading).toBe(false);
		let finish!: (value: TrashItem[]) => void;
		client.list.mockImplementationOnce(() => new Promise<TrashItem[]>((resolve) => { finish = resolve; }));
		const pending = state.load();
		const signal = client.list.mock.calls[1][2] as AbortSignal;
		state.dispose();
		finish(items);
		await pending;
		expect(signal.aborted).toBe(true);
		expect(state.items).toEqual([]);
	});
});
