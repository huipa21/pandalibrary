<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import ToolbarMenu from './ToolbarMenu.svelte';
	import MenuItem from './MenuItem.svelte';
	let { onrotate, disabled = false }: { onrotate: (delta: -90 | 90) => void; disabled?: boolean } = $props();
</script>

<ToolbarMenu label={m['pv4.rotate']()} icon="rotate-cw" {disabled}>
	<MenuItem label={m['pv4.rotate_left']()} icon="rotate-ccw" onchoose={() => onrotate(-90)} />
	<MenuItem label={m['pv4.rotate_right']()} icon="rotate-cw" onchoose={() => onrotate(90)} />
</ToolbarMenu>
