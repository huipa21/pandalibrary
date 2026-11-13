import { untrack } from 'svelte';
import { getBookShelves } from '#lib/catalog/api.js';
import { translate } from '#lib/paging/translate.js';
import { getSessionViewer, removeBookFromShelf } from '#lib/shelves/api.js';
import { offersShelfManagement, shelfErrorKey } from '#lib/shelves/form.js';
import type { SessionViewer, Shelf } from '#lib/shelves/types.js';

const SHELVES_CHANGED = 'pandalibrary-shelves-changed';

function sorted(items: readonly Shelf[]): Shelf[] {
	return [...items].sort((a, b) =>
		Number(b.system_key === 'favorites') - Number(a.system_key === 'favorites') ||
		a.name.localeCompare(b.name) || a.id - b.id);
}

export class BookShelves {
	items = $state<Shelf[]>([]);
	status = $state<'loading' | 'ready' | 'error'>('loading');
	error = $state('');
	get memberIds(): number[] { return this.items.map((shelf) => shelf.id); }
	#viewer = $state<SessionViewer | null>(null);
	#viewerRequest: Promise<SessionViewer> | null = null;
	#controller: AbortController | null = null;
	#bookId: number | null = null;
	#generation = 0;
	#revision = 0;
	#pending = new Set<number>();
	#ownEvents = new WeakSet<Event>();

	constructor(private getBookId: () => number | null) {}

	canRemove(shelf: Shelf): boolean {
		return offersShelfManagement(shelf, this.#viewer) &&
			shelf.system_key !== 'unshelved';
	}

	reload(): void {
		const bookId = this.getBookId();
		this.#controller?.abort();
		if (bookId !== this.#bookId) {
			this.#generation += 1;
			this.#bookId = bookId;
			this.items = [];
			this.#pending.clear();
		}
		this.error = '';
		if (bookId === null) {
			this.status = 'ready';
			return;
		}
		const controller = new AbortController();
		this.#controller = controller;
		this.status = 'loading';
		void this.#load(bookId, controller);
	}

	async #load(bookId: number, controller: AbortController): Promise<void> {
		const revision = this.#revision;
		this.#viewerRequest ??= getSessionViewer().catch((cause) => {
			this.#viewerRequest = null;
			throw cause;
		});
		try {
			const [items, viewer] = await Promise.all([
				getBookShelves(bookId, controller.signal), this.#viewerRequest
			]);
			if (controller.signal.aborted) return;
			if (revision !== this.#revision) {
				this.reload();
				return;
			}
			this.#viewer = viewer;
			this.items = sorted(items.filter((shelf) => !this.#pending.has(shelf.id)));
			this.status = 'ready';
		} catch (cause) {
			if (controller.signal.aborted) return;
			this.error = translate(shelfErrorKey(cause, 'load'));
			this.status = 'error';
		}
	}

	async remove(shelf: Shelf): Promise<void> {
		if (!this.canRemove(shelf) || this.#bookId === null ||
			!this.memberIds.includes(shelf.id) || this.#pending.has(shelf.id)) {
			throw new Error(translate('shelves.error.forbidden'));
		}
		const bookId = this.#bookId;
		const generation = this.#generation;
		this.#pending.add(shelf.id);
		this.items = this.items.filter((item) => item.id !== shelf.id);
		try {
			await removeBookFromShelf(shelf.id, bookId);
		} catch (cause) {
			if (generation === this.#generation) {
				this.items = sorted([...this.items.filter((item) => item.id !== shelf.id), shelf]);
			}
			throw new Error(translate(shelfErrorKey(cause, 'remove_book')), { cause });
		} finally {
			if (generation === this.#generation) {
				this.#pending.delete(shelf.id);
				this.#revision += 1;
			}
		}
		const event = new CustomEvent(SHELVES_CHANGED);
		this.#ownEvents.add(event);
		window.dispatchEvent(event);
		if (generation === this.#generation && (shelf.mode === 'automatic' || shelf.rule_groups?.length)) this.reload();
	}

	listen(target: Window = window): () => void {
		const changed = (event: Event) => {
			if (!this.#ownEvents.has(event)) this.reload();
		};
		target.addEventListener(SHELVES_CHANGED, changed);
		return () => target.removeEventListener(SHELVES_CHANGED, changed);
	}

	destroy(): void {
		this.#controller?.abort();
		this.#generation += 1;
		this.#pending.clear();
	}
}

export function createBookShelves(getBookId: () => number | null): BookShelves {
	const shelves = new BookShelves(getBookId);
	$effect(() => {
		getBookId();
		untrack(() => shelves.reload());
		return () => shelves.destroy();
	});
	$effect(() => shelves.listen());
	return shelves;
}
