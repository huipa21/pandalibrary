<script lang="ts">
	import type { Component } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getPdfReaderContext } from '../context.js';
	import Sidebar from '../../frame/ReaderSidebar.svelte';
	import type { SidebarTab } from './sidebar-state.svelte.js';

	let { ready }: { ready: boolean } = $props();
	const ctx = getPdfReaderContext();
	const controller = ctx.controller;
	const loaders: Record<SidebarTab, () => Promise<{ default: Component }>> = {
		toc: () => import('./toc/TocTab.svelte'),
		pages: () => import('./pages/PagesTab.svelte'),
		annotations: () => import('./annotations/AnnotationsTab.svelte'),
		bookmarks: () => import('./bookmarks/BookmarksTab.svelte')
	};
	const count = $derived(
		controller.highlights.filter((row) => row.book_file_id === controller.file?.id).length + controller.pageAnnotations.length
	);

	function failed(error: unknown) {
		console.error('Could not load the sidebar tab', error);
		return m['reader.error.render']();
	}
</script>

<Sidebar sidebar={ctx.sidebar} {count}>
	{#snippet children(tab)}
		{#if ready}
			{#await loaders[tab]() then module}
				<module.default />
			{:catch error}
				<p class="pv-sidebar-placeholder" role="alert">{failed(error)}</p>
			{/await}
		{/if}
	{/snippet}
</Sidebar>
