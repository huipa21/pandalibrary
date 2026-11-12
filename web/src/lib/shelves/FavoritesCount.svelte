<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getSystemShelf } from './api.js';

	let count = $state<number | null>(null);
	let version = 0;

	async function load() {
		const current = ++version;
		try {
			const shelf = await getSystemShelf('favorites');
			if (current === version) count = shelf.visible_book_count;
		} catch (cause) {
			if (current !== version) return;
			console.error('Could not load the Favorites count', cause);
			count = null;
		}
	}

	onMount(() => {
		void load();
		const changed = () => void load();
		window.addEventListener('pandalibrary-shelves-changed', changed);
		return () => {
			version += 1;
			window.removeEventListener('pandalibrary-shelves-changed', changed);
		};
	});
</script>

{#if count !== null}
	<span class="shell-count" title={m['ux1.shelves.count']({ count })}>
		<span aria-hidden="true">{count}</span>
		<span class="sr-only">{m['ux1.shelves.count']({ count })}</span>
	</span>
{/if}
