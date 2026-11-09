<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { OcrStatus } from './status.js';

	let { status }: { status: OcrStatus } = $props();
</script>

{#if status.state !== 'idle'}
	<span role="status" aria-live="polite" class="pv6-status inline-flex items-center gap-1 rounded-full bg-[var(--pv-chrome)] px-2 py-1 text-xs">
		{#if status.state === 'error'}
			<span class="pv6-message" title={status.error instanceof Error ? status.error.message : String(status.error)}>{m['pv6.failed']()}</span>
			<span class="pv6-compact" aria-hidden="true">OCR!</span>
			<button class="min-h-9 min-w-9 underline focus-visible:outline-2" onclick={status.retry}>{m['pv6.retry']()}</button>
		{:else}
			<span aria-hidden="true" class="size-3 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"></span>
			<span class="pv6-message">
				{#if status.state === 'loading'}
					{m['pv6.loading']()}
				{:else}
					{m['pv6.recognizing']({ page: status.page, progress: Math.round(status.progress * 100) })}
				{/if}
			</span>
			<span class="pv6-compact" aria-hidden="true">OCR</span>
		{/if}
	</span>
{/if}

<style>
	.pv6-compact { display: none; }
	@media (max-width: 639px) {
		.pv6-message {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
			border: 0;
		}
		.pv6-compact { display: inline; }
	}
	@media (max-width: 479px) {
		.pv6-status {
			position: absolute;
			top: calc(100% + 4px);
			left: 4px;
			z-index: 20;
			box-shadow: 0 2px 6px rgb(0 0 0 / 15%);
		}
	}
</style>
