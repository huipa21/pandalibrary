<script lang="ts">
	import BookCover from './BookCover.svelte';
	import ExpandableText from './ExpandableText.svelte';
	import IdentifierLinks from './IdentifierLinks.svelte';
	import Icon, { type IconName } from './Icon.svelte';
	import { formatDuration } from './format.js';
	import RatingStars from './RatingStars.svelte';
	import ReadStatusMenu from './ReadStatusMenu.svelte';
	import type { UserBook } from './user-book.js';
	import BookShelfTags from './details/BookShelfTags.svelte';
	import { createBookShelves } from './details/book-shelves.svelte.js';
	import ShelfPopover from './quickview/ShelfPopover.svelte';

	let rating = $state<number | null>(7);
	let shelfBookId = $state(21);
	let shelvesOffline = $state(false);
	const shelves = createBookShelves(() => shelfBookId);
	let coverUrl = $state('/cover-broken.png');
	const userBook: UserBook = {
		status: 'reading', rating: 7, started_at: '2026-01-02T03:04:05Z',
		finished_at: null, updated_at: '2026-01-03T00:00:00Z', rev: 3
	};
	const longText = `<p>${'A long description &amp; more text. '.repeat(24)}</p><script>window.__bv3Xss = true<\/script><img src=x onerror="window.__bv3Xss = true">`;
	const identifiers = [
		{ scheme: 'isbn13', value: '9781234567890' },
		{ scheme: 'custom', value: '<unsafe>' }
	];
	const icons: IconName[] = [
		'info', 'play', 'book-open', 'external', 'eye', 'folder-plus', 'download', 'x',
		'chevron-left', 'chevron-right', 'chevron-down', 'trash', 'copy', 'more',
		'star', 'star-half', 'pencil', 'search', 'plus', 'refresh', 'file'
	];
	const clothCovers: Array<{
		id: number; title: string; authors: string[]; series?: string; subtitle?: string;
	}> = [
		{ id: 2, title: 'Emma', authors: ['Jane Austen'] },
		{ id: 4, title: 'The Adventures of Sherlock Holmes', series: 'Sherlock Holmes', authors: ['Arthur Conan Doyle'] },
		{ id: 5, title: 'Twenty Thousand Leagues Under the Seas', authors: ['Jules Verne'] },
		{ id: 7, title: 'Frankenstein', subtitle: 'The Modern Prometheus', authors: ['Mary Shelley'] },
		{ id: 10, title: 'Pride and Prejudice', authors: ['Jane Austen'] },
		{ id: 3, title: 'The Secret Garden', authors: ['Frances Hodgson Burnett'] }
	];
	const compactTitle = '星'.repeat(90);
</script>

<div class="space-y-5 bg-white p-4 text-slate-900">
	<p data-test="duration">{formatDuration(10560)}</p>
	<section aria-label="Editable rating"><RatingStars value={rating} editable onChange={(next) => (rating = next)} /></section>
	<section aria-label="Read-only rating"><RatingStars value={5} /></section>
	<section data-test="long-description" style="width: 12rem"><ExpandableText text={longText} lines={2} /></section>
	<section data-test="short-description" style="width: 20rem"><ExpandableText text="<b>Short &amp; safe</b>" /></section>
	<section data-test="identifier-icons"><IdentifierLinks {identifiers} variant="icons" /></section>
	<section data-test="identifier-chips"><IdentifierLinks {identifiers} variant="chips" /></section>
	<section data-test="reading-status"><ReadStatusMenu bookId={21} {userBook} variant="pill" /></section>
	<section data-test="new-reading-status"><ReadStatusMenu bookId={23} userBook={null} variant="icon" /></section>
	<section data-test="badge-reading-status"><ReadStatusMenu bookId={24} {userBook} variant="badge" /></section>
	<section data-test="icons">{#each icons as name}<Icon {name} />{/each}</section>
	<section data-test="changing-cover" style="width: 8rem">
		<BookCover id={21} title="Changing cover" {coverUrl} />
		<button type="button" onclick={() => (coverUrl = '/cover-good.png')}>Use working cover</button>
	</section>
	<section data-test="cloth-cover-gallery" class="flex flex-wrap gap-4">
		{#each clothCovers as cover (cover.id)}
			<div class="w-book shrink-0">
				<BookCover {...cover} />
			</div>
		{/each}
	</section>
	<section data-test="cloth-cover-compact" class="flex items-start gap-4">
		<div data-test="cover-xs" class="w-12">
			<BookCover id={2} title={compactTitle} series="A long series" subtitle="A subtitle" authors={['First Writer']} size="xs" />
		</div>
		<div data-test="cover-sm" class="w-24">
			<BookCover id={4} title={compactTitle} series="A long series" subtitle="A subtitle" authors={['First Writer']} size="sm" />
		</div>
		<div data-test="cover-overflow" class="w-book">
			<BookCover
				id={13}
				title={compactTitle}
				series={'A very long series '.repeat(10)}
				subtitle={'A very long subtitle '.repeat(10)}
				authors={['An exceptionally long author name '.repeat(10)]}
			/>
		</div>
	</section>
	<section aria-label="Shelf tags" data-test="shelf-tags" class="space-y-4 pb-80">
		<h2>Shelf tags</h2>
		<label><input type="checkbox" bind:checked={shelvesOffline} /> Offline shelves</label>
		<button type="button" onclick={() => (shelfBookId = shelfBookId === 21 ? 22 : 21)}>Switch shelf book</button>
		<div data-test="shelf-picker">
			{#if !shelvesOffline}
				<ShelfPopover bookId={shelfBookId} memberIds={shelves.memberIds} variant="button" placement="down" />
			{/if}
		</div>
		<BookShelfTags {shelves} bookTitle={`Shelf Book ${shelfBookId}`} offline={shelvesOffline} />
	</section>
</div>
