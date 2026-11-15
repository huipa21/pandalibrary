<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import SearchField from '#lib/search/SearchField.svelte';
	import ViewToggle from '#lib/catalog/ViewToggle.svelte';
	import BookDisplaySettings from '#lib/catalog/BookDisplaySettings.svelte';
	import { filterControlClass, iconControlClass, primaryIconControlClass } from '#lib/catalog/filter-styles.js';
	import type { Category, EntrySort, EntryView, WordbookSort, WordbookStatus } from './management.js';

	let { category = $bindable<Category>('wordbooks'), keyword = $bindable(''), sort, view,
		inside = false, wordbookSort = $bindable<WordbookSort>('recent'), status = $bindable<WordbookStatus>('active'),
		settingsOpen, size = $bindable(208), spacing = $bindable(20), disabled = false, onchange, onoverviewchange, onsettings, oncreate }: {
		category?: Category; keyword?: string; sort: EntrySort; view: EntryView;
		wordbookSort?: WordbookSort; status?: WordbookStatus; onoverviewchange: () => void;
		inside?: boolean; settingsOpen: boolean; disabled?: boolean;
		size?: number; spacing?: number;
		onchange: (view: EntryView, sort: EntrySort) => void; onsettings: () => void; oncreate: () => void;
	} = $props();
</script>

<div class="flex flex-wrap items-center gap-2">
	<select class="{filterControlClass} shrink-0" aria-label={m['wordbooks.category']()} bind:value={category}>
		<option value="wordbooks">{m['wordbooks.category_wordbooks']()}</option>
		<option value="lexical">{m['wordbooks.category_lexical']()}</option>
		<option value="passages">{m['wordbooks.category_passages']()}</option>
	</select>
	<SearchField bind:value={keyword} class="min-w-36 flex-1" label={inside || category !== 'wordbooks' ? m['wordbooks.search_entries']() : m['wordbooks.search_wordbooks']()} onsearch={() => {}} />
	{#if inside}
		<select class={filterControlClass} aria-label={m['wordbooks.sort']()} value={sort} onchange={(event) => onchange(view, event.currentTarget.value as EntrySort)}>
			<option value="chronological">{m['wordbooks.chronological']()}</option>
			<option value="alphabetical">{m['wordbooks.alphabetical']()}</option>
		</select>
	{:else}
		<select class={filterControlClass} aria-label={m['wordbooks.sort']()} value={wordbookSort} onchange={(event) => { wordbookSort = event.currentTarget.value as WordbookSort; onoverviewchange(); }}>
			<option value="recent">{m['wordbooks.sort_recent']()}</option>
			<option value="created-asc">{m['wordbooks.sort_created_asc']()}</option>
			<option value="created-desc">{m['wordbooks.sort_created_desc']()}</option>
			<option value="name-asc">{m['wordbooks.sort_name_asc']()}</option>
			<option value="name-desc">{m['wordbooks.sort_name_desc']()}</option>
		</select>
		<select class={filterControlClass} aria-label={m['wordbooks.status']()} value={status} onchange={(event) => { status = event.currentTarget.value as WordbookStatus; onoverviewchange(); }}>
			<option value="all">{m['wordbooks.status_all']()}</option>
			<option value="active">{m['wordbooks.status_active']()}</option>
			<option value="archived">{m['wordbooks.archived']()}</option>
		</select>
	{/if}
	<ViewToggle view={view === 'cards' ? 'grid' : 'list'} onchange={(next) => onchange(next === 'grid' ? 'cards' : 'list', sort)} />
	{#if inside}
	<button type="button" class={iconControlClass} aria-label={m['wordbooks.display_settings']()} title={m['wordbooks.display_settings']()} aria-expanded={settingsOpen} onclick={onsettings}>
		<svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="white" /><circle cx="16" cy="12" r="2" fill="white" /><circle cx="8" cy="18" r="2" fill="white" /></svg>
	</button>
	{:else}
		<BookDisplaySettings storageKey="wordbooks" bind:size bind:spacing />
	{/if}
	<button type="button" class="{primaryIconControlClass} ml-auto" aria-label={m['wordbooks.new']()} title={m['wordbooks.new']()} {disabled} onclick={oncreate}>
		<svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v16M4 12h16" /></svg>
	</button>
</div>
