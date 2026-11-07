<script lang="ts">
	import { goto } from '$app/navigation';
	import type { Book } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import { readerFormat } from '#lib/reader/types.js';
	import type { SearchResult } from '#lib/search/types.js';
	import { currentAccount } from '#lib/sync/client.js';
	import BookCover from './BookCover.svelte';
	import { openQuickView } from './events.js';
	import Icon from './Icon.svelte';
	import { readTarget } from './read.js';

	interface Props {
		book: Book | SearchResult;
		variant: 'grid' | 'list' | 'search';
	}

	let { book, variant }: Props = $props();
	const descriptionId = $props.id();
	let busy = $state(false);
	let error = $state('');

	function fullBook(value: Book | SearchResult): value is Book {
		return 'files' in value;
	}

	const authors = $derived(book.authors.map((author) => typeof author === 'string' ? author : author.name));
	const files = $derived(fullBook(book) ? book.files : []);
	const readable = $derived(variant !== 'search' && files.some((file) => readerFormat(file.format) !== null));

	function info(event: MouseEvent) {
		event.stopPropagation();
		openQuickView({
			bookId: book.id,
			...(variant !== 'search' && fullBook(book) ? { book } : {})
		});
	}

	async function read(event: MouseEvent) {
		event.stopPropagation();
		if (busy || !fullBook(book)) return;
		busy = true;
		error = '';
		try {
			const target = await readTarget(book, currentAccount());
			if (!target) throw new Error('No readable book file is available.');
			await goto(`/read/${target.bookId}/${target.fileId}`);
		} catch (cause) {
			console.error('Could not open the book for reading', cause);
			error = m['bv3.read_failed']();
		} finally {
			busy = false;
		}
	}
</script>

{#snippet cover()}
	<BookCover
		id={book.id}
		title={book.title}
		subtitle={fullBook(book) ? book.subtitle : null}
		series={book.series?.name}
		{authors}
		coverUrl={book.cover_url}
		{files}
		size={variant === 'grid' ? 'md' : 'sm'}
		badge={variant !== 'search'}
	/>
{/snippet}

<div class={variant === 'grid' ? 'min-w-0 w-full' : 'w-20 shrink-0 sm:w-24'}>
	<div class="cover-frame relative">
		<a
			class="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
			href={`/books/${book.id}`}
			aria-label={m['bv3.open_details']()}
			aria-describedby={descriptionId}
		>
			<span id={descriptionId} class="sr-only">{book.title}</span>
			{#if variant === 'search'}
				<div role="img" aria-label={m['search.cover_alt']({ title: book.title })}>
					{@render cover()}
				</div>
			{:else}
				{@render cover()}
			{/if}
		</a>
		<div class="cover-overlay rounded-lg">
			<button
				type="button"
				class="cover-button inline-flex size-11 items-center justify-center rounded-full bg-emerald-700 text-white shadow-md hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
				aria-label={m['bv3.quick_view']({ title: book.title })}
				onclick={info}
			><Icon name="info" /></button>
			{#if readable}
				<button
					type="button"
					class="read-button cover-button inline-flex size-11 items-center justify-center rounded-full bg-emerald-700 text-white shadow-md hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white aria-disabled:opacity-70"
					aria-label={m['bv3.read']({ title: book.title })}
					aria-busy={busy}
					aria-disabled={busy}
					onclick={read}
				>
					<Icon name={busy ? 'refresh' : 'play'} class={busy ? 'size-5 animate-spin motion-reduce:animate-none' : 'size-5'} />
					{#if busy}<span class="sr-only">{m['bv3.reading']()}</span>{/if}
				</button>
			{/if}
		</div>
	</div>
	{#if error}<p class="mt-1 text-xs text-red-800" role="alert">{error}</p>{/if}
</div>

<style>
	.cover-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		pointer-events: none;
	}

	.cover-button {
		pointer-events: auto;
	}

	@media (hover: hover) {
		.cover-overlay {
			background: rgb(15 23 42 / 45%);
			opacity: 0;
			transition: opacity 150ms;
		}

		.cover-frame:hover .cover-overlay,
		.cover-frame:focus-within .cover-overlay {
			opacity: 1;
		}
	}

	@media (hover: none) {
		.cover-overlay {
			align-items: end;
			justify-content: end;
			padding: 0.5rem;
		}

		.cover-button {
			width: 2.5rem;
			height: 2.5rem;
		}

		.read-button {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.cover-overlay {
			transition: none;
		}
	}
</style>
