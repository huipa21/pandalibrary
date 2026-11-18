<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatProgress } from './helpers.js';
	import './toolbar.css';
	let { fraction, page, pageCount }: { fraction: number; page?: number; pageCount?: number } = $props();
	const value = $derived(formatProgress(fraction, getLocale()));
	const currentPage = $derived(page ?? 0);
	const totalPages = $derived(pageCount ?? 0);
	const paginated = $derived(page !== undefined && totalPages > 1);
</script>

<span class="pv4-progress" class:pv4-page-progress={paginated} aria-label={paginated ? m['pv4.page_of']({ page: currentPage, pageCount: totalPages }) : m['pv4.progress']({ value })}>
	{#if paginated}{currentPage} / {totalPages}{:else}{value}{/if}
</span>
