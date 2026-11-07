<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatDuration } from '../format.js';
	import type { ReadingSummary, DayRecord } from '../log-api.js';
	import { formatCalendarDay } from './log-model.js';

	let { summary }: { summary: ReadingSummary } = $props();
	const locale = $derived(getLocale());

	function record(value: DayRecord | null): string {
		return value
			? m['bv8.record_date']({ duration: formatDuration(value.seconds), date: formatCalendarDay(value.date, locale) })
			: m['bv8.no_data']();
	}

	const rows = $derived([
		{ label: m['bv8.longest_session'](), value: record(summary.records.longest_session) },
		{ label: m['bv8.best_day'](), value: record(summary.records.best_day) },
		{ label: m['bv8.longest_streak'](), value: m['bv8.streak_days']({ days: summary.records.longest_streak_days }) },
		{ label: m['bv8.reading_pace'](), value: summary.pace_percent_per_hour === null
			? m['bv8.no_data']()
			: m['bv8.pace_value']({ pace: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(summary.pace_percent_per_hour) }) }
	]);
</script>

<section class="min-w-0 rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="bv8-records-heading">
	<h2 id="bv8-records-heading" class="text-xs font-semibold uppercase tracking-wider text-slate-500">{m['bv8.records']()}</h2>
	<dl class="mt-4 space-y-4 text-sm">
		{#each rows as row (row.label)}
			<div class="space-y-1">
				<dt class="text-slate-500">{row.label}</dt>
				<dd class="font-medium text-slate-800">{row.value}</dd>
			</div>
		{/each}
	</dl>
</section>
