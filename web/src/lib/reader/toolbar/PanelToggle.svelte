<script lang="ts">
	import Icon from '#lib/bookview/Icon.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import './toolbar.css';
	let { open, count, ontoggle }: { open: boolean; count: number; ontoggle: () => void } = $props();
</script>

<button type="button" class="pv4-button" style:position="relative" aria-label={m['pv4.annotations']()} title={m['pv4.annotations']()} aria-expanded={open} onclick={ontoggle}>
	<Icon name="panel-right" />
	{#if count > 0}<span class="pv4-badge" aria-hidden="true">{count}</span>{/if}
</button>
