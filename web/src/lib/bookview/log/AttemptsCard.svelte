<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import Icon from '../Icon.svelte';
	import { formatDate, formatDuration } from '../format.js';
	import type { Attempt } from '../log-api.js';
	import { attemptMarkerClass, attemptTitle } from './cycle-labels.js';

	let { bookId, attempts }: { bookId: number; attempts: readonly Attempt[] } = $props();
	const locale = $derived(getLocale());
	// The API returns cycles newest first; the card focuses on the current one.
	const latest = $derived(attempts[0] ?? null);
</script>

<section class="min-w-0 card p-5" aria-labelledby="bv8-attempts-heading">
	<div class="flex items-start justify-between gap-2">
		<h2 id="bv8-attempts-heading" class="text-xs font-semibold uppercase tracking-wider text-slate-500">{m['bv8.attempts']({ count: attempts.length })}</h2>
		<a href={`/books/${bookId}/activities/cycles`} aria-label={m['bv8.cycles_open']()} title={m['bv8.cycles_open']()}
			class="-mr-1.5 -mt-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-emerald-700">
			<Icon name="maximize" class="size-4" />
		</a>
	</div>
	{#if latest === null}
		<p class="mt-4 text-sm text-slate-500">{m['bv8.attempts_empty']()}</p>
	{:else}
		<div class="relative mt-5 ml-1 border-l border-slate-200 pb-1 pl-5">
			<span aria-hidden="true" class={`absolute -left-[5px] top-1 size-2.5 rounded-full border-2 ${attemptMarkerClass(latest.status)}`}></span>
			<p class="text-sm font-semibold text-slate-800">{attemptTitle(latest)}</p>
			<p class="mt-1 text-xs text-slate-500">{m['bv8.attempt_range']({ start: formatDate(latest.started_at, locale), end: formatDate(latest.ended_at, locale) })}</p>
			<p class="mt-1 text-xs text-slate-600">{m['bv8.attempt_details']({ sessions: latest.sessions, duration: formatDuration(latest.seconds) })}</p>
			<div class="mt-2 flex flex-wrap gap-1">
				{#each latest.sources as source (source)}
					<span class="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600">{source.toUpperCase()}</span>
				{/each}
			</div>
		</div>
	{/if}
</section>
