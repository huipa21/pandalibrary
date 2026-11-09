<script lang="ts">
	import Icon from '#lib/bookview/Icon.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import './toolbar.css';
	let { active, disabled = false, ontoggle }: { active: boolean; disabled?: boolean; ontoggle: () => void } = $props();
</script>

<button type="button" class="pv4-button" aria-label={m['pv4.insert']()} title={`${m['pv4.insert']()} (I)`} aria-pressed={active} {disabled} onclick={ontoggle}>
	<Icon name="insert" />
</button>
