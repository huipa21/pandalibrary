<script lang="ts">
	import { goto } from '$app/navigation';
	import type { Book } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getBookState } from '#lib/reader/api.js';
	import { readerFormat } from '#lib/reader/types.js';
	import type { SearchResult } from '#lib/search/types.js';
	import { currentAccount, offlineAvailable, offlineStatus } from '#lib/sync/client.js';
	import { AccountChangedError } from '#lib/sync/db.js';
	import { withSessionLock } from '#lib/sync/engine.js';
	import { readerState } from '#lib/sync/state.js';
	import BookCover from './BookCover.svelte';
	import { bookState } from './book-states.svelte.js';
	import CoverProgress from './CoverProgress.svelte';
	import { openQuickView } from './events.js';
	import Icon from './Icon.svelte';
	import { readTarget } from './read.js';
	import ReadStatusMenu from './ReadStatusMenu.svelte';
	import StatusIcon from './StatusIcon.svelte';
	import { previewUserBook, readStatusLabel, statusTone, userBookFromState, type UserBook } from './user-book.js';

	interface Props {
		book: Book | SearchResult;
		variant: 'tile' | 'grid' | 'list' | 'search';
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
	const tile = $derived(variant === 'tile' || variant === 'grid');
	const readable = $derived(variant !== 'search' && files.some((file) => readerFormat(file.format) !== null));
	const coverState = $derived.by(() => {
		$offlineStatus.account;
		return variant === 'search' ? null : bookState(book.id);
	});
	const userBook = $derived(coverState ? previewUserBook(null, { status: coverState.status }) : null);
	const hasProgress = $derived(
		tile && coverState !== null && !coverState.loading && !coverState.error &&
		(coverState.status === 'finished' || (coverState.percentage !== null && coverState.percentage > 0))
	);

	async function loadCurrentUserBook(bookId: number): Promise<UserBook | null> {
		const account = currentAccount();
		const durable = offlineAvailable();
		const load = async () => {
			if (currentAccount() !== account) throw new AccountChangedError();
			const online = await getBookState(bookId);
			const current = durable
				? (await readerState(account, bookId, { state: online, settings: [] })).state
				: online;
			if (currentAccount() !== account) throw new AccountChangedError();
			return userBookFromState(current.user_book);
		};
		return durable ? withSessionLock(load, true) : load();
	}

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
		size={tile ? 'md' : 'sm'}
		badge={variant !== 'search'}
	/>
{/snippet}

<div class={tile ? 'min-w-0 w-full' : 'w-20 shrink-0 sm:w-24'}>
	<div class="cover-frame relative" class:tile class:list-cover={variant === 'list'} class:has-progress={hasProgress}>
		<a
			class="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
			href={`/books/${book.id}`}
			aria-label={m['bv3.open_details']()}
			aria-describedby={descriptionId}
			title={book.title}
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
		{#if coverState && !coverState.loading && !coverState.error}
			<div class="cover-status absolute top-2 right-2 z-10" class:unread={coverState.status === 'unread'}>
				{#if $offlineStatus.online}
					<ReadStatusMenu bookId={book.id} {userBook} variant="badge" {loadCurrentUserBook} />
				{:else}
					<span
						class="inline-flex size-7 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/5"
						role="img"
						aria-label={m['bc1.status_badge']({ status: readStatusLabel(coverState.status) })}
					>
						<StatusIcon status={coverState.status} class={`size-5 shrink-0 ${statusTone(coverState.status).text}`} />
					</span>
				{/if}
			</div>
		{/if}
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
		{#if hasProgress && coverState}
			<div class="cover-progress-visibility pointer-events-none absolute inset-0">
				<CoverProgress percentage={coverState.percentage} status={coverState.status} />
			</div>
		{/if}
	</div>
	{#if error}<p class="mt-1 text-xs text-red-800" role="alert">{error}</p>{/if}
</div>

<style>
	.tile {
		border-radius: 0.375rem;
		transition: transform 150ms ease-out, box-shadow 150ms;
	}

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

	@container (max-width: 6rem) {
		.list-cover :global(.book-cover > div.absolute.top-2.left-2) {
			top: 2.5rem;
		}
	}

	@media (hover: hover) {
		.tile:hover,
		.tile:focus-within {
			transform: translateY(-4px);
			box-shadow: 0 10px 24px -6px rgb(15 23 42 / 35%);
		}

		.cover-overlay {
			background: rgb(15 23 42 / 45%);
			opacity: 0;
			transition: opacity 150ms;
		}

		.tile .cover-overlay {
			background: rgb(15 23 42 / 20%);
		}

		.cover-status.unread,
		.cover-progress-visibility {
			opacity: 0;
			transition: opacity 150ms;
		}

		.cover-frame:hover .cover-overlay,
		.cover-frame:focus-within .cover-overlay,
		.cover-frame:hover .cover-status.unread,
		.cover-frame:focus-within .cover-status.unread,
		.cover-frame:hover .cover-progress-visibility,
		.cover-frame:focus-within .cover-progress-visibility {
			opacity: 1;
		}
	}

	@media (hover: none) {
		.cover-overlay {
			align-items: end;
			justify-content: end;
			padding: 0.5rem;
		}

		.has-progress .cover-overlay {
			padding-bottom: 2.5rem;
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
		.tile,
		.cover-overlay,
		.cover-status.unread,
		.cover-progress-visibility {
			transition: none;
		}

		.tile:hover,
		.tile:focus-within {
			transform: none;
		}
	}
</style>
