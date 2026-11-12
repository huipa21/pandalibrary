<script lang="ts" module>
	import * as m from '#lib/paraglide/messages.js';
	import type { IconName } from '#lib/bookview/Icon.svelte';
	import { SIDEBAR_TABS, type SidebarTab } from './sidebar-state.svelte.js';

	export const TAB_META: Record<SidebarTab, { icon: IconName; label: () => string }> = {
		toc: { icon: 'list-tree', label: m['rp4.contents'] },
		pages: { icon: 'copy', label: m['rp4.pages'] },
		annotations: { icon: 'highlighter', label: m['rp4.annotations'] },
		bookmarks: { icon: 'bookmark', label: m['rp4.bookmarks'] },
		search: { icon: 'search', label: m['reader.search.title'] }
	};
	export const tabId = (tab: SidebarTab) => `pv-sidebar-tab-${tab}`;
	export const PANEL_ID = 'pv-sidebar-panel';
</script>

<script lang="ts">
	import Icon from '#lib/bookview/Icon.svelte';

	let { tab, open, count, tabs = SIDEBAR_TABS, onselect }: {
		tab: SidebarTab;
		open: boolean;
		count: number;
		tabs?: readonly SidebarTab[];
		onselect: (tab: SidebarTab) => void;
	} = $props();

	function onkeydown(event: KeyboardEvent) {
		const index = tabs.indexOf((event.target as HTMLElement).dataset.tab as SidebarTab);
		if (index < 0) return;
		const last = tabs.length - 1;
		const next = { ArrowUp: index ? index - 1 : last, ArrowDown: index === last ? 0 : index + 1, Home: 0, End: last }[event.key];
		if (next === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
		event.preventDefault();
		document.getElementById(tabId(tabs[next]))?.focus();
	}
</script>

<div class="pv-sidebar-rail" role="tablist" aria-orientation="vertical" aria-label={m['rp4.sidebar']()} tabindex="-1" {onkeydown}>
	{#each tabs as item (item)}
		{@const meta = TAB_META[item]}
		{@const selected = open && tab === item}
		<button
			type="button"
			role="tab"
			id={tabId(item)}
			class="pv-sidebar-tab"
			data-tab={item}
			aria-label={meta.label()}
			title={meta.label()}
			aria-selected={selected}
			aria-controls={selected ? PANEL_ID : undefined}
			tabindex={tab === item ? 0 : -1}
			onclick={() => onselect(item)}
		>
			<Icon name={meta.icon} />
			{#if item === 'annotations' && count > 0}
				<!-- Generated content keeps the count out of the tab's visible-text name (axe label-content-name-mismatch). -->
				<span class="pv-sidebar-badge" aria-hidden="true" data-count={count > 99 ? '99+' : count}></span>
			{/if}
		</button>
	{/each}
</div>
