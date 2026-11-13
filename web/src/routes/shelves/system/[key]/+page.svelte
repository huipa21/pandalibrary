<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';
	import { collectionLibraryID, getSystemShelf, listSystemShelfBooks } from '#lib/shelves/api.js';
	import { shelfErrorKey } from '#lib/shelves/form.js';
	import ShelfDescription from '#lib/shelves/ShelfDescription.svelte';
	import BookCard from '#lib/catalog/BookCard.svelte';
	import BookDisplaySettings from '#lib/catalog/BookDisplaySettings.svelte';
	import { rememberBrowseContext } from '#lib/bookview/browse-context.js';
	import type { SystemShelf } from '#lib/shelves/types.js';
	import type { Book } from '#lib/catalog/types.js';
	import { libraryHref } from '#lib/libraries/context.js';

	const pager = new CursorPager<Book>();
	let shelf = $state<SystemShelf | null>(null);
	let error = $state('');
	let coverSize = $state(208);
	let spacing = $state(20);
	let requestVersion = 0;
	let libraryID = $state<number | undefined>(undefined);
	let metadataController: AbortController | null = null;

	const key = $derived(page.params.key as string);

	$effect(() => {
		const current = key;
		const url = page.url;
		untrack(() => void loadShelf(current, collectionLibraryID(url)));
	});

	onDestroy(() => {
		requestVersion += 1;
		metadataController?.abort();
		pager.dispose();
	});

	$effect(() => { if (shelf && pager.status === 'ready') rememberBrowseContext({ ids: pager.items.map((book) => book.id), label: systemShelfTitle(key), href: libraryHref(`/shelves/system/${encodeURIComponent(key)}`, libraryID) }); });

	async function loadShelf(current: string, scope: number | undefined | null) {
		const version = ++requestVersion;
		metadataController?.abort();
		metadataController = new AbortController();
		const signal = metadataController.signal;
		libraryID = scope ?? undefined;
		error = '';
		shelf = null;
		void pager.reset(null);
		if (scope === null) {
			error = m['shelves.error.invalid']();
			return;
		}
		try {
			const loaded = await getSystemShelf(current, { library_id: scope, signal });
			if (version !== requestVersion) return;
			shelf = loaded;
			await pager.reset((cursor, signal) => listSystemShelfBooks(current, { cursor, signal, library_id: scope }));
		} catch (cause) {
			if (version !== requestVersion) return;
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
			<button class="mt-2 underline underline-offset-4 focus-visible:outline-2" onclick={() => void loadShelf(key, collectionLibraryID(page.url))}>{m['shelves.retry']()}</button>
		</div>
	{:else if !shelf}
		<p class="text-slate-600" role="status">{m['shelves.loading']()}</p>
	{:else}
		<header class="space-y-2">
			<h1 class="sr-only">{systemShelfTitle(key)}</h1>
			<p class="text-sm text-slate-500">{m['shelves.book_count']({ count: shelf.visible_book_count })}</p>
			{#if shelf.description}<ShelfDescription description={shelf.description} />{/if}
			<BookDisplaySettings storageKey={`system-collection:${key}`} bind:size={coverSize} bind:spacing />
		</header>

		{#if pager.status === 'error'}
			<div class="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
				<p>{translate(shelfErrorKey(pager.error, 'load'))}</p>
				<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.retry()}>{m['shelves.retry']()}</button>
			</div>
		{:else if pager.status !== 'ready'}
			<p class="text-slate-600" role="status">{m['shelves.loading']()}</p>
		{:else if pager.empty}
			<p class="card p-6 text-slate-600">{m['shelves.empty']()}</p>
		{:else}
			<ul class="book-grid book-grid-configurable" style={`--book-cover-size: ${coverSize}px; --book-cover-spacing: ${spacing}px`}>
				{#each pager.items as book (book.id)}
					<BookCard {book} />
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
