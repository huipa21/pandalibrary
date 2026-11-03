<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { relevanceScore } from './api.js';
	import type { SearchResult } from './types.js';

	let { result, actions }: { result: SearchResult; actions?: Snippet } = $props();
	const score = $derived(relevanceScore(result.rank));
	const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
</script>

<li class="flex gap-4 rounded-lg border border-slate-200 bg-white p-3 sm:p-4" data-rank={result.rank}>
	{#if result.cover_url}
		<img
			class="h-28 w-20 shrink-0 rounded bg-slate-100 object-cover sm:h-36 sm:w-24"
			src={result.cover_url}
			alt={m['search.cover_alt']({ title: result.title })}
			loading="lazy"
		/>
	{:else}
		<div class="flex h-28 w-20 shrink-0 items-center justify-center rounded bg-slate-100 px-2 text-center text-xs text-slate-500 sm:h-36 sm:w-24">
			{m['catalog.book.cover_unavailable']()}
		</div>
	{/if}
	<div class="min-w-0 flex-1 space-y-2">
		<h3 class="font-semibold leading-snug break-words">
			<a
				class="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
				href={`/books/${result.id}`}
			>{result.title}</a>
		</h3>
		{#if result.authors.length}
			<p class="text-sm text-slate-600">{result.authors.join(', ')}</p>
		{/if}
		{#if result.series}
			<p class="text-sm text-slate-600">
				<a class="underline-offset-4 hover:underline focus-visible:outline-2" href={`/series/${result.series.id}`}>{result.series.name}</a>
				{#if result.series.index !== null}
					<span> · {m['search.series_index']({ index: formatter.format(result.series.index) })}</span>
				{/if}
			</p>
		{/if}
		{#if score !== null}
			<p class="text-xs text-slate-500">{m['search.relevance']({ score: formatter.format(score) })}</p>
		{/if}
		{@render actions?.()}
	</div>
</li>
