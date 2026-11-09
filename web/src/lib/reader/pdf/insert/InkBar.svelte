<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	let { color = $bindable('#111827'), width = $bindable(0.004), undo, done, count }: {
		color?: string; width?: number; undo(): void; done(): void; count: number;
	} = $props();
</script>
<div class="pv9-bar" role="toolbar" aria-label={m['pv9.draw']()}>
	<label>{m['pv9.color']()} <select bind:value={color}>
		{#each ['#111827', '#dc2626', '#2563eb', '#16a34a', '#ea580c', '#7c3aed'] as value}<option value={value}>{value}</option>{/each}
	</select></label>
	<label>{m['pv9.width']()} <select bind:value={width}>
		<option value={0.002}>{m['pv9.thin']()}</option><option value={0.004}>{m['pv9.medium']()}</option><option value={0.008}>{m['pv9.thick']()}</option>
	</select></label>
	<button onclick={undo} disabled={!count}>{m['pv9.undo']()}</button>
	<button onclick={done}>{m['pv9.done']()}</button>
</div>
