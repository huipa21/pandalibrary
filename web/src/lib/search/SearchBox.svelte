<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { normalizeSearchInput, SEARCH_QUERY_PARAM, searchPageHref } from './api.js';
	import SearchField from './SearchField.svelte';

	const activeQuery = $derived(
		page.url.pathname === '/search' ? normalizeSearchInput(page.url.searchParams.get(SEARCH_QUERY_PARAM)) : ''
	);
	let draft = $state('');
	let input = $state<HTMLInputElement | null>(null);
	let returnPage: { href: string; x: number; y: number } | null = null;
	let scrollRestore: ResizeObserver | null = null;

	function stopScrollRestore() {
		scrollRestore?.disconnect();
		scrollRestore = null;
	}

	onDestroy(stopScrollRestore);

	beforeNavigate(({ from, to }) => {
		stopScrollRestore();
		if (from && from.url.pathname !== '/search' && to?.url.pathname === '/search') {
			returnPage = {
				href: `${from.url.pathname}${from.url.search}${from.url.hash}`,
				x: window.scrollX,
				y: window.scrollY
			};
		}
	});

	$effect(() => {
		const current = activeQuery;
		untrack(() => {
			draft = current;
		});
	});

	const showClear = $derived(activeQuery !== '' && normalizeSearchInput(draft) === activeQuery);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const next = normalizeSearchInput(draft);
		if (!next) {
			if (activeQuery) await clear();
			return;
		}
		if (next === activeQuery) return;
		await goto(searchPageHref(next));
	}

	async function clear() {
		const destination = returnPage ?? { href: '/', x: 0, y: 0 };
		await goto(destination.href, { reset: false });
		await tick();
		draft = '';
		// Book lists load after navigation, so wait for enough content to restore the position.
		scrollRestore = new ResizeObserver(() => {
			window.scrollTo(destination.x, destination.y);
			if (window.scrollX === destination.x && window.scrollY === destination.y) stopScrollRestore();
		});
		scrollRestore.observe(document.body);
		window.scrollTo(destination.x, destination.y);
		input?.focus({ preventScroll: true });
	}
</script>

<svelte:window onwheel={stopScrollRestore} ontouchstart={stopScrollRestore} onkeydown={stopScrollRestore} />

<form role="search" aria-label={m['search.landmark']()} class="flex min-w-0 items-center gap-2" action="/search" method="GET" onsubmit={submit}>
	<SearchField
		id="app-search"
		name={SEARCH_QUERY_PARAM}
		class="w-[12.75rem] shrink sm:w-[16.75rem]"
		label={m['search.label']()}
		placeholder={m['search.placeholder']()}
		bind:value={draft}
		bind:input
		clear={showClear}
		onclear={clear}
	/>
</form>