<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatDuration, formatPercent, formatRelative } from '../format.js';
	import { listBookSessions, type BookSession, type ReadingSummary } from '../log-api.js';

	let { bookId, summary }: { bookId: number; summary: ReadingSummary } = $props();
	let sessions = $state<BookSession[]>([]);
	let sessionsLoading = $state(false);
	let sessionsError = $state('');
	const days = $derived(summary.days.slice(-30));
	const bars = $derived([...Array.from({ length: Math.max(0, 30 - days.length) }, () => 0), ...days.map((day) => day.seconds)]);
	const maxBar = $derived(Math.max(1, ...bars));
	const chartTime = $derived(days.reduce((total, day) => total + day.seconds, 0));
	const number = $derived(new Intl.NumberFormat(getLocale()));

	$effect(() => {
		const id = bookId;
		const count = summary.sessions;
		summary.last_read_at;
		const controller = new AbortController();
		sessions = [];
		sessionsError = '';
		sessionsLoading = count > 0;
		if (count > 0) {
			void listBookSessions(id, { limit: 3, signal: controller.signal }).then(
				(page) => {
					if (controller.signal.aborted) return;
					sessions = page.items;
					sessionsLoading = false;
				},
				(cause: unknown) => {
					if (controller.signal.aborted) return;
					console.error('Could not load recent reading sessions', cause);
					sessionsError = m['bv6.sessions_error']();
					sessionsLoading = false;
				}
			);
		}
		return () => controller.abort();
	});
</script>

<section class="min-w-0 space-y-5 card p-5 sm:p-6" aria-labelledby="book-reading-heading">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="book-reading-heading" class="text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['bv6.reading']()}</h2>
		{#if summary.last_read_at}
			<p class="text-xs text-slate-500">{m['bv6.last_read']({ when: formatRelative(summary.last_read_at) })}</p>
		{/if}
	</div>
	{#if summary.sessions === 0}
		<p class="text-sm text-slate-500">{m['bv6.no_sessions']()}</p>
	{:else}
		<dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<div><dt class="text-xs text-slate-500">{m['bv6.sessions']()}</dt><dd class="mt-1 font-semibold text-slate-900">{number.format(summary.sessions)}</dd></div>
			<div><dt class="text-xs text-slate-500">{m['bv6.time']()}</dt><dd class="mt-1 font-semibold text-slate-900">{formatDuration(summary.total_seconds)}</dd></div>
			<div><dt class="text-xs text-slate-500">{m['bv6.average']()}</dt><dd class="mt-1 font-semibold text-slate-900">{formatDuration(summary.average_seconds)}</dd></div>
			<div><dt class="text-xs text-slate-500">{m['bv6.progress']()}</dt><dd class="mt-1 font-semibold text-slate-900">{formatPercent(summary.progress)}</dd></div>
		</dl>
		<div class="flex h-16 items-end gap-1" aria-hidden="true">
			{#each bars as seconds, index (index)}
				<span class="min-w-0 flex-1 rounded-t bg-emerald-500" style={`height: ${seconds > 0 ? Math.max(4, seconds / maxBar * 100) : 0}%`}></span>
			{/each}
		</div>
		<p class="sr-only">{m['bv6.chart_summary']({ days: number.format(days.length), time: formatDuration(chartTime) })}</p>
		{#if sessionsLoading}
			<p class="text-sm text-slate-500" role="status">{m['bv6.state_loading']()}</p>
		{:else if sessionsError}
			<p class="text-sm text-red-800" role="alert">{sessionsError}</p>
		{:else}
			<ul class="divide-y divide-slate-100">
				{#each sessions as session (session.id)}
					<li class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
						<span class="text-slate-700">{formatRelative(session.ended_at)}</span>
						<span class="flex flex-wrap items-center gap-2 text-slate-500">
							<span>{formatDuration(session.active_seconds)}</span>
							{#if session.end_percentage !== null}<span>{m['bv6.reached']({ progress: formatPercent(session.end_percentage) })}</span>{/if}
							<span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{session.source === 'web' ? m['bv6.source_web']() : m['bv6.source_koreader']()}</span>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
	<a class="inline-block text-sm font-semibold text-emerald-800 underline-offset-4 hover:underline" href={`/books/${bookId}/reading-log`}>{m['bv6.open_log']()}</a>
</section>
