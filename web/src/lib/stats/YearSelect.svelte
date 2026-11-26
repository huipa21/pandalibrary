<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { filterControlClass } from '#lib/catalog/filter-styles.js';

	let {
		year,
		onchange,
		label = m['stats.reading.year'](),
		class: className = '',
		allLabel = ''
	}: {
		year: number | 'all';
		onchange: (year: number | 'all') => void;
		label?: string;
		class?: string;
		allLabel?: string;
	} = $props();
	const id = $props.id();
	const currentYear = new Date().getFullYear();
	const years = Array.from({ length: currentYear }, (_, index) => currentYear - index);
</script>

<label for={`${id}-year`} class="sr-only">{label}</label>
<select id={`${id}-year`} class="{filterControlClass} {className}" value={year}
	onchange={(event) => {
		const value = event.currentTarget.value;
		onchange(value === 'all' ? 'all' : Number(value));
	}}>
	{#if allLabel}<option value="all">{allLabel}</option>{/if}
	{#each years as option (option)}<option value={option}>{option}</option>{/each}
</select>
