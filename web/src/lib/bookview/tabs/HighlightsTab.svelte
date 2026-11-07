<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getBookContext } from '../book-context.svelte.js';

	// Placeholder until BV9 implements this tab.
	const context = getBookContext();
</script>

{#if context.book}
	<section class="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8" aria-labelledby="book-tab-heading">
		<h1 id="book-tab-heading" class="text-xl font-semibold">{m['bv4.tabs.highlights']()}</h1>
		<p class="mt-3 inline-block rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800">{m['bv4.coming_soon.title']()}</p>
		<p class="mt-3 text-slate-600">{m['bv4.coming_soon.body']()}</p>
	</section>
{/if}
