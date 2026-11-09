<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { OcrStatus } from './status.js';

	let { status }: { status: OcrStatus } = $props();
</script>

{#if status.state !== 'idle'}
	<span role="status" aria-live="polite" class="inline-flex items-center gap-1 rounded-full bg-[var(--pv-chrome)] px-2 py-1 text-xs">
		{#if status.state === 'error'}
			<span title={status.error instanceof Error ? status.error.message : String(status.error)}>{m['pv6.failed']()}</span>
			<button class="underline focus-visible:outline-2" onclick={status.retry}>{m['pv6.retry']()}</button>
		{:else}
			<span aria-hidden="true" class="size-3 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"></span>
			{#if status.state === 'loading'}
				{m['pv6.loading']()}
			{:else}
				{m['pv6.recognizing']({ page: status.page, progress: Math.round(status.progress * 100) })}
			{/if}
		{/if}
	</span>
{/if}
