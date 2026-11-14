<script lang="ts">
	import type { Book } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import { offlineStatus } from '#lib/sync/client.js';
	import Icon from '../Icon.svelte';
	import { getBookContext } from '../book-context.svelte.js';
	import { formatPublicationDate } from '../format.js';
	import { contentRatingLabel, formatAgeRating, formatSeriesPosition } from './metadata-display.js';

	let { book, offline, canEdit }: {
		book: Book;
		offline: boolean;
		canEdit?: boolean;
	} = $props();

	const context = getBookContext();
	const isbn = $derived(book.identifiers.find((item) =>
		['isbn', 'isbn10', 'isbn13'].includes(item.scheme.trim().toLowerCase())
	)?.value ?? null);
	const metadataSources = $derived([...new Set(book.field_sources.map((item) => item.source))]);
	const genres = $derived(book.genres ?? []);
	const moods = $derived(book.moods ?? []);
	const seriesPosition = $derived(book.series ? formatSeriesPosition(book.series) : null);
</script>

<section class="min-w-0 space-y-4 card p-5" aria-labelledby="book-details-heading">
	<div class="flex items-center justify-between">
		<h2 id="book-details-heading" class="text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['bv6.details']()}</h2>
		{#if (canEdit ?? context.canEditMetadata) && !offline && $offlineStatus.online}
			<a
				class="inline-flex size-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
				href={`/books/${book.id}/metadata`}
				aria-label={m['bd6.edit_metadata']()}
				title={m['bd6.edit_metadata']()}
			><Icon name="pencil" class="size-4" /></a>
		{/if}
	</div>
	<dl class="space-y-3 text-sm">
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['catalog.book.publisher']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{book.publisher || '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['catalog.book.published']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{book.published_date ? formatPublicationDate(book.published_date) : '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['catalog.book.language']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{book.language || '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['catalog.book.page_count']()}</dt><dd class="text-slate-800">{book.page_count ?? '–'}</dd></div>
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['bv6.isbn']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{isbn || '–'}</dd></div>
		{#if book.series}
			<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
				<dt class="text-slate-500">{m['bm8.series']()}</dt>
				<dd class="text-slate-800 [overflow-wrap:anywhere]">
					<a class="font-medium text-emerald-800 underline-offset-4 hover:underline" href={`/series/${book.series.id}`}>{book.series.name}</a>
					{#if seriesPosition}<span class="text-slate-600"> · {seriesPosition}</span>{/if}
				</dd>
			</div>
		{/if}
		{#if genres.length}
			<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
				<dt class="text-slate-500">{m['bm8.genres']()}</dt>
				<dd><ul class="flex flex-wrap gap-1.5">{#each genres as genre (genre)}<li class="max-w-full rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 [overflow-wrap:anywhere]">{genre}</li>{/each}</ul></dd>
			</div>
		{/if}
		{#if moods.length}
			<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
				<dt class="text-slate-500">{m['bm8.moods']()}</dt>
				<dd><ul class="flex flex-wrap gap-1.5">{#each moods as mood (mood)}<li class="max-w-full rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 [overflow-wrap:anywhere]">{mood}</li>{/each}</ul></dd>
			</div>
		{/if}
		{#if book.age_rating != null}
			<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['bm8.age_rating']()}</dt><dd class="text-slate-800">{formatAgeRating(book.age_rating)}</dd></div>
		{/if}
		{#if book.content_rating}
			<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['bm8.content_rating']()}</dt><dd class="text-slate-800">{contentRatingLabel(book.content_rating)}</dd></div>
		{/if}
		<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
			<dt class="text-slate-500">{m['bd6.metadata_source']()}</dt>
			<dd class="text-slate-800 [overflow-wrap:anywhere]">
				<span>{metadataSources.length ? metadataSources.join(', ') : '–'}</span>
				{#if metadataSources.length}
					<details class="mt-1 text-xs text-slate-600">
						<summary class="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-emerald-700">{m['bd6.show_fields']()}</summary>
						<ul class="mt-2 space-y-1">
							{#each book.field_sources as source}
								<li>{source.field}: {source.source}{#if source.source_ref}{' · '}{source.source_ref}{/if}</li>
							{/each}
						</ul>
					</details>
				{/if}
			</dd>
		</div>
		{#if book.cover_source}
			<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt class="text-slate-500">{m['bd6.cover_source']()}</dt><dd class="text-slate-800 [overflow-wrap:anywhere]">{book.cover_source}</dd></div>
		{/if}
	</dl>
</section>
