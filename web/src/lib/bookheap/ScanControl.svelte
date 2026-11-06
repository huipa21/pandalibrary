<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { errorBox, focusRing, secondaryButton } from '#lib/admin/ui.js';
	import { heapErrorKey } from './results.js';
	import type { ScanController } from './scan.svelte.js';

	let { controller }: { controller: ScanController } = $props();

	const scan = $derived(controller.scan);
</script>

<button
	type="button"
	class={`inline-flex items-center gap-2 ${secondaryButton}`}
	aria-disabled={controller.busy ? 'true' : undefined}
	onclick={() => {
		if (!controller.busy) void controller.start();
	}}
>
	{#if controller.busy}
		<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 animate-spin" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M10 3a7 7 0 1 0 7 7" stroke-linecap="round" />
		</svg>
		{m['bh4.scan.running']()}
	{:else}
		<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
			<path d="M4 10a6 6 0 0 1 10.2-4.2L16 7.5M16 3.5v4h-4M16 10a6 6 0 0 1-10.2 4.2L4 12.5M4 16.5v-4h4" />
		</svg>
		{m['bh4.scan.button']()}
	{/if}
</button>

{#snippet summary()}
	{#if scan}
		<ul class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="bh4-scan-summary">
			<li>{m['bh4.scan.added']({ count: scan.added })}</li>
			<li>{m['bh4.scan.updated']({ count: scan.updated })}</li>
			<li>{m['bh4.scan.removed']({ count: scan.removed })}</li>
			<li>{m['bh4.scan.duplicates']({ count: scan.duplicates })}</li>
			<li>{m['bh4.scan.invalid']({ count: scan.invalid })}</li>
			<li>{m['bh4.scan.skipped']({ count: scan.skipped })}</li>
			<li>{m['bh4.scan.in_progress']({ count: scan.in_progress })}</li>
		</ul>
	{/if}
{/snippet}

<div class="basis-full" aria-live="polite" data-testid="bh4-scan-status">
	{#if controller.state === 'running' || controller.state === 'starting'}
		<p class="text-sm text-slate-600">{m['bh4.scan.running_detail']()}</p>
	{:else if controller.state === 'completed'}
		<div class="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-950">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<p class="text-sm font-medium">{m['bh4.scan.completed']()}</p>
				<button type="button" class={`text-sm underline ${focusRing}`} onclick={() => controller.dismiss()}>{m['bh4.scan.dismiss']()}</button>
			</div>
			{@render summary()}
		</div>
	{:else if controller.state === 'failed'}
		<div class={errorBox} role="alert">
			<p>{m['bh4.scan.failed']()}{#if scan?.error}: {scan.error}{/if}</p>
			{@render summary()}
			<button type="button" class={`mt-1 underline ${focusRing}`} onclick={() => controller.start()}>{m['admin.retry']()}</button>
		</div>
	{:else if controller.state === 'error'}
		<div class={`flex flex-wrap items-center gap-3 ${errorBox}`} role="alert">
			<p>{translate(heapErrorKey(controller.error, 'scan'))}</p>
			<button type="button" class={`underline ${focusRing}`} onclick={() => controller.retry()}>{m['admin.retry']()}</button>
		</div>
	{:else if controller.state === 'stalled'}
		<div class="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="status">
			<p>{m['bh4.scan.stalled']()}</p>
			<button type="button" class={`underline ${focusRing}`} onclick={() => controller.retry()}>{m['bh4.scan.check_again']()}</button>
		</div>
	{/if}
</div>
