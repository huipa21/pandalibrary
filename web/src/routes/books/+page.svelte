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
	<h1 class="sr-only">{m['ux1.books.title']()}</h1>
	<BookBrowser {scope} showHeading={false} rememberSettings />
</section>
