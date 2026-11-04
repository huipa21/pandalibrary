<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import BookBrowser from '#lib/catalog/BookBrowser.svelte';
	import type { BookFilters } from '#lib/catalog/types.js';

	/** No library filter: the server returns every book visible to the viewer. */
	const scope: BookFilters = {};
</script>

<svelte:head>
	<title>{m['ux1.books.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8">
	<header class="space-y-2">
		<h1 class="text-3xl font-semibold tracking-tight">{m['ux1.books.title']()}</h1>
		<p class="text-slate-600">{m['ux1.books.description']()}</p>
	</header>
	<BookBrowser {scope} />
</section>
