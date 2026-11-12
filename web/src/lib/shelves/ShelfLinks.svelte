<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { libraryHref } from '#lib/libraries/context.js';
	import { translate } from '#lib/paging/translate.js';
	import { getSessionViewer, getSystemShelf, listAllShelves } from './api.js';
	import { shelfErrorKey } from './form.js';
	import ShelfActionsMenu from './ShelfActionsMenu.svelte';
	import type { Shelf, SystemShelf } from './types.js';

	let { libraryID }: { libraryID: number } = $props();
	let shelves = $state<Shelf[]>([]);
	let unshelved = $state<SystemShelf | null>(null);
	let role = $state('');
	let loading = $state(true);
	let error = $state('');
	let refreshVersion = $state(0);

	$effect(() => {
		const id = libraryID;
		refreshVersion;
		const controller = new AbortController();
		let active = true;
		shelves = [];
		unshelved = null;
		loading = true;
		error = '';
		void (async () => {
			try {
				const [all, systemShelf, viewer] = await Promise.all([
					listAllShelves(controller.signal, { library_id: id }),
					getSystemShelf('unshelved', { library_id: id, signal: controller.signal }),
					getSessionViewer()
				]);
				if (!active) return;
				unshelved = systemShelf;
				shelves = all.filter((shelf) => !shelf.system_key);
				role = viewer.role;
			} catch (cause) {
				if (active) error = translate(shelfErrorKey(cause, 'load'));
			} finally {
				if (active) loading = false;
			}
		})();
		return () => { active = false; controller.abort(); };
	});

	onMount(() => {
		const refresh = () => { refreshVersion += 1; };
		window.addEventListener('pandalibrary-shelves-changed', refresh);
		return () => window.removeEventListener('pandalibrary-shelves-changed', refresh);
	});
</script>

<nav class="space-y-3 card p-4" aria-labelledby="library-shelves-heading">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 id="library-shelves-heading" class="font-semibold">{m['shelves.library.heading']()}</h2>
		<ShelfActionsMenu pathname={`/library/${libraryID}`} {role} />
	</div>
	{#if error}
		<div class="flex flex-wrap items-center gap-3 text-sm text-red-800" role="alert">
			<p>{error}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => { refreshVersion += 1; }}>{m['shelves.retry']()}</button>
		</div>
	{:else if loading}
		<p class="text-sm text-slate-600" role="status">{m['shelves.loading']()}</p>
	{:else}
		<ul class="flex flex-wrap gap-2">
			{#if unshelved}
				<li>
					<a class="inline-block rounded-full border border-slate-300 px-3 py-1 text-sm underline-offset-4 hover:underline focus-visible:outline-2"
						href={libraryHref('/shelves/system/unshelved', libraryID)}
					>{m['ux3.shelves.unshelved']()} <span class="text-slate-500">({unshelved.visible_book_count})</span></a>
				</li>
			{/if}
			{#each shelves as shelf (shelf.id)}
				<li>
					<a class="inline-block rounded-full border border-slate-300 px-3 py-1 text-sm underline-offset-4 hover:underline focus-visible:outline-2"
						href={libraryHref(`/shelves/${shelf.id}`, libraryID)}
					>{shelf.name} <span class="text-slate-500">({shelf.visible_book_count})</span></a>
				</li>
			{/each}
		</ul>
	{/if}
</nav>
