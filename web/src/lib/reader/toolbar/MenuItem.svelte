<script lang="ts">
	import Icon, { type IconName } from '#lib/bookview/Icon.svelte';
	let { label, icon, role = 'menuitem', checked, disabled = false, onchoose }: {
		label: string;
		icon?: IconName;
		role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
		checked?: boolean;
		disabled?: boolean;
		onchoose: () => void;
	} = $props();
</script>

<button type="button" class="pv4-item" {role} aria-checked={role === 'menuitem' ? undefined : checked} {disabled} onclick={onchoose}>
	{#if icon}<Icon name={icon} />{/if}
	<span class="pv4-item-label">{label}</span>
	{#if role !== 'menuitem'}
		<svg class="pv4-check" aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
			{#if checked}<path d="m4 10 4 4 8-8" />{/if}
		</svg>
	{/if}
</button>
