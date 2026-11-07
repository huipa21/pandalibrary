<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { readerFormat } from '#lib/reader/types.js';
	import AddToShelf from '#lib/shelves/AddToShelf.svelte';
	import { currentAccount } from '#lib/sync/client.js';
	import BookCover from '../BookCover.svelte';
	import Icon from '../Icon.svelte';
	import ReadStatusMenu from '../ReadStatusMenu.svelte';
	import { getBookContext } from '../book-context.svelte.js';
	import { sortedFormats } from '../cover.js';
	import { BOOK_STATE_CHANGED_EVENT, type BookStateChangedDetail } from '../events.js';
	import { readTarget } from '../read.js';
	import DetailsHero from '../details/DetailsHero.svelte';
	import DetailsPanel from '../details/DetailsPanel.svelte';
	import EditionsCard from '../details/EditionsCard.svelte';
	import ReadingCard from '../details/ReadingCard.svelte';
	import RelatedBooks from '../details/RelatedBooks.svelte';
	import SynopsisCard from '../details/SynopsisCard.svelte';
	import { loadDetailsState, loadRelated, type DetailsState, type RelatedBooks as RelatedBookLists } from '../details/details-data.js';

	const context = getBookContext();
	const book = $derived(context.book);
	const bookId = $derived(book?.id ?? null);
	const offline = $derived(context.offline);
	let details = $state<DetailsState | null>(null);
	let detailsLoading = $state(true);
	let detailsError = $state('');
	let detailsRevision = $state(0);
	let detailsBookId: number | null = null;
	let related = $state<RelatedBookLists | null>(null);
	let relatedError = $state('');
	let relatedRevision = $state(0);
	let readBusy = $state(false);
	let readError = $state('');
	const detailsReady = $derived(details !== null && !detailsLoading && !detailsError);
	const readable = $derived(book?.files.some((file) => readerFormat(file.format) !== null) ?? false);
	const primaryFile = $derived.by(() => {
		if (!book) return null;
		const preferred = sortedFormats(book.files)[0];
		return book.files.find((file) => file.format.trim().toLowerCase() === preferred) ?? book.files[0] ?? null;
	});

	$effect(() => {
		bookId;
		readError = '';
	});

	$effect(() => {
		const id = bookId;
		const isOffline = offline;
		detailsRevision;
		if (id === null) return;
		const controller = new AbortController();
		if (detailsBookId !== id) {
			details = null;
			detailsBookId = id;
		}
		detailsLoading = true;
		detailsError = '';
		void loadDetailsState(id, controller.signal, isOffline).then(
			(state) => {
				if (controller.signal.aborted) return;
				details = state;
				detailsLoading = false;
			},
			(cause: unknown) => {
				if (controller.signal.aborted) return;
				console.error('Could not load book reading details', cause);
				detailsError = m['bv6.state_error']();
				detailsLoading = false;
			}
		);
		return () => controller.abort();
	});

	$effect(() => {
		const id = bookId;
		const isOffline = offline;
		relatedRevision;
		const current = untrack(() => context.book);
		related = null;
		relatedError = '';
		if (id === null || isOffline || !current || current.id !== id) return;
		const controller = new AbortController();
		void loadRelated(current, controller.signal).then(
			(value) => {
				if (!controller.signal.aborted) related = value;
			},
			(cause: unknown) => {
				if (controller.signal.aborted) return;
				console.error('Could not load related books', cause);
				relatedError = m['bv6.related_error']();
			}
		);
		return () => controller.abort();
	});

	$effect(() => {
		const id = bookId;
		const changed = (event: Event) => {
			const detail = (event as CustomEvent<BookStateChangedDetail | null>).detail;
			if (id !== null && detail?.bookId === id) detailsRevision += 1;
		};
		window.addEventListener(BOOK_STATE_CHANGED_EVENT, changed);
		return () => window.removeEventListener(BOOK_STATE_CHANGED_EVENT, changed);
	});

	async function read() {
		if (!book || !readable || readBusy) return;
		const current = $state.snapshot(book);
		readBusy = true;
		readError = '';
		try {
			const target = await readTarget(current, currentAccount());
			if (!target) throw new Error('No readable book file is available.');
			if (bookId !== current.id) return;
			await goto(`/read/${target.bookId}/${target.fileId}`);
		} catch (cause) {
			console.error('Could not open the book for reading', cause);
			if (bookId === current.id) readError = m['bv3.read_failed']();
		} finally {
			readBusy = false;
		}
	}
</script>

