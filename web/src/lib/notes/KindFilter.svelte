<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { filterControlClass } from '#lib/catalog/filter-styles.js';
	import { annotationKindFilter, type AnnotationKindFilter } from './entry.js';

	let { value, onchange }: { value: AnnotationKindFilter; onchange: (kind: AnnotationKindFilter) => void } = $props();
	const options = [
		{ value: '', label: m['notes.filter.all'] },
		{ value: 'review', label: m['notes.activity.review'] },
		{ value: 'comment', label: m['notes.activity.comment'] },
		{ value: 'highlight', label: m['notes.kind.highlight'] },
		{ value: 'underline', label: m['pv10.underline'] },
		{ value: 'strikeout', label: m['pv10.strikeout'] },
		{ value: 'text', label: m['pv10.text'] },
		{ value: 'ink', label: m['pv10.drawing'] },
		{ value: 'image', label: m['pv10.image'] }
	];
</script>

<select
	aria-label={m['notes.filter.label']()}
	class="{filterControlClass} min-w-40 max-w-full"
	{value}
	onchange={(event) => onchange(annotationKindFilter(event.currentTarget.value))}
>
	{#each options as option (option.value)}
		<option value={option.value}>{option.label()}</option>
	{/each}
</select>
