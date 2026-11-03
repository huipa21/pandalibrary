<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';
	import { listShelves } from './api.js';
	import { shelfErrorKey } from './form.js';
	import type { Shelf } from './types.js';

	/**
	 * The library book endpoint has no shelf filter, so shelves are offered as links to their
	 * own pages instead of filtering a page of library books on the client.
	 */
	const pager = new CursorPager<Shelf>();

	onMount(() => void pager.reset((cursor, signal) => listShelves({ cursor, signal })));
	onDestroy(() => pager.dispose());
</script>

<nav class="space-y-3 rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="library-shelves-heading">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="library-shelves-heading" class="font-semibold">{m['shelves.library.heading']()}</h2>
		<a class="text-sm underline underline-offset-4 focus-visible:outline-2" href="/shelves">{m['shelves.library.all']()}</a>
	</div>
	<p class="text-sm text-slate-600">{m['shelves.library.note']()}</p>
	{#if pager.status === 'error'}
		<div class="flex flex-wrap items-center gap-3 text-sm text-red-800" role="alert">
			<p>{translate(shelfErrorKey(pager.error, 'load'))}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.retry()}>{m['shelves.retry']()}</button>
		</div>
	{:else if pager.status !== 'ready'}
		<p class="text-sm text-slate-600" role="status">{m['shelves.loading']()}</p>
	{:else if pager.empty}
		<p class="text-sm text-slate-600">{m['shelves.library.empty']()}</p>
	{:else}
		<ul class="flex flex-wrap gap-2">
			{#each pager.items as shelf (shelf.id)}
				<li>
					<a
						class="inline-block rounded-full border border-slate-300 px-3 py-1 text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
						href={`/shelves/${shelf.id}`}
					>{shelf.name} <span class="text-slate-500">({shelf.visible_book_count})</span></a>
				</li>
			{/each}
			{#if pager.hasMore}
				<li>
					<button
						class="rounded-full border border-dashed border-slate-300 px-3 py-1 text-sm focus-visible:outline-2 disabled:opacity-60"
						disabled={pager.loadingMore}
						onclick={() => pager.loadMore()}
					>{pager.loadingMore ? m['shelves.loading_more']() : m['shelves.load_more']()}</button>
				</li>
			{/if}
		</ul>
		{#if pager.moreError}
			<div class="flex flex-wrap items-center gap-3 text-sm text-red-800" role="alert">
				<p>{translate(shelfErrorKey(pager.moreError, 'more_shelves'))}</p>
				<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.reload()}>{m['shelves.books.restart']()}</button>
			</div>
		{/if}
	{/if}
</nav>
