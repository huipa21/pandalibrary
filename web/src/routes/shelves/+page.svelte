<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { translate } from '#lib/paging/translate.js';
	import { listShelves } from '#lib/shelves/api.js';
	import { shelfErrorKey } from '#lib/shelves/form.js';
	import type { Shelf } from '#lib/shelves/types.js';

	const pager = new CursorPager<Shelf>();
	let created = $state<Shelf | null>(null);

	onMount(() => {
		void pager.reset((cursor, signal) => listShelves({ cursor, signal }));
		const refresh = (event: Event) => {
			const detail = event instanceof CustomEvent ? event.detail as { createdShelf?: Shelf } | null : null;
			created = detail?.createdShelf ?? null;
			void pager.reload();
		};
		window.addEventListener('pandalibrary-shelves-changed', refresh);
		return () => {
			window.removeEventListener('pandalibrary-shelves-changed', refresh);
			pager.dispose();
		};
	});

	function kindLabel(shelf: Shelf): string {
		return shelf.kind === 'shared' ? m['shelves.kind.shared']() : m['shelves.kind.private']();
	}
</script>

<svelte:head>
	<title>{m['shelves.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-10" aria-labelledby="shelves-heading">
	<h1 id="shelves-heading" class="sr-only">{m['shelves.title']()}</h1>

	{#if created}
		<p class="text-sm text-green-700" role="status">
			{m['shelves.create.success']()}
			<a class="ml-1 font-medium underline underline-offset-4 focus-visible:outline-2" href={`/shelves/${created.id}`}>{created.name}</a>
		</p>
	{/if}

	<section class="space-y-4" aria-labelledby="shelf-list-heading" aria-busy={pager.status === 'loading'}>
		<h2 id="shelf-list-heading" class="text-xl font-semibold">{m['shelves.list_heading']()}</h2>
		{#if pager.status === 'error'}
			<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
				<p>{translate(shelfErrorKey(pager.error, 'load'))}</p>
				<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.retry()}>{m['shelves.retry']()}</button>
			</div>
		{:else if pager.status !== 'ready'}
			<p class="text-slate-600" role="status">{m['shelves.loading']()}</p>
		{:else if pager.empty}
			<div class="card space-y-2 p-6 text-slate-600">
				<p>{m['shelves.empty']()}</p>
				<p>{m['ux1.shelves.create_help']()}</p>
			</div>
		{:else}
			<ul class="grid gap-3 sm:grid-cols-2">
				{#each pager.items as shelf (shelf.id)}
					<li class="space-y-2 card p-4">
						<div class="flex flex-wrap items-start justify-between gap-2">
							<h3 class="min-w-0 font-semibold break-words">
								<a class="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" href={`/shelves/${shelf.id}`}>{shelf.name}</a>
							</h3>
							<span class="rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-600">{kindLabel(shelf)}</span>
						</div>
						{#if shelf.description}
							<p class="line-clamp-3 text-sm whitespace-pre-wrap text-slate-600">{shelf.description}</p>
						{/if}
						<p class="text-sm text-slate-500">{m['shelves.book_count']({ count: shelf.visible_book_count })}</p>
					</li>
				{/each}
			</ul>
			{#if pager.moreError}
				<div class="flex flex-wrap items-center gap-3 text-red-800" role="alert">
					<p>{translate(shelfErrorKey(pager.moreError, 'more_shelves'))}</p>
					{#if requestErrorKind(pager.moreError) === 'invalid'}
						<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.reload()}>{m['shelves.books.restart']()}</button>
					{:else}
						<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.loadMore()}>{m['shelves.retry']()}</button>
					{/if}
				</div>
			{/if}
			{#if pager.hasMore}
				<button
					class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
					disabled={pager.loadingMore}
					onclick={() => pager.loadMore()}
				>{pager.loadingMore ? m['shelves.loading_more']() : m['shelves.load_more']()}</button>
			{:else}
				<p class="text-center text-sm text-slate-500" role="status">{m['shelves.end']()}</p>
			{/if}
		{/if}
	</section>
</section>
