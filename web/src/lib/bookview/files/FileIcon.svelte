<script lang="ts">
	import { formatTone } from '../cover.js';
	import Icon from '../Icon.svelte';

	let { format, size = 'sm' }: { format: string; size?: 'sm' | 'lg' } = $props();
</script>

<div
	class={`relative flex shrink-0 flex-col items-center justify-center rounded-lg ${formatTone(format)} ${size === 'lg' ? 'h-24 w-20 gap-1' : 'h-14 w-12 gap-0.5'}`}
	aria-hidden="true"
>
	<Icon name="file" class={size === 'lg' ? 'size-9' : 'size-5'} />
	<span class={`max-w-full truncate px-1 font-bold uppercase ${size === 'lg' ? 'text-xs' : 'text-[0.55rem]'}`}>{format}</span>
</div>
