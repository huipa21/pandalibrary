<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { errorBox, focusRing } from '#lib/admin/ui.js';
	import { heapErrorKey } from './results.js';
	import type { ScanController } from './scan.svelte.js';

	let { controller }: { controller: ScanController } = $props();

	const scan = $derived(controller.scan);
</script>

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

<div class="mt-3 empty:mt-0" aria-live="polite" data-testid="bh4-scan-status">
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
