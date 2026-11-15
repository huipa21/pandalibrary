import { api } from '#lib/api/client.js';

export type TrashType = 'book' | 'wordbook' | 'annotation';
export type TrashFilter = TrashType | '';
export interface TrashReference { id: string; type: TrashType }
export interface TrashItem extends TrashReference {
	title: string;
	subtitle?: string;
	deletedAt: string;
}
export type TrashAction = 'restore' | 'delete';

export const trashApi = {
	async list(search = '', type: TrashFilter = '', signal?: AbortSignal): Promise<TrashItem[]> {
		const params = new URLSearchParams();
		if (type) params.set('type', type);
		if (search.trim()) params.set('search', search.trim());
		const query = params.toString();
		const response = await api.request<{ items: TrashItem[] }>(`/trash${query ? `?${query}` : ''}`, {
			signal, cache: 'no-store'
		});
		return response.items;
	},
	async act(action: TrashAction, items: readonly TrashReference[], signal?: AbortSignal): Promise<void> {
		await api.request<void>(action === 'restore' ? '/trash/restore' : '/trash', {
			method: action === 'restore' ? 'POST' : 'DELETE',
			body: { items: items.map(({ id, type }) => ({ id, type })) },
			signal
		});
	}
};

export function trashKey(item: TrashReference): string {
	return JSON.stringify([item.type, item.id]);
}
