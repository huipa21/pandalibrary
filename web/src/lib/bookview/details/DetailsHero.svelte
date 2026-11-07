<script lang="ts">
	import type { Book } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import IdentifierLinks from '../IdentifierLinks.svelte';
	import RatingStars from '../RatingStars.svelte';
	import ReadStatusMenu from '../ReadStatusMenu.svelte';
	import { formatTone, sortedFormats } from '../cover.js';
	import { formatPercent } from '../format.js';
	import { readStatusLabel, saveUserBook } from '../user-book.js';
	import type { DetailsState } from './details-data.js';

	let { book, details, offline }: {
		book: Book;
		details: DetailsState | null;
		offline: boolean;
	} = $props();

	let ratingBusy = $state(false);
	let ratingError = $state('');
	let optimisticRating = $state<number | null | undefined>(undefined);
	const rating = $derived(optimisticRating === undefined ? details?.userBook?.rating ?? null : optimisticRating);
	const formats = $derived(sortedFormats(book.files));
	const progress = $derived(details?.progress?.percentage ?? 0);

	$effect(() => {
		book.id;
		details?.userBook?.updated_at;
		details?.userBook?.rev;
		details?.userBook?.rating;
		optimisticRating = undefined;
	});

	async function changeRating(value: number | null) {
		if (!details || offline || ratingBusy) return;
		const previous = optimisticRating;
		const bookId = book.id;
		optimisticRating = value;
		ratingBusy = true;
		ratingError = '';
		try {
			await saveUserBook(bookId, details.userBook, { rating: value });
		} catch (cause) {
			console.error('Could not save the book rating', cause);
			if (book.id === bookId) {
				optimisticRating = previous;
				ratingError = m['bv6.rating_error']();
			}
		} finally {
			ratingBusy = false;
		}
	}

	function roleLabel(role: string): string {
		switch (role) {
			case 'translator': return m['catalog.book.role.translator']();
			case 'editor': return m['catalog.book.role.editor']();
			case 'illustrator': return m['catalog.book.role.illustrator']();
			default: return role;
		}
	}
</script>

<header class="min-w-0 space-y-4">
	<div class="flex flex-wrap items-start gap-3">
		<div class="min-w-0">
			<h1 class="text-3xl font-semibold tracking-tight text-slate-950 [overflow-wrap:anywhere]">{book.title}</h1>
			{#if book.subtitle}<p class="mt-1 text-lg text-slate-600 [overflow-wrap:anywhere]">{book.subtitle}</p>{/if}
		</div>
		{#if progress > 0}
			<span class="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-800">{formatPercent(progress)}</span>
		{/if}
	</div>

	{#if book.authors.length}
		<p class="text-sm leading-6 text-slate-600">
			<span>{m['bv6.by']()}</span>
			{#each book.authors as author, index (`${author.id}:${author.role}:${author.position}`)}
				{#if index > 0}<span>, </span>{/if}
				<a class="font-medium text-slate-800 underline-offset-4 hover:underline" href={`/authors/${author.id}`}>{author.name}</a>
				{#if author.role !== 'author'}<span class="text-slate-500"> ({roleLabel(author.role)})</span>{/if}
			{/each}
		</p>
	{/if}
	{#if book.series}
		<p class="text-sm text-slate-600">
			<a class="font-medium text-emerald-800 underline-offset-4 hover:underline" href={`/series/${book.series.id}`}>{book.series.name}</a>
			{#if book.series.index !== null}<span> · {book.series.index}</span>{/if}
		</p>
	{/if}

	<div class="flex flex-wrap items-center gap-3">
		<div aria-busy={ratingBusy}>
			{#if details && !offline}
				<RatingStars value={rating} editable onChange={(value) => void changeRating(value)} />
			{:else}
				<RatingStars value={rating} />
			{/if}
		</div>
		{#if details && !offline}
			<ReadStatusMenu bookId={book.id} userBook={details.userBook} reread={(details.summary?.attempts.length ?? 0) > 1} />
		{:else if details}
			<span class="rounded-full border border-slate-300 px-3 py-2 text-sm text-slate-700">{readStatusLabel(details.userBook?.status ?? 'unread', (details.summary?.attempts.length ?? 0) > 1)}</span>
		{/if}
		<a class="text-sm font-medium text-emerald-800 underline underline-offset-4" href="#book-review">{m['bv6.personal_review']()}</a>
	</div>
	{#if ratingError}<p class="text-sm text-red-800" role="alert">{ratingError}</p>{/if}

	{#if formats.length || book.identifiers.length}
		<div class="flex flex-wrap items-center gap-2">
			{#each formats as format}
				<span class={`rounded-md px-2 py-1 text-xs font-semibold ${formatTone(format)}`}>{format.toUpperCase()}</span>
			{/each}
			<IdentifierLinks identifiers={book.identifiers} variant="chips" />
		</div>
	{/if}
	{#if book.tags.length}
		<ul class="flex flex-wrap gap-2" aria-label={m['catalog.book.tags']()}>
			{#each book.tags as tag (tag.id)}
				<li><a class="inline-block max-w-full rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 [overflow-wrap:anywhere] hover:bg-slate-200" href={`/tags/${tag.id}`}>{tag.name}</a></li>
			{/each}
		</ul>
	{/if}
</header>
