<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { ApiError } from '#lib/api/client.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { translate } from '#lib/paging/translate.js';
	import { formatSize } from '#lib/bookview/format.js';
	import { browserTimeZone, statsErrorKey } from './api.js';
	import { addedLabel, bucketData, fetchBookStats, formatBookShare, formatCount, languageLabel, publicationTimeline, topTwenty } from './book-api.js';
	import type { BookStatsResponse, RankedBook } from './book-types.js';
	import StatsCard from './StatsCard.svelte';
	import DistributionChart from './DistributionChart.svelte';

	const timeZone = browserTimeZone();
	const locale = $derived(getLocale());
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let data = $state<BookStatsResponse | null>(null);
	let error = $state<unknown>(null);
	let controller: AbortController | null = null;
	const errorKind = $derived(requestErrorKind(error));
	const serverDetail = $derived(
		error instanceof ApiError && errorKind === 'invalid' && typeof error.problem?.detail === 'string' ? error.problem.detail : ''
	);
	const added = $derived(bucketData(data?.added_over_time ?? [], (key) => key === 'unknown' ? m['stats.catalog.unknown']() : addedLabel(key, locale), locale));
	const years = $derived(bucketData(publicationTimeline(data?.publication_years ?? []), (key) => key, locale));
	const unknownYears = $derived(data?.publication_years.find(({ key }) => key === 'unknown')?.count ?? 0);
	const genres = $derived(bucketData(data?.genres ?? [], metadataLabel, locale, data?.total_books ?? 0));
	const languages = $derived(bucketData(data?.languages ?? [], (key) => key === 'unknown' ? m['stats.catalog.unknown']() : languageLabel(key, locale), locale, data?.total_books ?? 0));
	const formats = $derived(bucketData(data?.formats ?? [], (key) => key === 'unknown' ? m['stats.catalog.unknown']() : key.toUpperCase(), locale, data?.total_books ?? 0));
	const pages = $derived(bucketData(data?.page_counts ?? [], metadataLabel, locale, data?.total_books ?? 0));
	const authors = $derived(topTwenty(data?.top_authors ?? [], (author) => author.count));
	const largest = $derived(topTwenty(data?.largest_books ?? [], (book) => book.value));
	const mostPages = $derived(topTwenty(data?.most_pages ?? [], (book) => book.value));
	const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';

	function metadataLabel(key: string): string {
		return key === 'unknown' ? m['stats.catalog.unknown']() : key;
	}

	onMount(() => void load());
	onDestroy(() => controller?.abort());

	async function load() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		status = 'loading';
		error = null;
		try {
			const result = await fetchBookStats(timeZone, current.signal);
			if (current.signal.aborted) return;
			data = result;
			status = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			console.error('Could not load book stats', cause);
			error = cause;
			status = 'error';
		} finally {
			if (controller === current) controller = null;
		}
	}
</script>

<svelte:head>
	<title>{m['organize.books']()} · {m['common.app_name']()}</title>
</svelte:head>