{#if book}
	<article class="min-w-0 space-y-8">
		{#if offline}<p class="text-sm text-slate-500">{m['bv6.offline_read_only']()}</p>{/if}
		{#if detailsError}
			<div class="flex flex-wrap items-center gap-3 rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
				<span>{detailsError}</span>
				<button type="button" class="font-semibold underline" onclick={() => (detailsRevision += 1)}>{m['catalog.retry']()}</button>
			</div>
		{/if}

		<div class="grid min-w-0 gap-6 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_20rem]">
			<aside class="min-w-0 space-y-3">
				<BookCover id={book.id} title={book.title} authors={book.authors.map((author) => author.name)} coverUrl={context.coverSource} files={book.files} size="lg" badge loading="eager" />
				{#if context.coverError}<p class="text-sm text-amber-800">{context.coverError}</p>{/if}
				{#if book.cover_source}<p class="text-xs text-slate-500">{m['catalog.book.cover_source']()}: {book.cover_source}</p>{/if}
				<div class="flex items-center gap-2">
					<button type="button" class="inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60" disabled={!readable || readBusy} onclick={read}>
						<Icon name="book-open" class="size-4" />
						{details?.progress && details.progress.percentage > 0 ? m['bv6.resume']() : m['bv6.read']()}
					</button>
					{#if detailsReady && details && !offline}
						<ReadStatusMenu bookId={book.id} userBook={details.userBook} reread={(details.summary?.attempts.length ?? 0) > 1} variant="icon" />
					{/if}
				</div>
				{#if readError}<p class="text-sm text-red-800" role="alert">{readError}</p>{/if}
				{#if !offline}
					<div class="flex flex-wrap gap-2">
						{#if primaryFile}
							<div class="relative flex min-w-0">
								<a class="inline-flex items-center gap-1 rounded-l-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100" class:rounded-r-lg={book.files.length === 1} href={primaryFile.download_url}>
									<Icon name="download" class="size-4" /> {m['catalog.book.download']()}
								</a>
								{#if book.files.length > 1}
									<details class="relative">
										<summary class="flex h-full cursor-pointer list-none items-center rounded-r-lg border border-l-0 border-slate-300 px-2 hover:bg-slate-100" aria-label={m['bv6.download_formats']()}><Icon name="chevron-down" class="size-4" /></summary>
										<ul class="absolute top-full left-0 z-10 mt-1 min-w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
											{#each book.files as file (file.id)}
												<li><a class="block rounded px-3 py-2 text-sm hover:bg-slate-100" href={file.download_url} title={file.original_filename}>{m['bv6.download_format']({ format: file.format.toUpperCase() })}</a></li>
											{/each}
										</ul>
									</details>
								{/if}
							</div>
						{/if}
						<a class="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100" href="#book-shelf"><Icon name="folder-plus" class="size-4" /> {m['shelves.book.add']()}</a>
					</div>
					{#if context.canEditMetadata}
						<a class="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100" href={`/books/${book.id}/edit`}><Icon name="pencil" class="size-4" /> {m['metadata.edit.link']()}</a>
					{/if}
				{/if}
				<a class="block text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2" href={`/library/${book.library_id}`}>{m['catalog.back_to_library']()}</a>
			</aside>

			<div class="min-w-0 space-y-6">
				<DetailsHero {book} details={detailsReady ? details : null} {offline} />
				<SynopsisCard bookId={book.id} description={book.description} review={details?.review ?? null} ready={detailsReady} failed={!!detailsError} {offline} />
				{#if detailsReady && details?.summary}<ReadingCard bookId={book.id} summary={details.summary} />{/if}
			</div>

			<aside class="grid min-w-0 content-start gap-6 md:col-span-2 md:grid-cols-2 xl:col-span-1 xl:grid-cols-1">
				<DetailsPanel {book} {primaryFile} userBook={details?.userBook ?? null} ready={detailsReady} {offline} />
				<EditionsCard {book} progress={details?.progress ?? null} />
				{#if book.identifiers.length}
					<section class="min-w-0 space-y-2 rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="book-identifiers-heading">
						<h2 id="book-identifiers-heading" class="text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['catalog.book.identifiers']()}</h2>
						<ul class="space-y-1 text-sm text-slate-700 [overflow-wrap:anywhere]">
							{#each book.identifiers as identifier (`${identifier.scheme}:${identifier.value}`)}
								<li><span class="font-medium">{identifier.scheme}:</span> {identifier.value}</li>
							{/each}
						</ul>
					</section>
				{/if}
				{#if book.field_sources.length}
					<details class="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
						<summary class="cursor-pointer text-sm font-semibold text-slate-700 focus-visible:outline-2">{m['catalog.book.provenance']()}</summary>
						<ul class="mt-3 space-y-2 text-sm text-slate-600 [overflow-wrap:anywhere]">
							{#each book.field_sources as source (`${source.field}:${source.source}:${source.chosen_at}`)}
								<li>{source.field}: {source.source}{#if source.source_ref}{' · '}{source.source_ref}{/if}</li>
							{/each}
						</ul>
					</details>
				{/if}
			</aside>
		</div>

		{#if related}<RelatedBooks {related} />{/if}
		{#if relatedError}
			<div class="flex flex-wrap items-center gap-3 text-sm text-red-800" role="alert">
				<span>{relatedError}</span>
				<button type="button" class="font-semibold underline" onclick={() => (relatedRevision += 1)}>{m['catalog.retry']()}</button>
			</div>
		{/if}

		{#if !offline}
			<div id="book-shelf" class="scroll-mt-24"><AddToShelf bookId={book.id} /></div>
		{/if}
	</article>
{/if}
