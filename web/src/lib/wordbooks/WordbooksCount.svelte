<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { activeWordbookCount, WORDBOOKS_CHANGED_EVENT, wordbooks } from './api.js';

	let count = $state<number | null>(null);
	let version = 0;

	async function load() {
		const current = ++version;
		try {
			const books = await wordbooks.list();
			if (current === version) count = activeWordbookCount(books);
		} catch (cause) {
			if (current !== version) return;
			console.error('Could not load the Wordbooks count', cause);
			count = null;
		}
	}

	onMount(() => {
		void load();
		const changed = () => void load();
		window.addEventListener(WORDBOOKS_CHANGED_EVENT, changed);
		return () => {
			version += 1;
			window.removeEventListener(WORDBOOKS_CHANGED_EVENT, changed);
		};
	});
</script>

{#if count !== null}
	<span class="shell-count" data-testid="wordbooks-count" title={m['wordbooks.nav_count']({ count })}>
		<span aria-hidden="true">{count}</span>
		<span class="sr-only">{m['wordbooks.nav_count']({ count })}</span>
	</span>
{/if}
