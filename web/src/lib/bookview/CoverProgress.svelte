<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { formatPercent } from './format.js';
	import type { ReadStatus } from './user-book.js';

	let { percentage, status }: { percentage: number | null; status: ReadStatus } = $props();
	const value = $derived(status === 'finished' ? 1 : percentage);
</script>

{#if value !== null && value > 0}
	{@const percent = formatPercent(value)}
	<div class="absolute inset-x-0 bottom-0 rounded-b-md bg-gradient-to-t from-black/70 to-transparent px-2 pt-6 pb-2">
		<div
			class="flex items-center gap-2"
			role="progressbar"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={Math.round(value * 100)}
			aria-label={m['bc4.progress']({ percent })}
		>
			<div class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/30" aria-hidden="true">
				<div class="h-full rounded-full bg-emerald-400" style:width={`${value * 100}%`}></div>
			</div>
			<span class="text-[11px] font-semibold text-white tabular-nums" aria-hidden="true">{percent}</span>
		</div>
	</div>
{/if}
