<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatDate, formatDuration } from '../format.js';
	import type { Attempt, AttemptStatus } from '../log-api.js';

	let { attempts }: { attempts: readonly Attempt[] } = $props();
	const locale = $derived(getLocale());

	function statusLabel(status: AttemptStatus): string {
		switch (status) {
			case 'completed': return m['bv8.completed']();
			case 'in_progress': return m['bv8.in_progress']();
			case 'stopped': return m['bv8.stopped']();
		}
	}
</script>

<section class="min-w-0 rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="bv8-attempts-heading">
	<h2 id="bv8-attempts-heading" class="text-xs font-semibold uppercase tracking-wider text-slate-500">{m['bv8.attempts']({ count: attempts.length })}</h2>
	{#if attempts.length === 0}
		<p class="mt-4 text-sm text-slate-500">{m['bv8.attempts_empty']()}</p>
	{:else}
		<ol class="mt-5 max-h-80 space-y-5 overflow-y-auto pl-1">
			{#each attempts as attempt (attempt.number)}
				<li class="relative border-l border-slate-200 pb-1 pl-5">
					<span aria-hidden="true" class={`absolute -left-[5px] top-1 size-2.5 rounded-full border-2 ${
						attempt.status === 'completed' ? 'border-emerald-600 bg-emerald-600' :
						attempt.status === 'in_progress' ? 'border-emerald-600 bg-white' : 'border-slate-400 bg-slate-400'
					}`}></span>
					<p class="text-sm font-semibold text-slate-800">{m['bv8.attempt']({ number: attempt.number, status: statusLabel(attempt.status) })}</p>
					<p class="mt-1 text-xs text-slate-500">{m['bv8.attempt_range']({ start: formatDate(attempt.started_at, locale), end: formatDate(attempt.ended_at, locale) })}</p>
					<p class="mt-1 text-xs text-slate-600">{m['bv8.attempt_details']({ sessions: attempt.sessions, duration: formatDuration(attempt.seconds) })}</p>
					<div class="mt-2 flex flex-wrap gap-1">
						{#each attempt.sources as source (source)}
							<span class="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600">{source.toUpperCase()}</span>
						{/each}
					</div>
				</li>
			{/each}
		</ol>
	{/if}
	<a href="/stats" class="mt-5 inline-block text-sm font-medium text-emerald-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-emerald-700">{m['bv8.stats_link']()}</a>
</section>
