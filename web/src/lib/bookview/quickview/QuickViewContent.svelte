<script lang="ts">
	import { goto } from '$app/navigation';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { readerFormat } from '#lib/reader/types.js';
	import { currentAccount } from '#lib/sync/client.js';
	import BookCover from '../BookCover.svelte';
	import { formatTone, sortedFormats } from '../cover.js';
	import ExpandableText from '../ExpandableText.svelte';
	import { formatDate, formatPercent, formatSize } from '../format.js';
	import Icon from '../Icon.svelte';
	import IdentifierLinks from '../IdentifierLinks.svelte';
	import RatingStars from '../RatingStars.svelte';
	import { readTarget } from '../read.js';
	import ReadStatusMenu from '../ReadStatusMenu.svelte';
	import type { QuickViewData } from './quick-view-data.js';
	import ShelfPopover from './ShelfPopover.svelte';

	let { data, titleId }: { data: QuickViewData; titleId: string } = $props();
	let reading = $state(false);
	let readError = $state('');
	const book = $derived(data.book);
	const formats = $derived(sortedFormats(book.files));
	const readable = $derived(book.files.some((file) => readerFormat(file.format) !== null));
	const resume = $derived((data.progress?.percentage ?? 0) > 0);
	const primaryProgress = $derived(
		data.primaryFile && data.progress?.book_file_id === data.primaryFile.id ? data.progress.percentage : null
	);
	const collections = $derived(data.shelves ?? []);
	const memberIds = $derived(collections.map((shelf) => shelf.id));
	const authorNames = $derived(book.authors.map((author) => author.name));

	$effect(() => {
		book.id;
		readError = '';
	});

	function dot(format: string): string {
		return formatTone(format).split(' ').find((name) => name.startsWith('bg-')) ?? 'bg-slate-700';
	}

	function published(value: string): string {
		try {
			return formatDate(value);
		} catch {
			return value;
		}
	}

	function language(code: string): string {
		try {
			const name = new Intl.DisplayNames([getLocale()], { type: 'language' }).of(code.trim());
			if (name) return name.toLocaleUpperCase(getLocale());
		} catch {
			// Not a valid BCP 47 tag; show the stored value.
		}
		return code.toUpperCase();
	}

	function shelfName(shelf: { name: string; system_key?: string | null }): string {
		return shelf.system_key === 'favorites' ? m['ux3.shelves.favorites']() : shelf.name;
	}

	function shelfHref(shelf: { id: number; system_key?: string | null }): string {
		return shelf.system_key === 'favorites' ? '/shelves/system/favorites' : `/shelves/${shelf.id}`;
	}

	async function read() {
		if (reading || !readable) return;
		const target = book;
		reading = true;
		readError = '';
		try {
			const destination = await readTarget(target, currentAccount());
			if (!destination) throw new Error('No readable book file is available.');
			if (target.id !== book.id) return;
			await goto(`/read/${destination.bookId}/${destination.fileId}`);
		} catch (cause) {
			console.error('Could not open the book for reading', cause);
			if (target.id === book.id) readError = m['bv5.read_failed']();
		} finally {
			reading = false;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 pb-6" data-quick-view-body>
		<header class="flex gap-4">
			<div class="w-24 shrink-0">
				<BookCover id={book.id} title={book.title} subtitle={book.subtitle} series={book.series?.name} authors={authorNames} coverUrl={book.cover_url} files={book.files} size="sm" badge loading="eager" />
			</div>
			<div class="min-w-0 flex-1 space-y-2">
				<h2 id={titleId} class="text-lg leading-snug font-semibold break-words text-slate-950">
					<a class="rounded hover:underline focus-visible:outline-2 focus-visible:outline-emerald-700" href={`/books/${book.id}`}>{book.title}</a>
				</h2>
				{#if book.subtitle}<p class="text-sm text-slate-600">{book.subtitle}</p>{/if}
				<IdentifierLinks identifiers={book.identifiers} variant="icons" />
				{#if book.authors.length}
					<p class="text-sm text-slate-700">
						{#each book.authors as author, index (author.id)}
							{#if index > 0}<span aria-hidden="true">, </span>{/if}<a class="rounded font-medium hover:underline focus-visible:outline-2 focus-visible:outline-emerald-700" href={`/authors/${author.id}`}>{author.name}</a>
						{/each}
					</p>
				{/if}
				<RatingStars value={data.userBook?.rating ?? null} size="sm" />
			</div>
		</header>

		<hr class="border-slate-200" />

		<ul class="flex flex-wrap gap-2" aria-label={m['bv5.facts']()}>
			{#each formats as format (format)}
				<li class="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
					<span class={`size-2 rounded-full ${dot(format)}`} aria-hidden="true"></span>{format.toUpperCase()}
				</li>
			{/each}
			{#if book.page_count !== null}
				<li class="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{m['bv5.pages']({ count: book.page_count })}</li>
			{/if}
			{#if book.published_date}
				<li class="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700" title={m['bv5.published']()}>
					<span class="sr-only">{m['bv5.published']()}: </span>{published(book.published_date)}
				</li>
			{/if}
			{#if book.language}
				<li class="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700" title={m['bv5.language']()}>
					<span class="sr-only">{m['bv5.language']()}: </span>{language(book.language)}
				</li>
			{/if}
		</ul>

		{#if book.publisher || book.series}
			<div class="space-y-1 text-sm">
				{#if book.publisher}<p class="text-slate-600"><span class="sr-only">{m['bv5.publisher']()}: </span>{book.publisher}</p>{/if}
				{#if book.series}
					<p>
						<span class="text-slate-600">{m['bv5.series']()}:</span>
						<a class="rounded font-medium text-emerald-800 hover:underline focus-visible:outline-2 focus-visible:outline-emerald-700" href={`/series/${book.series.id}`}>
							{book.series.index === null ? book.series.name : m['bv5.series_index']({ name: book.series.name, index: book.series.index })}
						</a>
					</p>
				{/if}
			</div>
		{/if}

		{#if data.primaryFile}
			{@const file = data.primaryFile}
			<section class="rounded-xl border border-slate-200 bg-slate-50 p-3" aria-labelledby={`${titleId}-file`}>
				<h3 id={`${titleId}-file`} class="text-xs font-semibold tracking-wide text-slate-500 uppercase">{m['bv5.primary_file']()}</h3>
				<p class="mt-1 flex items-start gap-2 text-sm font-medium break-all text-slate-900">
					<Icon name="file" class="mt-0.5 size-4 shrink-0 text-slate-500" />{file.original_filename}
				</p>
				<div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
					<span class="inline-flex items-center gap-1.5 rounded-md bg-white px-2 py-0.5 font-medium text-slate-700 ring-1 ring-slate-200">
						<span class={`size-2 rounded-full ${dot(file.format)}`} aria-hidden="true"></span>{file.format.toUpperCase()}
					</span>
					<span>{formatSize(file.size_bytes)}</span>
					{#if primaryProgress !== null}
						<span class="font-medium text-emerald-800">{m['bv5.percent_read']({ percent: formatPercent(primaryProgress) })}</span>
					{/if}
				</div>
			</section>
		{/if}

		{#if book.tags.length}
			<section class="space-y-2" aria-labelledby={`${titleId}-tags`}>
				<h3 id={`${titleId}-tags`} class="text-xs font-semibold tracking-wide text-slate-500 uppercase">{m['bv5.tags']()}</h3>
				<ul class="flex flex-wrap gap-2">
					{#each book.tags as tag (tag.id)}
						<li><a class="inline-block max-w-full rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium break-words text-emerald-800 hover:bg-emerald-100 focus-visible:outline-2 focus-visible:outline-emerald-700" href={`/tags/${tag.id}`}>{tag.name}</a></li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if collections.length}
			<section class="space-y-2" aria-labelledby={`${titleId}-collections`}>
				<h3 id={`${titleId}-collections`} class="text-xs font-semibold tracking-wide text-slate-500 uppercase">{m['bv5.collections']()}</h3>
				<ul class="flex flex-wrap gap-2">
					{#each collections as shelf (shelf.id)}
						<li>
							<a class="inline-flex max-w-full items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-emerald-700" href={shelfHref(shelf)}>
								<svg aria-hidden="true" class="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
								<span class="truncate">{shelfName(shelf)}</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if book.description}
			<hr class="border-slate-200" />
			<section class="space-y-2 text-sm leading-6 text-slate-700" aria-labelledby={`${titleId}-synopsis`}>
				<h3 id={`${titleId}-synopsis`} class="text-xs font-semibold tracking-wide text-slate-500 uppercase">{m['bv5.synopsis']()}</h3>
				<ExpandableText text={book.description} lines={5} />
			</section>
		{/if}
	</div>

	<footer class="shrink-0 border-t border-slate-200 bg-white p-4">
		<div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-2">
			<span class="min-w-0" title={readable ? undefined : m['bv5.not_readable']()}>
				<button
					type="button"
					class="inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
					disabled={!readable}
					aria-busy={reading}
					onclick={read}
				>
					<Icon name={reading ? 'refresh' : 'book-open'} class={reading ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4'} />
					<span class="truncate">{resume ? m['bv5.resume']() : m['bv5.read']()}</span>
				</button>
			</span>
			<a
				class="inline-flex min-w-0 items-center justify-center rounded-full border border-emerald-700 px-4 py-2.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
				href={`/books/${book.id}`}
			><span class="truncate">{m['bv5.details']()}</span></a>
			<div class="status-slot">
				<ReadStatusMenu bookId={book.id} userBook={data.userBook} percentage={data.progress?.percentage} variant="icon" />
			</div>
			{#if !data.offline}
				<ShelfPopover bookId={book.id} {memberIds} />
			{/if}
		</div>
		{#if !readable}<p class="sr-only">{m['bv5.not_readable']()}</p>{/if}
		{#if readError}<p class="mt-2 text-sm text-red-800" role="alert">{readError}</p>{/if}
	</footer>
</div>

<style>
	/* The status menu opens upward from the sticky footer so it stays inside the viewport. */
	.status-slot :global([role='menu']) {
		top: auto;
		right: 0;
		bottom: 100%;
		margin-top: 0;
		margin-bottom: 0.5rem;
	}

	.status-slot :global([role='alert']) {
		position: absolute;
		right: 0;
		bottom: 100%;
		max-width: 16rem;
		border-radius: 0.5rem;
		background: white;
		padding: 0.25rem 0.5rem;
	}
</style>
