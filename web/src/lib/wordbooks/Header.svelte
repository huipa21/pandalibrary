<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import SearchField from '#lib/search/SearchField.svelte';
	import ViewToggle from '#lib/catalog/ViewToggle.svelte';
	import { filterControlClass, primaryIconControlClass } from '#lib/catalog/filter-styles.js';
	import type { Category, EntrySort, EntryView, WordbookSort, WordbookStatus } from './management.js';

	let { category = $bindable<Category>('wordbooks'), keyword = $bindable(''), sort, view,
		inside = false, wordbookSort = $bindable<WordbookSort>('recent'), status = $bindable<WordbookStatus>('active'),
		disabled = false, onchange, onoverviewchange, oncreate, onsettings }: {
		category?: Category; keyword?: string; sort: EntrySort; view: EntryView;
		wordbookSort?: WordbookSort; status?: WordbookStatus; onoverviewchange: () => void;
		inside?: boolean; disabled?: boolean;
		onchange: (view: EntryView, sort: EntrySort) => void; oncreate: () => void;
		onsettings: () => void;
	} = $props();
</script>

<div class="flex flex-wrap items-center gap-2">
	<select class="{filterControlClass} shrink-0" aria-label={m['wordbooks.category']()} bind:value={category}>
		<option value="wordbooks">{m['wordbooks.category_wordbooks']()}</option>
		<option value="lexical">{m['wordbooks.category_lexical']()}</option>
		<option value="passages">{m['wordbooks.category_passages']()}</option>
	</select>
	<SearchField bind:value={keyword} class="min-w-52 flex-1 sm:max-w-sm" label={inside || category !== 'wordbooks' ? m['wordbooks.search_entries']() : m['wordbooks.search_wordbooks']()} onsearch={() => {}} />
	{#if inside}
		<select class={filterControlClass} aria-label={m['wordbooks.sort']()} value={sort} onchange={(event) => onchange(view, event.currentTarget.value as EntrySort)}>
			<option value="chronological">{m['wordbooks.sort_created_desc']()}</option>
			<option value="chronological-asc">{m['wordbooks.sort_created_asc']()}</option>
			<option value="alphabetical">{m['wordbooks.sort_name_asc']()}</option>
			<option value="alphabetical-desc">{m['wordbooks.sort_name_desc']()}</option>
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
		<button type="button" class={filterControlClass} aria-label={m['wordbooks.settings']()} title={m['wordbooks.settings']()} {disabled} onclick={onsettings}>
			<svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 3-.6 2.4-2 .9-2.2-.7-2 3.4 1.7 1.7-.1 2.4L2 14.8l2 3.5 2.4-.7 2 .9L9 21h4l.6-2.5 2-.9 2.4.7 2-3.5-1.8-1.7-.1-2.4L20 9l-2-3.4-2.2.7-2-.9L13 3Z" /><circle cx="11" cy="12" r="3" /></svg>
		</button>
	{/if}
	{#if !inside}
	<button type="button" class="{primaryIconControlClass} ml-auto" aria-label={m['wordbooks.new']()} title={m['wordbooks.new']()} {disabled} onclick={oncreate}>
		<svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v16M4 12h16" /></svg>
	</button>
	{/if}
</div>
