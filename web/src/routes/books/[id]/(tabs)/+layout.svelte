<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import BookTabs, { bookTabFromPath, bookTabLabel } from '#lib/bookview/BookTabs.svelte';
	import { createBookContext, parseBookID, setBookContext } from '#lib/bookview/book-context.svelte.js';
	import { isBookArea, isBookChildFlow, readBookOrigin, rememberBookOrigin, type BookOrigin } from '#lib/bookview/book-origin.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const context = setBookContext(createBookContext());
	const routeID = $derived(page.params.id ?? '');
	const routeBookID = $derived(parseBookID(routeID));
	const tabLabel = $derived(bookTabLabel(bookTabFromPath(page.url.pathname)));
	let origin = $state<BookOrigin | null>(readBookOrigin());
	let directFromOrigin = $state(false);
	let historyLength: number | null = null;

	$effect(() => {
		const id = routeID;
		untrack(() => void context.load(id));
	});

	$effect(() => context.listen());

	onDestroy(() => context.destroy());

	function sameOriginReferrer(): URL | null {
		try {
			const referrer = new URL(document.referrer);
			return referrer.origin === location.origin ? referrer : null;
		} catch {
			return null;
		}
	}

	function isOriginCandidate(url: URL): boolean {
		return !isBookArea(url.pathname) && !isBookChildFlow(url.pathname);
	}

	// The origin is the last page outside the book area. The reader and the
	// editor are child flows and never replace it. Tabs and previous/next
	// replace the history entry, so while only those happen the entry before
	// the current one is still the origin and history.back() can restore it.
	afterNavigate(({ from, type }) => {
		const length = history.length;
		// AfterNavigate has no replace flag: a push changes history.length.
		const pushed = historyLength !== null && length !== historyLength;
		historyLength = length;
		if (from) {
			if (isBookChildFlow(from.url.pathname)) {
				directFromOrigin = false;
			} else if (isBookArea(from.url.pathname)) {
				if (type === 'popstate' || pushed) directFromOrigin = false;
			} else {
				rememberBookOrigin(from.url.pathname + from.url.search);
				directFromOrigin = type !== 'popstate';
			}
		} else {
			const referrer = sameOriginReferrer();
			if (referrer && isOriginCandidate(referrer)) {
				rememberBookOrigin(referrer.pathname + referrer.search);
				directFromOrigin = length > 1;
			} else {
				directFromOrigin = false;
			}
		}
		origin = readBookOrigin();
	});
</script>

<svelte:head>
	{#if context.book}<title>{context.book.title} · {tabLabel}</title>{/if}
</svelte:head>

{#if context.error}
	<div class="space-y-4" role="alert">
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{context.error}</p>
		<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => context.reload()}>{m['catalog.retry']()}</button>
		<a class="underline underline-offset-4 focus-visible:outline-2" href="/libraries">{m['catalog.back_to_libraries']()}</a>
	</div>
{:else}
	<div class="space-y-6">
		{#if routeBookID !== null}
			<BookTabs bookId={routeBookID} {origin} {directFromOrigin} />
		{/if}
		{#if context.book && context.bookId === routeBookID}
			{@render children()}
		{:else}
			<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
		{/if}
	</div>
{/if}
