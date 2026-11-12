<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';

	let { toolbar, children, notifications, title }: {
		toolbar: Snippet; children: Snippet; notifications?: Snippet; title: string;
	} = $props();
</script>

<svelte:head>
	<title>{title} · {m['common.app_name']()}</title>
</svelte:head>

<div class="pv-frame grid h-dvh min-w-0 grid-rows-[44px_minmax(0,1fr)_auto] overflow-hidden">
	<div class="pv-frame-toolbar flex min-w-0 items-center gap-1 px-2">
		{@render toolbar()}
	</div>
	<div class="pv-frame-surface relative min-h-0 min-w-0">
		{@render children()}
	</div>
	{#if notifications}{@render notifications()}{/if}
</div>

<style>
	.pv-frame {
		--pv-chrome: var(--shell-surface);
		color: var(--shell-text);
	}
	.pv-frame-toolbar {
		position: relative;
		z-index: 40;
		background: var(--pv-chrome);
	}
	.pv-frame-surface {
		isolation: isolate;
		background: var(--color-slate-200);
	}
	:global(:root[data-theme='dark']) .pv-frame-surface {
		background: var(--color-zinc-900);
	}
	.pv-frame :global(.reader-pdf-page) {
		box-shadow: 0 2px 8px rgb(0 0 0 / 15%);
	}
</style>