{#snippet rankedBooks(books: RankedBook[], kind: 'size' | 'pages')}
	{#if books.length}
		<ol class="space-y-3">
			{#each books as book (book.book_id)}
				<li class="flex items-start justify-between gap-3 text-sm">
					<div class="min-w-0">
						<a class="break-words font-medium underline underline-offset-4 {focusRing}" href="/books/{book.book_id}">{book.title}</a>
						<p class="break-words text-slate-600">{book.authors.length ? book.authors.join(', ') : m['stats.books.unknown_author']()}</p>
					</div>
					<span class="shrink-0 text-right tabular-nums" title={kind === 'size' ? m['stats.catalog.bytes']({ count: formatCount(book.value, locale) }) : undefined}>
						{kind === 'size' ? formatSize(book.value, locale) : m['stats.catalog.pages']({ count: formatCount(book.value, locale) })}
					</span>
				</li>
			{/each}
		</ol>
	{:else}
		<p class="text-sm text-slate-600">{m['stats.catalog.ranking_empty']()}</p>
	{/if}
{/snippet}

<section class="space-y-6" aria-labelledby="books-stats-heading" aria-busy={status === 'loading'}>
	<h1 id="books-stats-heading" class="sr-only">{m['organize.books']()}</h1>

	{#if status === 'loading'}
		<p role="status" class="text-slate-600">{m['stats.catalog.loading']()}</p>
	{:else if status === 'error'}
		<div class="space-y-2 rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
			<p>{translate(errorKind === 'invalid' ? 'stats.catalog.error.invalid' : statsErrorKey(error))}</p>
			{#if serverDetail}<p class="text-sm">{m['stats.error.detail']({ detail: serverDetail })}</p>{/if}
			{#if errorKind === 'unauthorized'}
				<a class="font-medium underline underline-offset-4 {focusRing}" href="/login">{m['stats.sign_in']()}</a>
			{:else}
				<button class="font-medium underline underline-offset-4 {focusRing}" onclick={() => load()}>{m['stats.retry']()}</button>
			{/if}
		</div>
	{:else if data}
		{#if data.total_books === 0}<p class="text-slate-600">{m['stats.catalog.empty']()}</p>{/if}
		<div class="grid min-w-0 gap-6 md:grid-cols-2">
			<StatsCard title={m['stats.catalog.added.title']()}>
				<DistributionChart data={added} kind="bar" label={m['stats.catalog.added.title']()} empty={m['stats.catalog.distribution_empty']()} tableLabel={m['stats.catalog.details']()} showValues />
			</StatsCard>
			<StatsCard title={m['stats.catalog.years.title']()}>
				<DistributionChart data={years} kind="area" label={m['stats.catalog.years.title']()} empty={m['stats.catalog.years.empty']()} tableLabel={m['stats.catalog.details']()} />
				<p class="mt-3 text-sm text-slate-600">{m['stats.catalog.years.unknown']({ value: formatBookShare(unknownYears, data.total_books, locale) })}</p>
			</StatsCard>
			<StatsCard title={m['stats.catalog.genres.title']()}>
				<DistributionChart data={genres} kind="treemap" label={m['stats.catalog.genres.title']()} empty={m['stats.catalog.distribution_empty']()} tableLabel={m['stats.catalog.details']()} />
			</StatsCard>
			<StatsCard title={m['stats.catalog.page_counts.title']()}>
				<DistributionChart data={pages} kind="bar" label={m['stats.catalog.page_counts.title']()} empty={m['stats.catalog.distribution_empty']()} tableLabel={m['stats.catalog.details']()} interaction="hover" />
			</StatsCard>
			<StatsCard title={m['stats.catalog.languages.title']()}>
				<DistributionChart data={languages} kind="pie" label={m['stats.catalog.languages.title']()} empty={m['stats.catalog.distribution_empty']()} tableLabel={m['stats.catalog.details']()} interaction="hover" />
			</StatsCard>
			<StatsCard title={m['stats.catalog.formats.title']()}>
				<DistributionChart data={formats} kind="pie" label={m['stats.catalog.formats.title']()} empty={m['stats.catalog.distribution_empty']()} tableLabel={m['stats.catalog.details']()} interaction="click" />
			</StatsCard>
		</div>
		<div class="grid min-w-0 gap-6 md:grid-cols-2 xl:grid-cols-3">
			<StatsCard title={m['stats.catalog.authors.title']()}>
				{#if authors.length}
					<ol class="space-y-3">
						{#each authors as author (author.name)}
							<li class="flex justify-between gap-3 text-sm">
								<span class="min-w-0 break-words">{author.name === 'unknown' ? m['stats.books.unknown_author']() : author.name}</span>
								<span class="shrink-0 tabular-nums">{m['stats.catalog.books']({ count: formatCount(author.count, locale) })}</span>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="text-sm text-slate-600">{m['stats.catalog.ranking_empty']()}</p>
				{/if}
			</StatsCard>
			<StatsCard title={m['stats.catalog.largest.title']()}>
				{@render rankedBooks(largest, 'size')}
			</StatsCard>
			<StatsCard title={m['stats.catalog.most_pages.title']()}>
				{@render rankedBooks(mostPages, 'pages')}
			</StatsCard>
		</div>
	{/if}
</section>
