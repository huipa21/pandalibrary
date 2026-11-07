<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import BookTabs, { bookTabFromPath, bookTabLabel } from '#lib/bookview/BookTabs.svelte';
	import { createBookContext, parseBookID, setBookContext } from '#lib/bookview/book-context.svelte.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const context = setBookContext(createBookContext());
	const routeID = $derived(page.params.id ?? '');
	const routeBookID = $derived(parseBookID(routeID));
	const tabLabel = $derived(bookTabLabel(bookTabFromPath(page.url.pathname)));
	let backUsesHistory = $state(false);
	let entered = false;

	$effect(() => {
		const id = routeID;
		untrack(() => void context.load(id));
	});

	$effect(() => context.listen());

	onDestroy(() => context.destroy());

	function inBookArea(pathname: string): boolean {
		return /^\/books\/[^/]+(?:\/|$)/.test(pathname);
	}

	function sameOriginReferrer(): URL | null {
		try {
			const referrer = new URL(document.referrer);
			return referrer.origin === location.origin ? referrer : null;
		} catch {
			return null;
		}
	}

	// Tabs and previous/next replace the history entry, so the entry before the
	// tab area is the in-app list the user came from (when there is one).
	afterNavigate(({ from }) => {
		if (entered) return;
		entered = true;
		const previous = from?.url ?? sameOriginReferrer();
		backUsesHistory = previous !== null && !inBookArea(previous.pathname) && history.length > 1;
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
			<BookTabs bookId={routeBookID} {backUsesHistory} />
		{/if}
		{#if context.book && context.bookId === routeBookID}
			{@render children()}
		{:else}
			<p class="text-slate-600" role="status">{m['catalog.loading']()}</p>
		{/if}
	</div>
{/if}
