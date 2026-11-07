<script lang="ts">
	import BookCard from '#lib/catalog/BookCard.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '../Icon.svelte';
	import type { RelatedBooks } from './details-data.js';

	let { related }: { related: RelatedBooks } = $props();
	let selected = $state<'author' | 'similar'>('author');
	let carousel = $state<HTMLUListElement | null>(null);
	const books = $derived(selected === 'author' ? related.byAuthor : related.similar);

	function select(value: 'author' | 'similar') {
		selected = value;
		carousel?.scrollTo({ left: 0 });
	}

	function scroll(direction: -1 | 1) {
		carousel?.scrollBy({ left: direction * 320, behavior: 'smooth' });
	}
</script>

{#if related.byAuthor.length || related.similar.length}
	<section class="min-w-0 space-y-4" aria-labelledby="related-books-heading">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h2 id="related-books-heading" class="sr-only">{m['bv6.related']()}</h2>
				<div class="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-slate-100 p-1" role="group" aria-label={m['bv6.related']()}>
					<button type="button" class={`rounded-lg px-3 py-2 text-sm font-semibold ${selected === 'author' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`} aria-pressed={selected === 'author'} onclick={() => select('author')}>{m['bv6.by_author']()}</button>
					<button type="button" class={`rounded-lg px-3 py-2 text-sm font-semibold ${selected === 'similar' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`} aria-pressed={selected === 'similar'} onclick={() => select('similar')}>{m['bv6.similar']()}</button>
				</div>
			</div>
			<div class="flex gap-2">
				<button type="button" class="rounded-full border border-slate-300 p-2 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700" aria-label={m['bv6.previous_books']()} onclick={() => scroll(-1)}><Icon name="chevron-left" class="size-4" /></button>
				<button type="button" class="rounded-full border border-slate-300 p-2 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700" aria-label={m['bv6.next_books']()} onclick={() => scroll(1)}><Icon name="chevron-right" class="size-4" /></button>
			</div>
		</div>
		{#if books.length}
			<ul bind:this={carousel} class="flex max-w-full gap-3 overflow-x-auto pb-2 [&>li]:w-36 [&>li]:shrink-0">
				{#each books as book (book.id)}
					<BookCard {book} />
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-slate-500">{selected === 'author' ? m['bv6.no_author_books']() : m['bv6.no_similar_books']()}</p>
		{/if}
	</section>
{/if}
