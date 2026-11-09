<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { BOOKHEAP_CHANGED_EVENT } from '#lib/bookheap/events.js';
	import { countBooks } from './api.js';
	import { BOOKS_CHANGED_EVENT } from './events.js';

	interface Props {
		pathname: string;
	}

	let { pathname }: Props = $props();

	/**
	 * Count of every book visible to the viewer for the sidebar All Books entry. Loads in the
	 * background and renders nothing while unknown (loading or error), so it never blocks the sidebar.
	 */
	let count = $state<number | null>(null);
	let version = 0;
	let controller: AbortController | null = null;
	let mounted = false;

	async function load() {
		const current = ++version;
		controller?.abort();
		const request = new AbortController();
		controller = request;
		try {
			const value = await countBooks(request.signal);
			if (current === version) count = value;
		} catch {
			if (current === version) count = null;
		}
	}

	let onBooks = false;
	$effect(() => {
		const next = pathname === '/books';
		if (next && !onBooks && mounted) void load();
		onBooks = next;
	});

	onMount(() => {
		mounted = true;
		void load();
		const changed = () => void load();
		window.addEventListener(BOOKS_CHANGED_EVENT, changed);
		window.addEventListener(BOOKHEAP_CHANGED_EVENT, changed);
		return () => {
			mounted = false;
			version += 1;
			controller?.abort();
			window.removeEventListener(BOOKS_CHANGED_EVENT, changed);
			window.removeEventListener(BOOKHEAP_CHANGED_EVENT, changed);
		};
	});
</script>

{#if count !== null}
	<span class="shell-count" data-testid="all-books-count" title={m['ux1.shelves.count']({ count })}>
		<span aria-hidden="true">{count}</span>
		<span class="sr-only">{m['ux1.shelves.count']({ count })}</span>
	</span>
{/if}
