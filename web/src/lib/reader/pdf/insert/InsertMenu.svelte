<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	let { x, y, offline, choose, cancel }: {
		x: number; y: number; offline: boolean;
		choose(kind: 'text' | 'ink' | 'image'): void; cancel(): void;
	} = $props();
	let menu: HTMLDivElement;
	onMount(() => menu.querySelector('button')?.focus());
</script>

<svelte:window onpointerdown={(event) => { if (!menu.contains(event.target as Node)) cancel(); }}
	onkeydown={(event) => {
		if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
			buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
		}
	}} />
<div bind:this={menu} class="pv9-menu" role="menu" style:left={`${Math.min(x, Math.max(4, innerWidth - 180))}px`} style:top={`${Math.min(y, Math.max(4, innerHeight - 150))}px`}>
	<button role="menuitem" onclick={() => choose('text')}>{m['pv9.text']()}</button>
	<button role="menuitem" onclick={() => choose('ink')}>{m['pv9.draw']()}</button>
	<span title={offline ? m['pv9.image_offline']() : undefined}>
		<button role="menuitem" disabled={offline} onclick={() => choose('image')}>{m['pv9.image']()}</button>
	</span>
	{#if offline}<small>{m['pv9.image_offline']()}</small>{/if}
</div>
<style>
	.pv9-menu { position: fixed; z-index: 100; width: 176px; padding: 4px; background: var(--pv-chrome, white); color: var(--shell-text, #111827); border: 1px solid #888; border-radius: 6px; box-shadow: 0 2px 8px #0003; }
	button { display: block; width: 100%; text-align: left; padding: 8px; }
	button:hover, button:focus-visible { background: #8883; }
	button:disabled { opacity: .5; }
	small { display: block; padding: 4px; }
</style>
