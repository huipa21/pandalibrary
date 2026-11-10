<script lang="ts">
	import { tick, type Component } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { getPdfReaderContext } from '../context.js';
	import SidebarRail, { PANEL_ID, TAB_META, tabId } from './SidebarRail.svelte';
	import type { SidebarTab } from './sidebar-state.svelte.js';
	import '../../toolbar/toolbar.css';
	import './sidebar.css';

	/** `ready` is false until the PDF engine is attached; tab content reads `ctx.engine`. */
	let { ready }: { ready: boolean } = $props();
	const ctx = getPdfReaderContext();
	const sidebar = ctx.sidebar;
	const controller = ctx.controller;
	let panel = $state<HTMLElement>();
	// Lazy: a tab never opened is never loaded. The active tab stays mounted (hidden) while collapsed.
	const loaders: Record<SidebarTab, () => Promise<{ default: Component }>> = {
		toc: () => import('./toc/TocTab.svelte'),
		pages: () => import('./pages/PagesTab.svelte'),
		annotations: () => import('./annotations/AnnotationsTab.svelte'),
		bookmarks: () => import('./bookmarks/BookmarksTab.svelte')
	};
	let mounted = $state<SidebarTab | null>(null);
	const count = $derived(
		controller.highlights.filter((row) => row.book_file_id === controller.file?.id).length + controller.pageAnnotations.length
	);

	$effect(() => {
		if (sidebar.open) mounted = sidebar.tab;
	});

	// Overlay mode: a press on the page collapses the panel.
	$effect(() => {
		if (sidebar.docked || !sidebar.open) return;
		const ondown = (event: PointerEvent) => {
			if (event.target instanceof Element && event.target.closest('#reader-surface')) sidebar.collapse();
		};
		window.addEventListener('pointerdown', ondown, true);
		return () => window.removeEventListener('pointerdown', ondown, true);
	});

	function focusTab() {
		document.getElementById(tabId(sidebar.tab))?.focus();
	}

	function collapse() {
		sidebar.collapse();
		if (!sidebar.open) focusTab();
	}

	function select(tab: SidebarTab) {
		sidebar.toggle(tab);
		if (sidebar.open && !sidebar.docked) void tick().then(() => panel?.focus({ preventScroll: true }));
	}

	function failed(error: unknown) {
		console.error('Could not load the sidebar tab', error);
		return m['reader.error.render']();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || event.defaultPrevented || !sidebar.open) return;
		event.preventDefault();
		collapse();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions: Escape from any focused control inside collapses the panel -->
<div class="pv-sidebar" data-docked={sidebar.docked} {onkeydown}>
	<SidebarRail tab={sidebar.tab} open={sidebar.open} {count} onselect={select} />
	<div
		bind:this={panel}
		id={PANEL_ID}
		class="pv-sidebar-panel"
		role="tabpanel"
		aria-labelledby={tabId(sidebar.tab)}
		tabindex="-1"
		hidden={!sidebar.open}
	>
		<header class="pv-sidebar-header">
			<h2>{TAB_META[sidebar.tab].label()}</h2>
			<button type="button" class="pv4-button" aria-label={m['rp4.collapse']()} title={m['rp4.collapse']()} onclick={collapse}>
				<Icon name="chevrons-left" />
			</button>
		</header>
		<div class="pv-sidebar-body" data-tab={mounted}>
			{#if ready && mounted}
				{#await loaders[mounted]() then module}
					<module.default />
				{:catch error}
					<p class="pv-sidebar-placeholder" role="alert">{failed(error)}</p>
				{/await}
			{/if}
		</div>
	</div>
</div>
