<script lang="ts">
	import { getLibrary } from '#lib/catalog/api.js';
	import type { Book } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';

	let { book, offline }: { book: Book; offline: boolean } = $props();
	const labelId = $props.id();
	const libraryCache = new Map<number, string>();
	let libraryName = $state<string | null>(null);
	let libraryError = $state('');

	$effect(() => {
		const id = book.library_id;
		const isOffline = offline;
		let active = true;
		const cached = libraryCache.get(id) ?? null;
		libraryError = '';
		libraryName = cached;
		if (!cached && !isOffline) {
			void getLibrary(id).then(
				(library) => {
					if (!active) return;
					libraryCache.set(id, library.name);
					libraryName = library.name;
				},
				(cause: unknown) => {
					if (!active) return;
					console.error('Could not load the book library', cause);
					libraryError = m['bv6.library_error']();
				}
			);
		}
		return () => { active = false; };
	});
</script>

<section class="min-w-0 space-y-2" aria-labelledby={labelId}>
	<h2 id={labelId} class="text-xs font-semibold tracking-wide text-slate-500 uppercase">{m['bv6.library']()}</h2>
	<p class="text-sm text-slate-800 [overflow-wrap:anywhere]">
		{#if libraryError}<span class="text-red-800" role="alert">{libraryError}</span>
		{:else if libraryName && !offline}<a class="text-emerald-800 underline-offset-4 hover:underline" href={`/library/${book.library_id}`}>{libraryName}</a>
		{:else}{libraryName || '–'}{/if}
	</p>
</section>
