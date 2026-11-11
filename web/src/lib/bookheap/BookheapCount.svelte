<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { listHeapItems } from './api.js';
	import { BOOKHEAP_CHANGED_EVENT } from './events.js';

	/**
	 * Total Bookheap items, independent of the page's search and status filters.
	 * Loads in the background without blocking the sidebar.
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
			const page = await listHeapItems({ limit: 1, signal: request.signal });
			if (current === version) count = page.total;
		} catch (error) {
			if (current === version && !request.signal.aborted) {
				console.error('Could not load the Bookheap count', error);
				count = null;
			}
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

{#if count !== null}
	<span class="shell-count" data-testid="bh4-nav-count" title={m['bh4.nav.total_count']({ count })}>
		<span aria-hidden="true">{count}</span>
		<span class="sr-only">{m['bh4.nav.total_count']({ count })}</span>
	</span>
{/if}
