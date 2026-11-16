<script lang="ts">
	import { Volume2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	let { url }: { url: string | undefined } = $props();
	const safe = $derived(url?.startsWith('https://') ? url : null);

	function play() {
		if (!safe) return;
		try {
			void new Audio(safe).play().catch(() => {});
		} catch {
			// Audio playback is best effort; unsupported environments simply do nothing.
		}
	}
</script>

{#if safe}
	<button type="button" class="pronounce" aria-label={m['dict.play_pronunciation']()} title={m['dict.play_pronunciation']()} onclick={play}>
		<Volume2 size={14} aria-hidden="true" />
	</button>
{/if}

<style>
	.pronounce {
		display: inline-grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: #4b5563;
		cursor: pointer;
		vertical-align: middle;
	}
	.pronounce:hover { background: rgb(0 0 0 / 6%); }
	.pronounce:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
</style>
