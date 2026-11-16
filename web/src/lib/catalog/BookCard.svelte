<script lang="ts">
	import type { Snippet } from 'svelte';
	import CoverActions from '#lib/bookview/CoverActions.svelte';
	import type { Book } from './types.js';

	let {
		book,
		mode = 'grid',
		actions,
		selectable = false,
		selected = false,
		selectionLabel = '',
		onselect
	}: {
		book: Book;
		mode?: 'grid' | 'list';
		actions?: Snippet;
		selectable?: boolean;
		selected?: boolean;
		selectionLabel?: string;
		onselect?: (selected: boolean) => void;
	} = $props();
</script>

<li
	class={mode === 'grid'
		? 'relative min-w-0'
		: 'relative flex gap-4 rounded-lg border border-slate-200 bg-white p-3 sm:p-4'}
	class:ring-2={selectable && selected}
	class:ring-emerald-600={selectable && selected}
	class:ring-offset-2={selectable && selected}
>
	{#if selectable}
		<label class="absolute top-2 left-2 z-20 inline-flex size-7 cursor-pointer items-center justify-center rounded-full bg-white/95 shadow ring-1 ring-slate-300 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-emerald-700">
			<input
				type="checkbox"
				class="size-4 accent-emerald-700"
				checked={selected}
				aria-label={selectionLabel}
				onchange={(event) => onselect?.(event.currentTarget.checked)}
			/>
		</label>
	{/if}
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
