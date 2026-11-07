<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { BookFile } from '#lib/catalog/types.js';
	import { formatTone, sortedFormats } from './cover.js';

	let { files, size = 'sm' }: { files: readonly BookFile[]; size?: 'xs' | 'sm' } = $props();
	const formats = $derived(sortedFormats(files));
	const label = $derived(m['bv3.format_list']({ formats: formats.map((format) => format.toUpperCase()).join(', ') }));
</script>

{#if formats.length}
	<span
		class={`inline-flex max-w-full items-center gap-1 rounded-full font-bold shadow-sm ${size === 'xs' ? 'px-1.5 py-0.5 text-[0.6rem]' : 'px-2 py-1 text-xs'} ${formatTone(formats[0])}`}
		role="img"
		aria-label={label}
		title={label}
	>
		<span class="truncate" aria-hidden="true">{formats[0].toUpperCase()}</span>
		{#if formats.length > 1}<span aria-hidden="true">+{formats.length - 1}</span>{/if}
	</span>
{/if}
