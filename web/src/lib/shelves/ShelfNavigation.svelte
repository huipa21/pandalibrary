<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { deLocalizeHref } from '#lib/paraglide/runtime.js';
	import { listAllLibraries } from '#lib/catalog/api.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import { BOOKS_CHANGED_EVENT } from '#lib/catalog/events.js';
	import type { Library } from '#lib/catalog/types.js';
	import { BOOKHEAP_CHANGED_EVENT } from '#lib/bookheap/events.js';
	import LibraryActionsMenu from '#lib/libraries/LibraryActionsMenu.svelte';
	import { selectedLibrary } from '#lib/libraries/context.js';
	import { translate } from '#lib/paging/translate.js';
	import { listAllShelves } from './api.js';
	import { shelfErrorKey } from './form.js';
	import ShelfActionsMenu from './ShelfActionsMenu.svelte';
	import type { Shelf } from './types.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { entityIcon } from '#lib/navigation-icons.js';

	let { pathname, role }: { pathname: string; role: string } = $props();
	let libraries = $state<Library[]>([]);
	let shelves = $state<Shelf[]>([]);
	let expanded = $state(false);
	let loading = $state(true);
	let libraryError = $state('');
	let collectionError = $state('');
	let refreshVersion = $state(0);
	const visibleLibraries = $derived(expanded ? libraries : libraries.slice(0, 5));
	const currentLibraryID = $derived(
		Number(/^\/library\/([1-9]\d*)\/?$/.exec(pathname)?.[1]) || undefined
	);
	const currentShelfID = $derived(
		Number(/^\/shelves\/([1-9]\d*)\/?$/.exec(deLocalizeHref(pathname))?.[1]) || undefined
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
				if (active) libraryError = catalogErrorMessage(cause, {
					api: m['catalog.error.api'](), connection: m['catalog.error.connection'](),
					notFound: m['catalog.error.not_found']()
				});
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
		const events = [
			'pandalibrary-shelves-changed',
			'pandalibrary-libraries-changed',
			BOOKS_CHANGED_EVENT,
			BOOKHEAP_CHANGED_EVENT
		];
		for (const event of events) window.addEventListener(event, refresh);
		return () => {
			for (const event of events) window.removeEventListener(event, refresh);
		};
	});
</script>

<section class="shell-section" aria-labelledby="sidebar-libraries-heading" data-slot="sidebar-libraries">
	<div class="flex items-center justify-between gap-2 pr-1">
		<h2 id="sidebar-libraries-heading" class="shell-heading min-w-0 flex-1">
			{m['organize.libraries']()}
		</h2>
		<LibraryActionsMenu {role} />
	</div>
	<div id="sidebar-library-list">
		{#if libraryError}
			<div class="mt-1 px-3 text-sm text-red-300" role="alert">
				<p>{libraryError}</p>
				<button class="shell-text-button" onclick={() => { refreshVersion += 1; }}>{m['ux1.shelves.retry']()}</button>
			</div>
		{:else if loading}
			<p class="mt-1 px-3 text-sm text-[color:var(--shell-muted)]" role="status">{m['catalog.loading']()}</p>
		{:else if libraries.length}
			<ul class="mt-1 space-y-0.5">
				{#each visibleLibraries as library (library.id)}
					<li>
						<a class="shell-link" href={`/library/${library.id}`} aria-current={currentLibraryID === library.id ? 'page' : undefined}>
							<Icon name={entityIcon(library.icon, `library:${library.id}`)} class="size-4 shrink-0" />
							<span class="min-w-0 flex-1 truncate">{library.name}</span>
							<span class="shell-count">{library.visible_book_count}</span>
						</a>
					</li>
				{/each}
				{#if libraries.length > 5}
					<li>
						<button type="button" class="shell-link w-full justify-center" aria-label={expanded ? m['bv3.show_less']() : m['bv3.show_more']()} title={expanded ? m['bv3.show_less']() : m['bv3.show_more']()} aria-expanded={expanded} aria-controls="sidebar-library-list" onclick={() => { expanded = !expanded; }}>
							<span class="flex" style:transform={expanded ? 'rotate(180deg)' : undefined}><Icon name="chevron-down" class="size-4 shrink-0" /></span>
						</button>
					</li>
				{/if}
			</ul>
		{:else}
			<p class="mt-1 px-3 text-sm text-[color:var(--shell-muted)]">{m['organize.library_empty']()}</p>
		{/if}
	</div>
</section>

<section class="shell-section" aria-labelledby="sidebar-shelves-heading" data-slot="sidebar-shelves">
	<div class="flex items-center justify-between gap-2 pr-1">
		<h2 id="sidebar-shelves-heading" class="shell-heading min-w-0">
			{m['organize.collections']()}
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
					<a class="shell-link" href={`/shelves/${shelf.id}`} aria-current={currentShelfID === shelf.id ? 'page' : undefined}>
						<Icon name={entityIcon(shelf.icon, `collection:${shelf.id}`)} class="size-4 shrink-0" />
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
