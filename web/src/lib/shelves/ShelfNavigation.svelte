<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { listAllLibraries } from '#lib/catalog/api.js';
	import type { Library } from '#lib/catalog/types.js';
	import LibraryActionsMenu from '#lib/libraries/LibraryActionsMenu.svelte';
	import { selectedLibrary } from '#lib/libraries/context.js';
	import { translate } from '#lib/paging/translate.js';
	import { listAllShelves } from './api.js';
	import { shelfErrorKey } from './form.js';
	import ShelfActionsMenu from './ShelfActionsMenu.svelte';
	import type { Shelf } from './types.js';

	let { pathname, role }: { pathname: string; role: string } = $props();
	let libraries = $state<Library[]>([]);
	let shelves = $state<Shelf[]>([]);
	let expanded = $state(true);
	let loading = $state(true);
	let libraryError = $state('');
	let collectionError = $state('');
	let refreshVersion = $state(0);
	const currentLibraryID = $derived(
		Number(/^\/library\/([1-9]\d*)\/?$/.exec(pathname)?.[1]) || undefined
	);

	$effect(() => {
		refreshVersion;
		const controller = new AbortController();
		let active = true;
		loading = true;
		libraryError = '';
		collectionError = '';
		void Promise.all([
			listAllLibraries(controller.signal).then((items) => {
				if (!active) return;
				libraries = items;
				untrack(() => {
					const current = items.find((library) => library.id === currentLibraryID);
					if (current) selectedLibrary.set({ id: current.id, name: current.name });
				});
			}).catch((cause) => {
				if (active) libraryError = translate(shelfErrorKey(cause, 'load'));
			}),
			listAllShelves(controller.signal).then((items) => {
				if (active) shelves = items.filter((shelf) => !shelf.system_key);
			}).catch((cause) => {
				if (active) collectionError = translate(shelfErrorKey(cause, 'load'));
			})
		]).finally(() => { if (active) loading = false; });
		return () => { active = false; controller.abort(); };
	});

	onMount(() => {
		const refresh = () => { refreshVersion += 1; };
		window.addEventListener('pandalibrary-shelves-changed', refresh);
		window.addEventListener('pandalibrary-libraries-changed', refresh);
		return () => {
			window.removeEventListener('pandalibrary-shelves-changed', refresh);
			window.removeEventListener('pandalibrary-libraries-changed', refresh);
		};
	});
</script>

<section class="shell-section" aria-labelledby="sidebar-libraries-heading" data-slot="sidebar-libraries">
	<div class="flex items-center justify-between gap-2 pr-1">
		<h2 id="sidebar-libraries-heading" class="shell-heading min-w-0 flex-1">
			<button type="button" class="flex w-full items-center justify-between gap-2 text-left" aria-expanded={expanded} aria-controls="sidebar-library-list" onclick={() => { expanded = !expanded; }}>
				{m['organize.libraries']()}
				<svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" class="size-4 shrink-0" style:transform={expanded ? 'rotate(180deg)' : undefined}>
					<path d="m5 7 5 5 5-5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</button>
		</h2>
		<LibraryActionsMenu {role} libraryID={currentLibraryID} />
	</div>
	<div id="sidebar-library-list" hidden={!expanded}>
		{#if libraryError}
			<div class="mt-1 px-3 text-sm text-red-300" role="alert">
				<p>{libraryError}</p>
				<button class="shell-text-button" onclick={() => { refreshVersion += 1; }}>{m['ux1.shelves.retry']()}</button>
			</div>
		{:else if loading}
			<p class="mt-1 px-3 text-sm text-[color:var(--shell-muted)]" role="status">{m['catalog.loading']()}</p>
		{:else if libraries.length}
			<ul class="mt-1 space-y-0.5">
				{#each libraries as library (library.id)}
					<li>
						<a class="shell-link" href={`/library/${library.id}`} aria-current={currentLibraryID === library.id ? 'page' : undefined}>
							<span class="min-w-0 flex-1 truncate">{library.name}</span>
							<span class="shell-count">{library.visible_book_count}</span>
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-1 px-3 text-sm text-[color:var(--shell-muted)]">{m['organize.library_empty']()}</p>
		{/if}
	</div>
</section>

<section class="shell-section" aria-labelledby="sidebar-shelves-heading" data-slot="sidebar-shelves">
	<div class="flex items-center justify-between gap-2 pr-1">
		<h2 id="sidebar-shelves-heading" class="shell-heading min-w-0">
			<a href="/shelves" aria-current={pathname === '/shelves' ? 'page' : undefined} class="block truncate hover:underline focus-visible:outline-2">{m['organize.collections']()}</a>
		</h2>
		<ShelfActionsMenu {pathname} {role} />
	</div>
	{#if collectionError}
		<div class="mt-1 px-3 text-sm text-red-300" role="alert">
			<p>{collectionError}</p>
			<button class="shell-text-button" onclick={() => { refreshVersion += 1; }}>{m['ux1.shelves.retry']()}</button>
		</div>
	{:else if loading}
		<p class="mt-1 px-3 text-sm text-[color:var(--shell-muted)]" role="status">{m['ux1.shelves.loading']()}</p>
	{:else if shelves.length}
		<ul class="mt-1 space-y-0.5">
			{#each shelves as shelf (shelf.id)}
				<li>
					<a class="shell-link" href={`/shelves/${shelf.id}`} aria-current={pathname === `/shelves/${shelf.id}` ? 'page' : undefined}>
						<span class="min-w-0 flex-1 truncate">{shelf.name}</span>
						<span class="shell-count" title={m['ux1.shelves.count']({ count: shelf.visible_book_count })}>{shelf.visible_book_count}</span>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-1 px-3 text-sm text-[color:var(--shell-muted)]">{m['organize.collection_empty']()}</p>
	{/if}
</section>
