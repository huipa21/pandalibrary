<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { BOOKS_CHANGED_EVENT } from '#lib/catalog/events.js';
	import { listPersonalActivity } from './activity.js';

	let { pathname }: { pathname: string } = $props();
	let count = $state<number | null>(null);
	let version = 0;
	let controller: AbortController | null = null;
	let mounted = $state(false);

	async function load() {
		const current = ++version;
		controller?.abort();
		const request = new AbortController();
		controller = request;
		try {
			const page = await listPersonalActivity({ limit: 1, signal: request.signal });
			if (current === version) count = page.total;
		} catch (error) {
			if (current === version && !request.signal.aborted) {
				console.error('Could not load the annotation count', error);
				count = null;
			}
		}
	}

	$effect(() => {
		pathname;
		if (mounted) untrack(() => void load());
	});

	onMount(() => {
		mounted = true;
		const changed = () => void load();
		window.addEventListener(BOOKS_CHANGED_EVENT, changed);
		window.addEventListener('focus', changed);
		return () => {
			mounted = false;
			version += 1;
			controller?.abort();
			window.removeEventListener(BOOKS_CHANGED_EVENT, changed);
			window.removeEventListener('focus', changed);
		};
	});
</script>

{#if count != null}
	<span class="shell-count" data-testid="annotations-count" title={m['notes.nav_count']({ count })}>
		<span aria-hidden="true">{count}</span>
		<span class="sr-only">{m['notes.nav_count']({ count })}</span>
	</span>
{/if}
