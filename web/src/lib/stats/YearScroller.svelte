<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { filterControlClass } from '#lib/catalog/filter-styles.js';

	let { year, onchange }: { year: number; onchange: (year: number) => void } = $props();
	const id = $props.id();
	const currentYear = new Date().getFullYear();
	const years = Array.from({ length: currentYear }, (_, index) => currentYear - index);
	const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';
</script>

<div class="flex items-center gap-1">
	<button type="button" class="rounded-md p-2 hover:bg-slate-100 disabled:opacity-40 {focusRing}"
		aria-label={m['stats.reading.previous_year']()} disabled={year <= 1} onclick={() => onchange(year - 1)}>
		<span aria-hidden="true">&lsaquo;</span>
	</button>
	<label for={`${id}-year`} class="text-sm">{m['stats.reading.year']()}</label>
	<select id={`${id}-year`} class={filterControlClass} value={year} onchange={(event) => onchange(Number(event.currentTarget.value))}>
		{#each years as option (option)}<option value={option}>{option}</option>{/each}
	</select>
	<button type="button" class="rounded-md p-2 hover:bg-slate-100 disabled:opacity-40 {focusRing}"
		aria-label={m['stats.reading.next_year']()} disabled={year >= currentYear} onclick={() => onchange(year + 1)}>
		<span aria-hidden="true">&rsaquo;</span>
	</button>
</div>
