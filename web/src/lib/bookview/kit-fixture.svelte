<script lang="ts">
	import BookCover from './BookCover.svelte';
	import ExpandableText from './ExpandableText.svelte';
	import IdentifierLinks from './IdentifierLinks.svelte';
	import Icon, { type IconName } from './Icon.svelte';
	import { formatDuration } from './format.js';
	import RatingStars from './RatingStars.svelte';
	import ReadStatusMenu from './ReadStatusMenu.svelte';
	import type { UserBook } from './user-book.js';

	let rating = $state<number | null>(7);
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
</script>

<div class="space-y-5 bg-white p-4 text-slate-900">
	<p data-test="duration">{formatDuration(10560)}</p>
	<section aria-label="Editable rating"><RatingStars value={rating} editable onChange={(next) => (rating = next)} /></section>
	<section aria-label="Read-only rating"><RatingStars value={5} /></section>
	<section data-test="long-description" style="width: 12rem"><ExpandableText text={longText} lines={2} /></section>
	<section data-test="short-description" style="width: 20rem"><ExpandableText text="<b>Short &amp; safe</b>" /></section>
	<section data-test="identifier-icons"><IdentifierLinks {identifiers} variant="icons" /></section>
	<section data-test="identifier-chips"><IdentifierLinks {identifiers} variant="chips" /></section>
	<section data-test="reading-status"><ReadStatusMenu bookId={21} {userBook} reread variant="pill" /></section>
	<section data-test="new-reading-status"><ReadStatusMenu bookId={23} userBook={null} variant="icon" /></section>
	<section data-test="icons">{#each icons as name}<Icon {name} />{/each}</section>
	<section data-test="changing-cover" style="width: 8rem">
		<BookCover id={21} title="Changing cover" {coverUrl} />
		<button type="button" onclick={() => (coverUrl = '/cover-good.png')}>Use working cover</button>
	</section>
</div>
