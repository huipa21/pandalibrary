<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { BoundedPoller } from '#lib/admin/poller.js';
	import { notifyBooksChanged } from '#lib/catalog/events.js';
	import { listHeapItems } from './api.js';
	import { BOOKHEAP_CHANGED_EVENT, BOOKHEAP_PROGRESS_EVENT } from './events.js';

	/**
	 * Total Bookheap items, independent of the page's search and status filters.
	 * Loads in the background without blocking the sidebar.
	 */
	let count = $state<number | null>(null);
	let version = 0;
	let controller: AbortController | null = null;
	const poller = new BoundedPoller(() => load(true), { intervalMs: 3000, maxTicks: 200 });

	async function load(progress = false): Promise<boolean> {
		const current = ++version;
		controller?.abort();
		const request = new AbortController();
		controller = request;
		try {
			// Read in lifecycle order so a queued -> importing transition cannot escape both checks.
			const queued = await listHeapItems({ limit: 1, status: 'queued', signal: request.signal });
			const importing = await listHeapItems({ limit: 1, status: 'importing', signal: request.signal });
			// Read the total last so a completed import cannot leave a stale count when polling stops.
			const page = await listHeapItems({ limit: 1, signal: request.signal });
			if (current !== version) return false;
			const previous = count;
			count = page.total;
			if (progress) {
				window.dispatchEvent(new Event(BOOKHEAP_PROGRESS_EVENT));
			}
			if ((previous !== null && previous > count) || (progress && queued.total + importing.total === 0)) {
				window.dispatchEvent(new Event('pandalibrary-shelves-changed'));
				notifyBooksChanged();
			}
			return queued.total + importing.total > 0;
		} catch (error) {
			if (current === version && !request.signal.aborted) {
				console.error('Could not load the Bookheap count', error);
				count = null;
			}
			return progress && current === version && !request.signal.aborted;
		}
	}

	onMount(() => {
		let mounted = true;
		const changed = () => {
			void load().then((active) => {
				if (mounted && active) poller.start();
			});
		};
		changed();
		window.addEventListener(BOOKHEAP_CHANGED_EVENT, changed);
		return () => {
			mounted = false;
			version += 1;
			controller?.abort();
			poller.stop();
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
