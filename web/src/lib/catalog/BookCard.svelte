<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { Book } from './types.js';

	let { book, mode = 'grid', actions }: { book: Book; mode?: 'grid' | 'list'; actions?: Snippet } = $props();
</script>

<li
	class={mode === 'grid'
		? 'overflow-hidden rounded-lg border border-slate-200 bg-white'
		: 'flex gap-4 rounded-lg border border-slate-200 bg-white p-3 sm:p-4'}
>
	{#if mode === 'grid'}
		{#if book.cover_url}
			<img class="aspect-[3/4] w-full bg-slate-100 object-cover" src={book.cover_url} alt={book.title} loading="lazy" />
		{:else}
			<div class="flex aspect-[3/4] items-center justify-center bg-slate-100 px-4 text-center text-sm text-slate-500">
				{m['catalog.book.cover_unavailable']()}
			</div>
		{/if}
		<div class="space-y-2 p-4">
			<h3 class="font-semibold leading-snug">
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
			{@render actions?.()}
		</div>
	{:else}
		{#if book.cover_url}
			<img class="h-28 w-20 shrink-0 rounded bg-slate-100 object-cover sm:h-36 sm:w-24" src={book.cover_url} alt={book.title} loading="lazy" />
		{:else}
			<div class="flex h-28 w-20 shrink-0 items-center justify-center rounded bg-slate-100 px-2 text-center text-xs text-slate-500 sm:h-36 sm:w-24">
				{m['catalog.book.cover_unavailable']()}
			</div>
		{/if}
		<div class="min-w-0 space-y-2">
			<h3 class="font-semibold leading-snug">
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
