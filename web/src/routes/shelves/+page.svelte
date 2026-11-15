<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { translate } from '#lib/paging/translate.js';
	import { listShelves } from '#lib/shelves/api.js';
	import { shelfErrorKey } from '#lib/shelves/form.js';
	import type { Shelf } from '#lib/shelves/types.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import EntityManagementCover from '#lib/EntityManagementCover.svelte';
	import { entityIcon } from '#lib/navigation-icons.js';

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
</script>

<svelte:head>
	<title>{m['ux1.shelves.more']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="shelves-heading">
	<header class="flex flex-wrap items-center justify-between gap-4">
		<h1 id="shelves-heading" class="text-3xl font-semibold tracking-tight">{m['ux1.shelves.more']()}</h1>
	</header>

	{#if created}
		<p class="text-sm text-green-700" role="status">
			{m['shelves.create.success']()}
			<a class="ml-1 inline-flex items-center gap-2 font-medium underline underline-offset-4 focus-visible:outline-2" href={`/shelves/${created.id}?manage=1`}><Icon name={entityIcon(created.icon, `collection:${created.id}`)} class="size-4 shrink-0" />{created.name}</a>
		</p>
	{/if}

	<div class="space-y-4" aria-busy={pager.status === 'loading'}>
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
			<ul class="book-grid book-grid-configurable" style="--book-cover-size: 208px; --book-cover-spacing: 20px">
				{#each pager.items as shelf (shelf.id)}
					<li class="min-w-0 space-y-3">
						<EntityManagementCover
							href={`/shelves/${shelf.id}?manage=1`}
							name={shelf.name}
							icon={entityIcon(shelf.icon, `collection:${shelf.id}`)}
						/>
						<div class="min-w-0">
							<h2 class="font-semibold break-words">
								{shelf.name}
							</h2>
							<p class="text-sm text-slate-600">{m['catalog.library.book_count']({ count: shelf.visible_book_count })}</p>
						</div>
						{#if shelf.description}
							<p class="line-clamp-3 text-sm whitespace-pre-wrap text-slate-600">{shelf.description}</p>
						{/if}
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
					class="button-primary rounded-md px-4 py-2 font-medium disabled:opacity-60"
					disabled={pager.loadingMore}
					onclick={() => pager.loadMore()}
				>{pager.loadingMore ? m['shelves.loading_more']() : m['shelves.load_more']()}</button>
			{:else}
				<p class="text-center text-sm text-slate-500" role="status">{m['shelves.end']()}</p>
			{/if}
		{/if}
	</div>
</section>
