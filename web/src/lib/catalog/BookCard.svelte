<script lang="ts">
	import type { Snippet } from 'svelte';
	import CoverActions from '#lib/bookview/CoverActions.svelte';
	import type { Book } from './types.js';

	let { book, mode = 'grid', actions }: { book: Book; mode?: 'grid' | 'list'; actions?: Snippet } = $props();
</script>

<li
	class={mode === 'grid'
		? 'min-w-0'
		: 'flex gap-4 rounded-lg border border-slate-200 bg-white p-3 sm:p-4'}
>
	{#if mode === 'grid'}
		<CoverActions {book} variant="tile" />
		{#if actions}<div class="mt-2">{@render actions()}</div>{/if}
	{:else}
		<CoverActions {book} variant="list" />
		<div class="min-w-0 space-y-2">
			<h3 class="line-clamp-2 font-semibold leading-snug break-words" title={book.title}>
				<a class="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" href={`/books/${book.id}`}>
					{book.title}
				</a>
			</h3>
			{#if book.subtitle}<p class="text-sm text-slate-600">{book.subtitle}</p>{/if}
			{#if book.authors.length}
				<p class="text-sm text-slate-600">{book.authors.map((author) => author.name).join(', ')}</p>
			{/if}
			{#if book.series}
				<p class="text-sm text-slate-600">
					<a class="underline-offset-4 hover:underline" href={`/series/${book.series.id}`}>{book.series.name}</a>
				</p>
			{/if}
			{#if book.tags.length}
				<p class="text-sm text-slate-500">{book.tags.map((tag) => tag.name).join(', ')}</p>
			{/if}
			{@render actions?.()}
		</div>
	{/if}
</li>
