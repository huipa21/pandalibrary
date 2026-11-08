<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import ExpandableText from '../ExpandableText.svelte';

	let { description }: { description: string | null } = $props();
</script>

<section class="min-w-0 space-y-3 card p-5 sm:p-6" aria-labelledby="book-overview-heading">
	<h2 id="book-overview-heading" class="text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['bd7.overview']()}</h2>
	{#if description}
		<div class="text-sm leading-6 text-slate-700"><ExpandableText text={description} lines={6} /></div>
	{:else}
		<p class="text-sm text-slate-500">{m['bd7.no_overview']()}</p>
	{/if}
</section>
