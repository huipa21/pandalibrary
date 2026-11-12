<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { addBookToShelf, getSystemShelf } from '#lib/shelves/api.js';
	import { shelfErrorKey } from '#lib/shelves/form.js';
	import Icon from '../Icon.svelte';
	import type { BookShelves } from './book-shelves.svelte.js';

	let { bookId, shelves }: { bookId: number; shelves: BookShelves } = $props();
	const favorite = $derived(shelves.items.find((shelf) => shelf.system_key === 'favorites'));
	const label = $derived(favorite ? m['bv6.favorite_remove']() : m['bv6.favorite_add']());
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');

	async function toggle() {
		if (busy || shelves.status !== 'ready') return;
		const member = favorite;
		const targetBookId = bookId;
		busy = true;
		error = '';
		notice = '';
		try {
			if (member) {
				await shelves.remove(member);
				notice = m['bd5.removed']({ shelf: m['ux3.shelves.favorites']() });
			} else {
				const shelf = await getSystemShelf('favorites');
				if (shelf.shelf_id === null) throw new Error(m['shelves.error.not_found']());
				await addBookToShelf(shelf.shelf_id, targetBookId);
				window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
				notice = m['shelves.book.added']({ name: m['ux3.shelves.favorites']() });
			}
		} catch (cause) {
			error = member && cause instanceof Error
				? cause.message
				: translate(shelfErrorKey(cause, 'add_book'));
		} finally {
			busy = false;
		}
	}
</script>

<div>
	<button
		type="button"
		class="shell-icon-button size-10 aria-pressed:text-amber-700 disabled:opacity-60"
		aria-label={label}
		title={label}
		aria-pressed={favorite !== undefined}
		aria-busy={busy}
		disabled={busy || shelves.status !== 'ready'}
		onclick={() => void toggle()}
	><Icon name="star" class={favorite ? 'size-5 [&_path]:fill-current' : 'size-5'} /></button>
	{#if error}<p class="mt-2 text-sm text-red-800" role="alert">{error}</p>{/if}
	{#if notice}<p class="sr-only" role="status">{notice}</p>{/if}
</div>
