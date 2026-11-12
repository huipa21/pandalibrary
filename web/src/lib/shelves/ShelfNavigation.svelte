<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError } from '#lib/api/client.js';
	import { getLibrary } from '#lib/catalog/api.js';
	import LibraryActionsMenu from '#lib/libraries/LibraryActionsMenu.svelte';
	import { libraryHref, parseLibraryID, selectedLibrary, selectLibrary } from '#lib/libraries/context.js';
	import { translate } from '#lib/paging/translate.js';
	import { listAllShelves, getSystemShelf } from './api.js';
	import { shelfErrorKey } from './form.js';
	import type { Shelf, SystemShelf } from './types.js';

	let { pathname, role }: { pathname: string; role: string } = $props();
	let shelves = $state<Shelf[]>([]);
	let unshelved = $state<SystemShelf | null>(null);
	let loading = $state(false);
	let error = $state('');
	let refreshVersion = $state(0);
	const selectedID = $derived($selectedLibrary?.id);

	$effect(() => {
		const path = pathname.replace(/\/+$/, '');
		const query = page.url.searchParams.get('library_id');
		untrack(() => {
			if (path === '/libraries') selectedLibrary.set(null);
			else {
				const match = /^\/library\/([1-9]\d*)$/.exec(path);
				const id = parseLibraryID(match?.[1] ?? (path.startsWith('/shelves/') ? query : null));
				if (id !== undefined) selectLibrary(id);
			}
		});
	});

	$effect(() => {
		const id = selectedID;
		refreshVersion;
		shelves = [];
		unshelved = null;
		error = '';
		loading = id !== undefined;
		if (id === undefined) return;
		const controller = new AbortController();
		let active = true;
		void (async () => {
			try {
				const [library, all, systemShelf] = await Promise.all([
					getLibrary(id),
					listAllShelves(controller.signal, { library_id: id }),
					getSystemShelf('unshelved', { library_id: id, signal: controller.signal })
				]);
				if (!active) return;
				selectedLibrary.set({ id: library.id, name: library.name });
				unshelved = systemShelf;
				shelves = all.filter((shelf) => !shelf.system_key);
			} catch (cause) {
				if (!active) return;
				error = translate(shelfErrorKey(cause, 'load'));
				if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
					selectedLibrary.update((current) => current?.id === id ? { id } : current);
				}
			} finally {
				if (active) loading = false;
			}
		})();
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

<section class="shell-section" aria-labelledby="sidebar-shelves-heading" data-slot="sidebar-shelves">
	<div class="flex items-center justify-between gap-2 pr-1">
		<h2 id="sidebar-shelves-heading" class="shell-heading min-w-0">
			<a href="/libraries" aria-current={pathname === '/libraries' ? 'page' : undefined} class="block truncate hover:underline focus-visible:outline-2">{$selectedLibrary?.name ?? m['ux1.library.heading']()}</a>
		</h2>
		<LibraryActionsMenu {role} libraryID={$selectedLibrary?.id} />
	</div>
	{#if error}
		<div class="mt-1 space-y-1 px-3 text-sm text-red-300">
			<p>{error}</p>
			<button class="shell-text-button" onclick={() => { refreshVersion += 1; }}>{m['ux1.shelves.retry']()}</button>
		</div>
	{:else if loading}
		<p class="mt-1 px-3 text-sm text-[color:var(--shell-muted)]">{m['ux1.shelves.loading']()}</p>
	{:else if $selectedLibrary}
		<ul class="mt-1 space-y-0.5">
			{#if unshelved}
				<li>
					<a class="shell-link" href={libraryHref('/shelves/system/unshelved', $selectedLibrary.id)} aria-current={pathname === '/shelves/system/unshelved' ? 'page' : undefined}>
						<span class="min-w-0 flex-1 truncate">{m['ux3.shelves.unshelved']()}</span>
						<span class="shell-count" title={m['ux1.shelves.count']({ count: unshelved.visible_book_count })}>{unshelved.visible_book_count}</span>
					</a>
				</li>
			{/if}
			{#each shelves as shelf (shelf.id)}
				{@const path = `/shelves/${shelf.id}`}
				<li>
					<a class="shell-link" href={libraryHref(path, $selectedLibrary.id)} aria-current={pathname === path ? 'page' : undefined}>
						<span class="min-w-0 flex-1 truncate">{shelf.name}</span>
						<span class="shell-count" title={m['ux1.shelves.count']({ count: shelf.visible_book_count })}>{shelf.visible_book_count}</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</section>
