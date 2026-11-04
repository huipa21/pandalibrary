<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';
	import { getSystemShelf, listSystemShelfBooks } from '#lib/shelves/api.js';
	import { shelfErrorKey } from '#lib/shelves/form.js';
	import BookCard from '#lib/catalog/BookCard.svelte';
	import type { Shelf } from '#lib/shelves/types.js';
	import type { Book } from '#lib/catalog/types.js';

	const pager = new CursorPager<Book>();
	let shelf = $state<Shelf | null>(null);
	let error = $state('');

	const key = $derived(page.params.key as string);

	onMount(() => {
		void loadShelf();
	});

	onDestroy(() => pager.dispose());

	async function loadShelf() {
		try {
			shelf = await getSystemShelf(key);
			await pager.reset((cursor, signal) => listSystemShelfBooks(key, { cursor, signal }));
		} catch (cause) {
			error = translate(shelfErrorKey(cause, 'load'));
			console.error('Failed to load system shelf:', cause);
		}
	}

	const systemShelfTitle = (key: string) => {
		return key === 'unshelved' ? m['ux3.shelves.unshelved']() : key === 'favorites' ? m['ux3.shelves.favorites']() : key;
	};
</script>

<svelte:head>
	<title>{shelf ? systemShelfTitle(key) : m['shelves.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<div class="space-y-6">
	{#if error}
		<div class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
			<p>{error}</p>
			<button class="mt-2 underline underline-offset-4 focus-visible:outline-2" onclick={() => void loadShelf()}>{m['shelves.retry']()}</button>
		</div>
	{:else if !shelf}
		<p class="text-slate-600" role="status">{m['shelves.loading']()}</p>
	{:else}
		<header class="space-y-2">
			<h1 class="text-3xl font-semibold tracking-tight">{systemShelfTitle(key)}</h1>
			{#if shelf.description}
				<p class="whitespace-pre-wrap text-slate-600">{shelf.description}</p>
			{/if}
			<p class="text-sm text-slate-500">{m['shelves.book_count']({ count: shelf.visible_book_count })}</p>
		</header>

		{#if pager.status === 'error'}
			<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
				<p>{translate(shelfErrorKey(pager.error, 'load'))}</p>
				<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.retry()}>{m['shelves.retry']()}</button>
			</div>
		{:else if pager.status !== 'ready'}
			<p class="text-slate-600" role="status">{m['shelves.loading']()}</p>
		{:else if pager.empty}
			<p class="rounded-md border border-slate-200 bg-white p-6 text-slate-600">{m['shelves.empty']()}</p>
		{:else}
			<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each pager.items as book (book.id)}
					<li>
						<BookCard {book} />
					</li>
				{/each}
			</ul>
			{#if pager.hasMore}
				<div class="flex justify-center pt-4">
					<button
						class="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50"
						disabled={pager.loadingMore}
						onclick={() => pager.loadMore()}
					>
						{pager.loadingMore ? m['shelves.loading_more']() : m['shelves.load_more']()}
					</button>
				</div>
			{/if}
			{#if pager.moreError}
				<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
					<p>{translate(shelfErrorKey(pager.moreError, 'more_books'))}</p>
					<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.reload()}>{m['shelves.retry']()}</button>
				</div>
			{/if}
		{/if}
	{/if}
</div>
