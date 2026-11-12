<script lang="ts">
	import Icon from '#lib/bookview/Icon.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import ToolbarMenu from './ToolbarMenu.svelte';
	import MenuItem from './MenuItem.svelte';

	let { size, typography, disabled = false, onsize }: {
		size: number;
		typography: boolean;
		disabled?: boolean;
		onsize: (size: number) => void;
	} = $props();

	const percentages = [50, 75, 100, 125, 150, 175, 200];
	const label = $derived(typography ? m['rp2.size']() : m['pv4.zoom']());
	const decreaseLabel = $derived(typography ? m['rp2.decrease_size']() : m['pv4.zoom_out']());
	const increaseLabel = $derived(typography ? m['rp2.increase_size']() : m['pv4.zoom_in']());

	function changeSize(delta: -10 | 10) {
		onsize(Math.max(50, Math.min(200, size + delta)));
	}
</script>

<ToolbarMenu {label} {disabled} text={`${size}%`}>
	{#each percentages as percentage (percentage)}
		<MenuItem label={`${percentage}%`} role="menuitemradio" checked={size === percentage}
			onchoose={() => onsize(percentage)} />
	{/each}
	<div class="pv4-separator" role="separator"></div>
	<div class="pv4-steps" role="group" aria-label={label}>
		<button type="button" role="menuitem" class="pv4-button" data-pv4-keep-open
			aria-label={decreaseLabel} title={decreaseLabel} disabled={size <= 50}
			onclick={() => changeSize(-10)}><Icon name="zoom-out" /></button>
		<button type="button" role="menuitem" class="pv4-button" data-pv4-keep-open
			aria-label={increaseLabel} title={increaseLabel} disabled={size >= 200}
			onclick={() => changeSize(10)}><Icon name="zoom-in" /></button>
	</div>
</ToolbarMenu>
