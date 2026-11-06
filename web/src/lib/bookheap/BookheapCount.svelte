<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { listHeapItems } from './api.js';
	import { BOOKHEAP_CHANGED_EVENT } from './events.js';

	/**
	 * Count of `ready` Bookheap items for the sidebar entry. Loads in the background and renders
	 * nothing until (or unless) the count is known and non-zero, so it never blocks the sidebar.
	 */
	let count = $state<number | null>(null);
	let version = 0;
	let controller: AbortController | null = null;

	async function load() {
		const current = ++version;
		controller?.abort();
		const request = new AbortController();
		controller = request;
		try {
			const page = await listHeapItems({ status: 'ready', limit: 1, signal: request.signal });
			if (current === version) count = page.total;
		} catch {
			if (current === version) count = null;
		}
	}

	onMount(() => {
		void load();
		const changed = () => void load();
		window.addEventListener(BOOKHEAP_CHANGED_EVENT, changed);
		return () => {
			version += 1;
			controller?.abort();
			window.removeEventListener(BOOKHEAP_CHANGED_EVENT, changed);
		};
	});
</script>

{#if count}
	<span class="shell-count" data-testid="bh4-nav-count" title={m['bh4.nav.ready_count']({ count })}>
		<span aria-hidden="true">{count}</span>
		<span class="sr-only">{m['bh4.nav.ready_count']({ count })}</span>
	</span>
{/if}
