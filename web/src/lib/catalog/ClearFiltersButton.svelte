<script lang="ts">
	import { iconButton } from '#lib/admin/ui.js';

	let { label, disabled = false, onclick }: { label: string; disabled?: boolean; onclick: () => void } = $props();
</script>

<button type="button" class={iconButton} aria-label={label} title={label} {disabled} {onclick}>
	<svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
		<path d="M13 4H3.5l6.5 7.5V19l3 1.5v-9l1-1.15" /><path d="m16 4 5 5M21 4l-5 5" />
	</svg>
</button>
