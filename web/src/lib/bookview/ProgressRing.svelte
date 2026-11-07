<script lang="ts">
	import { formatPercent } from './format.js';

	interface Props {
		/** Reading progress from 0 to 1; values outside the range are clamped. */
		fraction: number;
		/** Accessible name of the ring, for example "42% read". */
		label: string;
		size?: 'md' | 'lg';
		locale?: string;
	}

	let { fraction, label, size = 'md', locale }: Props = $props();
	const clamped = $derived(Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0);
	const percent = $derived(formatPercent(clamped, locale));
</script>

<div class="relative grid shrink-0 place-items-center {size === 'lg' ? 'size-32' : 'size-20'}" role="img" aria-label={label}>
	<svg class="absolute inset-0 size-full -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
		<circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" stroke-width={size === 'lg' ? 3 : 4}
			class={size === 'lg' ? 'text-slate-100' : 'text-slate-200'} />
		{#if clamped > 0}
			<circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" stroke-width={size === 'lg' ? 3 : 4}
				stroke-linecap="round" pathLength="100" stroke-dasharray={`${clamped * 100} 100`} class="text-emerald-600" />
		{/if}
	</svg>
	<span class={size === 'lg' ? 'text-3xl font-semibold text-slate-900' : 'text-sm font-semibold text-slate-800'} aria-hidden="true">{percent}</span>
</div>
