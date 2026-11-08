<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { Shelf } from '#lib/shelves/types.js';
	import Icon from '../Icon.svelte';
	import type { createBookShelves } from './book-shelves.svelte.js';

	let { shelves, bookTitle, offline = false }: {
		shelves: ReturnType<typeof createBookShelves>;
		bookTitle: string;
		offline?: boolean;
	} = $props();
	const labelId = $props.id();
	let root: HTMLDivElement;
	let label: HTMLParagraphElement;
	let notice = $state('');
	let error = $state('');

	$effect(() => {
		bookTitle;
		shelves;
		notice = '';
		error = '';
	});

	function shelfName(shelf: Shelf): string {
		return shelf.system_key === 'favorites' ? m['ux3.shelves.favorites']() : shelf.name;
	}

	async function remove(shelf: Shelf) {
		const name = shelfName(shelf);
		if (offline || !window.confirm(m['bd5.remove_confirm']({ title: bookTitle, shelf: name }))) return;
		const title = bookTitle;
		const ids = shelves.memberIds;
		const index = ids.indexOf(shelf.id);
		const nextId = ids[index + 1] ?? ids[index - 1];
		notice = '';
		error = '';
		try {
			const removal = shelves.remove(shelf);
			await Promise.all([removal, tick().then(() => {
				if (title === bookTitle) {
					(root.querySelector<HTMLAnchorElement>(`[data-shelf-id="${nextId}"] a`) ?? label).focus();
				}
			})]);
			if (title === bookTitle) notice = m['bd5.removed']({ shelf: name });
		} catch (cause) {
			if (title === bookTitle) {
				error = cause instanceof Error ? cause.message : m['shelves.error.api']();
			}
		}
	}
</script>

<div bind:this={root} class="space-y-2">
	<p bind:this={label} id={labelId} tabindex="-1" class="text-xs font-semibold tracking-wide text-slate-500 uppercase focus-visible:outline-2 focus-visible:outline-emerald-700">{m['bd5.shelves']()}</p>
	{#if shelves.status === 'loading'}
		<p class="text-sm text-slate-500" role="status">{m['shelves.book.loading']()}</p>
	{:else if shelves.status === 'error'}
		<div class="space-y-1 text-sm text-red-800" role="alert">
			<p>{shelves.error}</p>
			<button type="button" class="rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-700" onclick={() => shelves.reload()}>{m['shelves.retry']()}</button>
		</div>
	{/if}
	{#if shelves.items.length}
		<ul aria-labelledby={labelId} class="flex flex-wrap gap-3">
			{#each shelves.items as shelf (shelf.id)}
				<li data-shelf-id={shelf.id} class="shelf-chip group relative inline-flex max-w-full rounded-full bg-slate-100 text-xs font-medium text-slate-700 hover:bg-slate-200">
					<a
						href={shelf.system_key === 'favorites' ? '/shelves/system/favorites' : `/shelves/${shelf.id}`}
						class="max-w-full truncate rounded-full px-3 py-1 focus-visible:outline-2 focus-visible:outline-emerald-700"
					>{shelfName(shelf)}</a>
					{#if !offline && shelves.canRemove(shelf)}
						<button
							type="button"
							aria-label={m['bd5.remove_from']({ shelf: shelfName(shelf) })}
							class="shelf-remove absolute -top-1.5 -right-1.5 inline-flex size-4 items-center justify-center rounded-full bg-white text-slate-600 opacity-0 shadow ring-1 ring-black/10 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-emerald-700"
							onclick={() => void remove(shelf)}
						><Icon name="x" class="size-3" /></button>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if shelves.status === 'ready'}
		<p class="text-sm text-slate-500">{m['bd5.none']()}</p>
	{/if}
	{#if notice}<p class="text-sm text-emerald-800" role="status">{notice}</p>{/if}
	{#if error}<p class="text-sm text-red-800" role="alert">{error}</p>{/if}
</div>

<style>
	@media (hover: none) {
		.shelf-chip .shelf-remove { opacity: 1; }
	}
</style>
