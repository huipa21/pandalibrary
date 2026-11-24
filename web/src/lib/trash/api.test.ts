import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trashApi, type TrashItem } from './api.js';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('#lib/api/client.js', () => ({ api: { request } }));

beforeEach(() => request.mockReset());

describe('Trash API', () => {
	it('loads all types or encodes a type filter and trimmed search', async () => {
		request.mockResolvedValue({ items: [] });
		await expect(trashApi.list()).resolves.toEqual([]);
		expect(request).toHaveBeenLastCalledWith('/trash', { signal: undefined, cache: 'no-store' });
		for (const type of ['book', 'file', 'wordbook', 'annotation'] as const) {
			const controller = new AbortController();
			await trashApi.list('  a & b  ', type, controller.signal);
			expect(request).toHaveBeenLastCalledWith(`/trash?type=${type}&search=a+%26+b`, {
				signal: controller.signal, cache: 'no-store'
			});
		}
	});

	it('sends opaque, typed IDs without display fields for individual and group actions', async () => {
		request.mockResolvedValue(undefined);
		const book: TrashItem = { id: '8', type: 'book', title: 'Book', deletedAt: '2026-11-15T00:00:00Z' };
		const annotation: TrashItem = { ...book, type: 'annotation', id: 'highlight:a/b' };
		await trashApi.act('restore', [book]);
		expect(request).toHaveBeenLastCalledWith('/trash/restore', {
			method: 'POST', body: { items: [{ id: '8', type: 'book' }] }, signal: undefined
		});
		await trashApi.act('delete', [book, annotation]);
		expect(request).toHaveBeenLastCalledWith('/trash', {
			method: 'DELETE', body: { items: [{ id: '8', type: 'book' }, { id: 'highlight:a/b', type: 'annotation' }] },
			signal: undefined
		});
	});
});
