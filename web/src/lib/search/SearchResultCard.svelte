<script lang="ts">
	import type { Snippet } from 'svelte';
	import CoverActions from '#lib/bookview/CoverActions.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { relevanceScore } from './api.js';
	import type { SearchResult } from './types.js';

	let { result, actions }: { result: SearchResult; actions?: Snippet } = $props();
	const score = $derived(relevanceScore(result.rank));
	const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
</script>

<li class="flex gap-4 card p-3 sm:p-4" data-rank={result.rank}>
	<CoverActions book={result} variant="search" />
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
