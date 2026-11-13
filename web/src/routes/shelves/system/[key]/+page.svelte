<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { translate } from '#lib/paging/translate.js';
	import { collectionLibraryID, getSystemShelf, listSystemShelfBooks } from '#lib/shelves/api.js';
	import { shelfErrorKey } from '#lib/shelves/form.js';
	import ShelfDescription from '#lib/shelves/ShelfDescription.svelte';
	import BookBrowser from '#lib/catalog/BookBrowser.svelte';
	import type { PageOptions } from '#lib/catalog/api.js';
	import type { SystemShelf } from '#lib/shelves/types.js';
	import type { BookFilters, BookSort } from '#lib/catalog/types.js';

	let shelf = $state<SystemShelf | null>(null);
	let error = $state('');
	let requestVersion = 0;
	let libraryID = $state<number | undefined>(undefined);
	let metadataController: AbortController | null = null;

	const key = $derived(page.params.key as string);
	const libraryScope = $derived(collectionLibraryID(page.url));
	const browseScope = $derived({ library_id: libraryID });
	const showingDetails = $derived(page.url.searchParams.get('manage') === '1');
	const browseHref = $derived.by(() => {
		const params = new URLSearchParams(page.url.searchParams.toString());
		params.delete('manage');
		const query = params.toString();
		return `${page.url.pathname}${query ? `?${query}` : ''}`;
	});

	$effect(() => {
		const current = key;
		const scope = libraryScope;
		untrack(() => void loadShelf(current, scope));
	});

	onDestroy(() => {
		requestVersion += 1;
		metadataController?.abort();
	});

	async function loadShelf(current: string, scope: number | undefined | null) {
		const version = ++requestVersion;
		metadataController?.abort();
		metadataController = new AbortController();
		const signal = metadataController.signal;
		libraryID = scope ?? undefined;
		error = '';
		shelf = null;
		if (scope === null) {
			error = m['shelves.error.invalid']();
			return;
		}
		try {
			const loaded = await getSystemShelf(current, { library_id: scope, signal });
			if (version !== requestVersion) return;
			shelf = loaded;
		} catch (cause) {
			if (version !== requestVersion) return;
			error = translate(shelfErrorKey(cause, 'load'));
			console.error('Failed to load system shelf:', cause);
		}
	}

	function fetchBooks(filters: BookFilters, sort: BookSort, options: PageOptions = {}) {
		return listSystemShelfBooks(key, { ...filters, ...options, sort });
	}

	function bookErrorMessage(cause: unknown, more: boolean): string {
		return translate(shelfErrorKey(cause, more ? 'more_books' : 'load_books'));
	}

	const systemShelfTitle = (key: string) => {
		return key === 'unshelved' ? m['ux3.shelves.unshelved']() : key === 'favorites' ? m['ux3.shelves.favorites']() : key;
	};
</script>

<svelte:head>
	<title>{shelf ? systemShelfTitle(key) : m['shelves.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<div>
	{#if error}
		<div class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
			<p>{error}</p>
			<button class="mt-2 underline underline-offset-4 focus-visible:outline-2" onclick={() => void loadShelf(key, collectionLibraryID(page.url))}>{m['shelves.retry']()}</button>
		</div>
	{:else if !shelf}
		<p class="text-slate-600" role="status">{m['shelves.loading']()}</p>
	{:else}
		<h1 class="sr-only">{systemShelfTitle(key)}</h1>
		{#if showingDetails}
			<div class="mb-6 space-y-3">
				<a class="inline-block text-sm underline underline-offset-4 focus-visible:outline-2" href={browseHref}>{m['collections.back_to_books']()}</a>
				{#if shelf.description}<ShelfDescription description={shelf.description} />{/if}
			</div>
		{/if}
		<BookBrowser scope={browseScope} showHeading={false} {fetchBooks} {bookErrorMessage} displayStorageKey={`system-collection:${key}`} />
	{/if}
</div>
