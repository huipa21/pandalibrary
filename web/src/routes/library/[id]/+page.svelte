<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import { getLibrary } from '#lib/catalog/api.js';
	import BookBrowser from '#lib/catalog/BookBrowser.svelte';
	import type { Library } from '#lib/catalog/types.js';
	import { selectedLibrary, selectLibrary } from '#lib/libraries/context.js';

	let library = $state<Library | null>(null);
	let loading = $state(true);
	let error = $state('');
	let requestVersion = 0;

	$effect(() => {
		const id = page.params.id ?? '';
		void loadLibrary(id);
	});

	onDestroy(() => { requestVersion += 1; });

	async function loadLibrary(id: string) {
		const request = ++requestVersion;
		library = null;
		loading = true;
		error = '';
		const parsedID = Number(id);
		if (!Number.isSafeInteger(parsedID) || parsedID < 1) {
			error = m['catalog.error.not_found']();
			loading = false;
			return;
		}
		try {
			selectLibrary(parsedID);
			const loaded = await getLibrary(parsedID);
			if (request !== requestVersion) return;
			library = loaded;
			selectedLibrary.set({ id: loaded.id, name: loaded.name });
		} catch (cause) {
			if (request !== requestVersion) return;
			error = catalogErrorMessage(cause, {
				api: m['catalog.error.api'](),
				connection: m['catalog.error.connection'](),
				notFound: m['catalog.error.not_found']()
			});
		} finally {
			if (request === requestVersion) loading = false;
		}
	}
</script>

{#if error}
	<div class="space-y-4" role="alert">
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{error}</p>
		<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => loadLibrary(page.params.id ?? '')}>{m['catalog.retry']()}</button>
	</div>
{:else if loading}
	<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
{:else if library}
	<section>
		<h1 class="sr-only">{library.name}</h1>
		<BookBrowser scope={{ library_id: library.id }} showHeading={false} />
	</section>
{/if}
