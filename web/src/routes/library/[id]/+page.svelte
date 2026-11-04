<script lang="ts">
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { catalogErrorMessage } from '#lib/catalog/errors.js';
	import { getLibrary } from '#lib/catalog/api.js';
	import BookBrowser from '#lib/catalog/BookBrowser.svelte';
	import ShelfLinks from '#lib/shelves/ShelfLinks.svelte';
	import type { Library } from '#lib/catalog/types.js';

	let library = $state<Library | null>(null);
	let loading = $state(true);
	let error = $state('');
	let requestVersion = 0;

	$effect(() => {
		const id = page.params.id ?? '';
		void loadLibrary(id);
	});

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
			library = await getLibrary(parsedID);
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
		<a class="underline underline-offset-4 focus-visible:outline-2" href="/libraries">{m['catalog.back_to_libraries']()}</a>
	</div>
{:else if loading}
	<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
{:else if library}
	<section class="space-y-8">
		<header class="space-y-2">
			<a class="text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2" href="/libraries">{m['catalog.back_to_libraries']()}</a>
			<h1 class="text-3xl font-semibold tracking-tight">{library.name}</h1>
		</header>
		<ShelfLinks />
		<BookBrowser scope={{ library_id: library.id }} />
	</section>
{/if}
