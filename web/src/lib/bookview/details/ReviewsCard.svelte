<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { ApiError } from '#lib/api/client.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import ExpandableText from '../ExpandableText.svelte';
	import Icon from '../Icon.svelte';
	import { formatDate, formatRelative, parseDate } from '../format.js';
	import { deleteMyReview, deleteReview, listReviews, type Review } from '../reviews-api.js';
	import ReviewEditor from './ReviewEditor.svelte';

	let { bookId, offline, isAdmin }: { bookId: number; offline: boolean; isAdmin: boolean } = $props();

	let mine = $state<Review | null>(null);
	let items = $state<Review[]>([]);
	let total = $state(0);
	let nextCursor = $state<string | null>(null);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let more = $state<'idle' | 'loading' | 'error'>('idle');
	let editing = $state(false);
	let deleting = $state<number | null>(null);
	let actionError = $state('');
	let root: HTMLElement;
	let heading: HTMLHeadingElement;
	let controller: AbortController | null = null;
	let moreController: AbortController | null = null;
	let pagesLoaded = 0;
	const number = $derived(new Intl.NumberFormat(getLocale()));
	const canWrite = $derived(!offline && status === 'ready' && mine === null && !editing);
	const showMine = $derived(mine !== null && !editing);

	$effect(() => {
		const id = bookId;
		const isOffline = offline;
		untrack(() => {
			mine = null;
			items = [];
			total = 0;
			nextCursor = null;
			pagesLoaded = 0;
			editing = false;
			deleting = null;
			actionError = '';
			more = 'idle';
			status = 'loading';
			if (!isOffline) void load(id);
		});
		return () => {
			controller?.abort();
			moreController?.abort();
		};
	});

	function others(list: readonly Review[], own: Review | null): Review[] {
		const seen = new Set<number>(own ? [own.id] : []);
		return list.filter((item) => !seen.has(item.id) && seen.add(item.id));
	}

	async function load(id: number, quiet = false) {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		if (!quiet) {
			moreController?.abort();
			more = 'idle';
			status = 'loading';
		}
		try {
			const page = await listReviews(id, { signal: current.signal });
			if (current.signal.aborted || id !== bookId) return;
			mine = page.mine;
			total = page.total;
			if (quiet && pagesLoaded > 1) {
				items = others([...page.items, ...items], page.mine);
			} else {
				items = others(page.items, page.mine);
				nextCursor = page.next_cursor;
				pagesLoaded = 1;
			}
			status = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			console.error('Could not load book reviews', cause);
			if (!quiet && id === bookId) status = 'error';
		}
	}

	async function loadMore() {
		const cursor = nextCursor;
		if (!cursor || more === 'loading') return;
		const id = bookId;
		moreController?.abort();
		const current = new AbortController();
		moreController = current;
		more = 'loading';
		try {
			const page = await listReviews(id, { cursor, signal: current.signal });
			if (current.signal.aborted || id !== bookId) return;
			items = others([...items, ...page.items], mine);
			nextCursor = page.next_cursor;
			total = page.total;
			pagesLoaded += 1;
			more = 'idle';
		} catch (cause) {
			if (current.signal.aborted) return;
			console.error('Could not load more book reviews', cause);
			if (id === bookId) more = 'error';
		}
	}

	async function focusTrigger() {
		await tick();
		(root.querySelector<HTMLElement>('[data-review-trigger]') ?? heading).focus();
	}

	function openEditor() {
		actionError = '';
		editing = true;
	}

	function cancelEditor() {
		editing = false;
		void focusTrigger();
	}

	function saved(review: Review) {
		if (review.book_id !== bookId) return;
		if (mine === null) total += 1;
		mine = review;
		items = others(items, review);
		editing = false;
		void focusTrigger();
		void load(review.book_id, true);
	}

	async function remove(review: Review, own: boolean) {
		if (offline || deleting !== null || !window.confirm(m['bd7.delete_review_confirm']())) return;
		const id = bookId;
		deleting = review.id;
		actionError = '';
		try {
			if (own) await deleteMyReview(id);
			else await deleteReview(id, review.id);
		} catch (cause) {
			if (!(cause instanceof ApiError && cause.status === 404)) {
				console.error('Could not delete the book review', cause);
				if (id === bookId) actionError = m['bd7.delete_error']();
				return;
			}
		} finally {
			if (id === bookId) deleting = null;
		}
		if (id !== bookId) return;
		if (own) mine = null;
		else items = items.filter((item) => item.id !== review.id);
		total = Math.max(0, total - 1);
		if (own) void focusTrigger();
		else {
			await tick();
			heading.focus();
		}
		void load(id, true);
	}

	function edited(review: Review): boolean {
		return parseDate(review.updated_at).getTime() > parseDate(review.created_at).getTime();
	}
</script>

