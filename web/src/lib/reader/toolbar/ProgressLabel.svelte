<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatProgress } from './helpers.js';
	import './toolbar.css';
	let { fraction }: { fraction: number } = $props();
	const value = $derived(formatProgress(fraction, getLocale()));
</script>

<span class="pv4-progress" aria-label={m['pv4.progress']({ value })}>{value}</span>
