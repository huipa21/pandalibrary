<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import type { BulkKind, BulkOutcome } from './results.js';

	let { kind, outcome }: { kind: BulkKind; outcome: BulkOutcome } = $props();
</script>

<div class="mt-3 space-y-3" data-testid="bh4-bulk-results">
	<p class="text-sm" role="status">
		{kind === 'assign'
			? m['bh4.assign.result']({ ok: outcome.succeeded.length, failed: outcome.failures.length })
			: m['bh4.delete.result']({ ok: outcome.succeeded.length, failed: outcome.failures.length })}
	</p>
	{#if outcome.failures.length > 0}
		<ul class="max-h-60 space-y-1 overflow-y-auto rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900" aria-label={m['bh4.result.failures']()}>
			{#each outcome.failures as failure (failure.id)}
				<li><span class="font-medium">{failure.title}</span>: {translate(failure.messageKey)}</li>
			{/each}
		</ul>
	{/if}
</div>
