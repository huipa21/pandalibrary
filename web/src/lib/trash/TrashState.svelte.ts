import { trashApi, trashKey, type TrashAction, type TrashFilter, type TrashItem, type TrashReference } from './api.js';

export class TrashState {
	items = $state<TrashItem[]>([]);
	selected = $state<string[]>([]);
	search = $state('');
	filter = $state<TrashFilter>('');
	loading = $state(false);
	busy = $state(false);
	error = $state<unknown>(null);
	actionError = $state<unknown>(null);
	#api: typeof trashApi;
	#controller: AbortController | null = null;
	#actionController: AbortController | null = null;
	#version = 0;
	#disposed = false;

	constructor(client = trashApi) {
		this.#api = client;
	}

	get selectedItems(): TrashItem[] {
		return this.items.filter((item) => this.selected.includes(trashKey(item)));
	}

	get allSelected(): boolean {
		return this.items.length > 0 && this.selectedItems.length === this.items.length;
	}

	has(item: TrashReference): boolean {
		return this.selected.includes(trashKey(item));
	}

	toggle(item: TrashReference): void {
		if (this.loading || this.busy) return;
		const key = trashKey(item);
		this.selected = this.has(item) ? this.selected.filter((value) => value !== key) : [...this.selected, key];
	}

	toggleAll(): void {
		if (this.loading || this.busy) return;
		this.selected = this.allSelected ? [] : this.items.map(trashKey);
	}

	async load(search = this.search, filter = this.filter): Promise<void> {
		if (this.busy || this.#disposed) return;
		this.#controller?.abort();
		const controller = new AbortController();
		this.#controller = controller;
		const version = ++this.#version;
		this.search = search.trim();
		this.filter = filter;
		this.items = [];
		this.selected = [];
		this.error = null;
		this.loading = true;
		try {
			const items = await this.#api.list(this.search, filter, controller.signal);
			if (version === this.#version && !this.#disposed) this.items = items;
		} catch (error) {
			if (version === this.#version && !controller.signal.aborted) this.error = error;
		} finally {
			if (version === this.#version) this.loading = false;
		}
	}

	async act(action: TrashAction, items: readonly TrashReference[]): Promise<boolean> {
		if (this.busy || this.loading || this.#disposed || items.length === 0) return false;
		const targets = [...new Map(items.map((item) => [trashKey(item), item])).values()];
		this.actionError = null;
		this.busy = true;
		const controller = new AbortController();
		this.#actionController = controller;
		try {
			await this.#api.act(action, targets, controller.signal);
			if (this.#disposed) return false;
			const removed = new Set(targets.map(trashKey));
			this.items = this.items.filter((item) => !removed.has(trashKey(item)));
			this.selected = this.selected.filter((key) => !removed.has(key));
			this.busy = false;
			// Refresh dependent items too: restoring a book can also restore its annotations.
			await this.load();
			return true;
		} catch (error) {
			if (!controller.signal.aborted) this.actionError = error;
			return false;
		} finally {
			this.busy = false;
			this.#actionController = null;
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#version++;
		this.#controller?.abort();
		this.#actionController?.abort();
	}
}
