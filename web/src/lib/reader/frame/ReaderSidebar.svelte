<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import SidebarRail, { PANEL_ID, TAB_META, tabId } from '../pdf/sidebar/SidebarRail.svelte';
	import { SIDEBAR_TABS, type SidebarState, type SidebarTab } from '../pdf/sidebar/sidebar-state.svelte.js';
	import '../toolbar/toolbar.css';
	import '../pdf/sidebar/sidebar.css';

	let { sidebar, count, tabs = SIDEBAR_TABS, children }: {
		sidebar: Omit<SidebarState, 'dispose'>;
		count: number;
		tabs?: readonly SidebarTab[];
		children: Snippet<[SidebarTab]>;
	} = $props();
	let panel = $state<HTMLElement>();
	let mounted = $state<SidebarTab | null>(null);

	$effect(() => {
		if (sidebar.open) mounted = sidebar.tab;
	});

	$effect(() => {
		if (sidebar.docked || !sidebar.open) return;
		const ondown = (event: PointerEvent) => {
			if (event.target instanceof Element && event.target.closest('#reader-surface')) sidebar.collapse();
		};
		window.addEventListener('pointerdown', ondown, true);
		return () => window.removeEventListener('pointerdown', ondown, true);
	});

	function collapse() {
		sidebar.collapse();
		if (!sidebar.open) document.getElementById(tabId(sidebar.tab))?.focus();
	}

	function select(tab: SidebarTab) {
		sidebar.toggle(tab);
		if (sidebar.open && !sidebar.docked) void tick().then(() => panel?.focus({ preventScroll: true }));
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || event.defaultPrevented || !sidebar.open) return;
		event.preventDefault();
		collapse();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions: Escape from any focused control inside collapses the panel -->
<div class="pv-sidebar" data-docked={sidebar.docked} {onkeydown}>
	<SidebarRail tab={sidebar.tab} open={sidebar.open} {count} {tabs} onselect={select} />
	<div bind:this={panel} id={PANEL_ID} class="pv-sidebar-panel" role="tabpanel"
		aria-labelledby={tabId(sidebar.tab)} tabindex="-1" hidden={!sidebar.open}>
		<header class="pv-sidebar-header">
			<h2>{TAB_META[sidebar.tab].label()}</h2>
			<button type="button" class="pv4-button" aria-label={m['rp4.collapse']()} title={m['rp4.collapse']()} onclick={collapse}>
				<Icon name="chevrons-left" />
			</button>
		</header>
		<div class="pv-sidebar-body" data-tab={mounted}>
			{#if mounted}{@render children(mounted)}{/if}
		</div>
	</div>
</div>