{#snippet entry(review: Review, own: boolean)}
	<article class="min-w-0 space-y-2" aria-label={own ? m['bv6.your_review']() : review.author.display_name}>
		<div class="flex items-start justify-between gap-3">
			<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<span class="min-w-0 text-sm font-semibold text-slate-900 [overflow-wrap:anywhere]">{review.author.display_name}</span>
				{#if own}<span class="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">{m['bd7.you']()}</span>{/if}
				<span class="text-xs text-slate-500">
					<time datetime={review.created_at} title={formatDate(review.created_at)}>{formatRelative(review.created_at)}</time>{#if edited(review)}<span title={formatDate(review.updated_at)}>{' · '}{m['bd7.edited']()}</span>{/if}
				</span>
			</div>
			{#if !offline && (own || isAdmin)}
				<div class="flex shrink-0 items-center gap-1">
					{#if own}
						<button
							type="button"
							data-review-trigger
							class="inline-flex size-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60"
							aria-label={m['bd7.edit_review']()}
							title={m['bd7.edit_review']()}
							disabled={deleting !== null}
							onclick={openEditor}
						><Icon name="pencil" class="size-4" /></button>
					{/if}
					<button
						type="button"
						class="inline-flex size-8 items-center justify-center rounded-full text-slate-500 hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60"
						aria-label={own ? m['bd7.delete_review']() : m['bd7.delete_review_by']({ name: review.author.display_name })}
						title={own ? m['bd7.delete_review']() : m['bd7.delete_review_by']({ name: review.author.display_name })}
						aria-busy={deleting === review.id}
						disabled={deleting !== null}
						onclick={() => void remove(review, own)}
					><Icon name="trash" class="size-4" /></button>
				</div>
			{/if}
		</div>
		<div class="text-sm leading-6 text-slate-700 [overflow-wrap:anywhere]"><ExpandableText text={review.body} lines={8} /></div>
	</article>
{/snippet}

<section bind:this={root} class="min-w-0 space-y-4 card p-5 sm:p-6" aria-labelledby="book-reviews-heading">
	<div class="flex min-h-8 items-center justify-between gap-3">
		<div class="flex items-baseline gap-2">
			<h2 bind:this={heading} id="book-reviews-heading" tabindex="-1" class="rounded text-xs font-semibold tracking-wider text-slate-500 uppercase focus-visible:outline-2 focus-visible:outline-emerald-700">{m['bd7.reviews']()}</h2>
			{#if !offline && status === 'ready'}<span class="text-xs text-slate-400" data-review-total>{number.format(total)}</span>{/if}
		</div>
		{#if canWrite}
			<button
				type="button"
				data-review-trigger
				class="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-slate-300 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700"
				aria-label={m['bd7.write_review']()}
				title={m['bd7.write_review']()}
				onclick={openEditor}
			><Icon name="plus" class="size-4" /></button>
		{/if}
	</div>

	{#if offline}
		<p class="text-sm text-slate-500">{m['bd7.reviews_offline']()}</p>
	{:else if status === 'loading'}
		<p class="text-sm text-slate-500" role="status">{m['bd7.reviews_loading']()}</p>
	{:else if status === 'error'}
		<div class="flex flex-wrap items-center gap-3 text-sm text-red-800" role="alert">
			<span>{m['bd7.reviews_error']()}</span>
			<button type="button" class="rounded font-semibold underline focus-visible:outline-2 focus-visible:outline-emerald-700" onclick={() => void load(bookId)}>{m['catalog.retry']()}</button>
		</div>
	{:else}
		{#if editing}
			<ReviewEditor {bookId} initial={mine?.body ?? ''} onSaved={saved} onCancel={cancelEditor} />
		{/if}
		{#if showMine || items.length}
			<ul class="divide-y divide-slate-200">
				{#if mine && showMine}<li class="py-4 first:pt-0 last:pb-0">{@render entry(mine, true)}</li>{/if}
				{#each items as review (review.id)}
					<li class="py-4 first:pt-0 last:pb-0">{@render entry(review, false)}</li>
				{/each}
			</ul>
		{:else if !editing}
			<p class="text-sm text-slate-500">{m['bd7.no_reviews']()}{#if canWrite}{' '}{m['bd7.be_first']()}{/if}</p>
		{/if}
		{#if more === 'error'}
			<div class="flex flex-wrap items-center gap-3 text-sm text-red-800" role="alert">
				<span>{m['bd7.reviews_error']()}</span>
				<button type="button" class="rounded font-semibold underline focus-visible:outline-2 focus-visible:outline-emerald-700" onclick={() => void loadMore()}>{m['catalog.retry']()}</button>
			</div>
		{:else if nextCursor}
			<button
				type="button"
				class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60"
				disabled={more === 'loading'}
				aria-busy={more === 'loading'}
				onclick={() => void loadMore()}
			>{more === 'loading' ? m['bd7.reviews_loading']() : m['bd7.more_reviews']()}</button>
		{/if}
		{#if actionError}<p class="text-sm text-red-800" role="alert">{actionError}</p>{/if}
	{/if}
</section>
