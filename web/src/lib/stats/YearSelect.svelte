<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { filterControlClass } from '#lib/catalog/filter-styles.js';

	let {
		year,
		onchange,
		label = m['stats.reading.year'](),
		class: className = ''
	}: {
		year: number;
		onchange: (year: number) => void;
		label?: string;
		class?: string;
	} = $props();
	const id = $props.id();
	const currentYear = new Date().getFullYear();
	const years = Array.from({ length: currentYear }, (_, index) => currentYear - index);
</script>

<label for={`${id}-year`} class="sr-only">{label}</label>
<select id={`${id}-year`} class="{filterControlClass} {className}" value={year}
	onchange={(event) => onchange(Number(event.currentTarget.value))}>
	{#each years as option (option)}<option value={option}>{option}</option>{/each}
</select>
