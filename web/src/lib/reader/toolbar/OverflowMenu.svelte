<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import ToolbarMenu from './ToolbarMenu.svelte';
	let { children }: { children: Snippet } = $props();
</script>

<ToolbarMenu label={m['pv4.more']()} icon="more">{@render children()}</ToolbarMenu>
