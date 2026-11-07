<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { formatPercent } from '../format.js';

	let { fraction }: { fraction: number } = $props();
	const percent = $derived(formatPercent(fraction));
	const length = $derived(Math.min(100, Math.max(0, fraction * 100)));
</script>

<svg viewBox="0 0 44 44" class="size-20 shrink-0" role="img" aria-label={m['bv7.read_percent']({ percent })}>
	<circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" stroke-width="4" class="text-slate-200" />
	<circle
		cx="22" cy="22" r="18" fill="none" stroke="currentColor" stroke-width="4"
		stroke-linecap="round" pathLength="100" stroke-dasharray={`${length} 100`}
		transform="rotate(-90 22 22)" class="text-emerald-600"
	/>
	<text x="22" y="24" text-anchor="middle" dominant-baseline="middle" class="fill-slate-800 text-[7px] font-semibold">{percent}</text>
</svg>
