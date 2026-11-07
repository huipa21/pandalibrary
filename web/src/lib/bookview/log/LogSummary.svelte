<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import Icon from '../Icon.svelte';
	import ReadStatusMenu from '../ReadStatusMenu.svelte';
	import { formatDate, formatDuration, formatPercent, formatRelative } from '../format.js';
	import type { ReadingSummary } from '../log-api.js';
	import type { UserBook } from '../user-book.js';
	import ProgressRing from '../ProgressRing.svelte';
	import AddSessionDialog from './AddSessionDialog.svelte';

	interface Props {
		bookId: number;
		summary: ReadingSummary;
		userBook: UserBook | null;
	}

	let { bookId, summary, userBook }: Props = $props();
	let dialogOpen = $state(false);
	const locale = $derived(getLocale());
	const progress = $derived(Math.min(1, Math.max(0, summary.progress)));
	const pace = $derived(summary.pace_percent_per_hour === null
		? m['bv8.no_data']()
		: m['bv8.pace_value']({ pace: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(summary.pace_percent_per_hour) }));
	const rows = $derived([
		{ label: m['bv8.started'](), value: userBook?.started_at ? formatDate(userBook.started_at, locale) : m['bv8.not_set']() },
		{ label: m['bv8.finished'](), value: userBook?.finished_at ? formatDate(userBook.finished_at, locale) : m['bv8.not_set']() },
		{ label: m['bv8.total_time'](), value: formatDuration(summary.total_seconds) },
		{ label: m['bv8.sessions'](), value: new Intl.NumberFormat(locale).format(summary.sessions) },
		{ label: m['bv8.average_session'](), value: formatDuration(summary.average_seconds) },
		{ label: m['bv8.active_days'](), value: m['bv8.active_span']({ active: summary.active_days, span: summary.span_days }) },
		{ label: m['bv8.pace'](), value: pace },
		{ label: m['bv8.last_read'](), value: summary.last_read_at ? formatRelative(summary.last_read_at, new Date(), locale) : m['bv8.not_set']() }
	]);
</script>

<section class="min-w-0 rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="bv8-summary-heading">
	<h2 id="bv8-summary-heading" class="text-xs font-semibold uppercase tracking-wider text-slate-500">{m['bv8.summary']()}</h2>
	<div class="mt-5 flex flex-col items-center gap-3 text-center">
		<ProgressRing fraction={progress} size="lg" {locale} label={m['bv8.progress']({ percent: formatPercent(progress, locale) })} />
		<ReadStatusMenu {bookId} {userBook} variant="pill" />
		{#if summary.estimated_seconds_left !== null}
			<p class="text-sm text-slate-500">{m['bv8.estimate']({ duration: formatDuration(summary.estimated_seconds_left) })}</p>
		{/if}
	</div>
	<dl class="mt-6 space-y-3 border-t border-slate-100 pt-5 text-sm">
		{#each rows as row (row.label)}
			<div class="flex justify-between gap-4">
				<dt class="text-slate-500">{row.label}</dt>
				<dd class="text-right font-medium text-slate-800">{row.value}</dd>
			</div>
		{/each}
	</dl>
	<button type="button" class="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
		aria-haspopup="dialog" onclick={() => (dialogOpen = true)}>
		<Icon name="plus" class="size-4" /> {m['bv8.add_session']()}
	</button>
</section>

<AddSessionDialog open={dialogOpen} {bookId} onclose={() => (dialogOpen = false)} />
