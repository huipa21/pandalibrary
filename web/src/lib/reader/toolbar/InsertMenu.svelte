<script module lang="ts">
	export type InsertType = 'text' | 'draw' | 'image';
</script>

<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import ToolbarMenu from './ToolbarMenu.svelte';
	import MenuItem from './MenuItem.svelte';

	let { open = $bindable(false), disabled = false, offline = false, onselect }: {
		open?: boolean;
		disabled?: boolean;
		offline?: boolean;
		onselect: (type: InsertType) => void;
	} = $props();
</script>

<ToolbarMenu label={m['pv4.insert']()} icon="insert" align="start" bind:open {disabled}>
	<MenuItem label={m['pv9.text']()} onchoose={() => onselect('text')} />
	<MenuItem label={m['pv9.draw']()} onchoose={() => onselect('draw')} />
	<span title={offline ? m['pv9.image_offline']() : undefined}>
		<MenuItem label={m['pv9.image']()} disabled={offline} onchoose={() => onselect('image')} />
	</span>
</ToolbarMenu>
