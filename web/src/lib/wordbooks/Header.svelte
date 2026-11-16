<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import SearchField from '#lib/search/SearchField.svelte';
	import ViewToggle from '#lib/catalog/ViewToggle.svelte';
	import HeaderMenu from '#lib/shell/HeaderMenu.svelte';
	import { Settings, ArrowDownUp, Trash2, ArrowLeft } from '@lucide/svelte';
	import { filterControlClass, iconControlClass, primaryIconControlClass } from '#lib/catalog/filter-styles.js';
	import type { Category, EntrySort, EntryView, WordbookSort, WordbookStatus } from './management.js';

	let { category = $bindable<Category>('wordbooks'), keyword = $bindable(''), sort, view,
		inside = false, wordbookSort = $bindable<WordbookSort>('recent'), status = $bindable<WordbookStatus>('active'),
		disabled = false, canDelete = false, importDisabled = false, onchange, onoverviewchange, oncreate, onsettings, ondelete, onback, onimport, onexport }: {
		category?: Category; keyword?: string; sort: EntrySort; view: EntryView;
		wordbookSort?: WordbookSort; status?: WordbookStatus; onoverviewchange: () => void;
		inside?: boolean; disabled?: boolean;
		onchange: (view: EntryView, sort: EntrySort) => void; oncreate: () => void;
		onsettings: () => void; ondelete: () => void; onback: () => void;
		onimport: (event: Event) => void; onexport: () => void;
		canDelete?: boolean; importDisabled?: boolean;
	} = $props();
	let importInput = $state<HTMLInputElement | null>(null);
	const transferLabel = $derived(`${m['wordbooks.import']()} / ${m['wordbooks.export']()}`);
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
		<div class="flex items-center gap-2">
			<button type="button" class={iconControlClass} aria-label={m['wordbooks.settings']()} title={m['wordbooks.settings']()} {disabled} onclick={onsettings}>
				<Settings aria-hidden="true" class="size-5" />
			</button>
			<HeaderMenu menuId="wordbook-transfer" popup="menu" label={transferLabel} panelClass="shelf-actions-menu">
				{#snippet trigger({ expanded, controls, popup, toggle, onkeydown })}
					<button type="button" class={iconControlClass} aria-label={transferLabel} title={transferLabel} aria-haspopup={popup} aria-expanded={expanded} aria-controls={controls} {disabled} onclick={toggle} {onkeydown}>
						<ArrowDownUp aria-hidden="true" class="size-5" />
					</button>
				{/snippet}
				{#snippet children(close)}
					<button type="button" role="menuitem" tabindex="-1" class="header-menu-item" class:opacity-50={importDisabled} aria-disabled={importDisabled} onclick={() => { if (!importDisabled) { importInput?.click(); void close(); } }}>{m['wordbooks.import']()}</button>
					<button type="button" role="menuitem" tabindex="-1" class="header-menu-item" onclick={() => { void close(); onexport(); }}>{m['wordbooks.export']()}</button>
				{/snippet}
			</HeaderMenu>
			<input bind:this={importInput} type="file" accept=".json,application/json" aria-label={m['wordbooks.import']()} disabled={disabled || importDisabled} onchange={onimport} hidden />
			<button type="button" class={iconControlClass} aria-label={m['wordbooks.deleteBook']()} title={m['wordbooks.deleteBook']()} disabled={disabled || !canDelete} onclick={ondelete}>
				<Trash2 aria-hidden="true" class="size-5" />
			</button>
			<button type="button" class={iconControlClass} aria-label={m['wordbooks.back']()} title={m['wordbooks.back']()} {disabled} onclick={onback}>
				<ArrowLeft aria-hidden="true" class="size-5" />
			</button>
		</div>
	{/if}
	{#if !inside}
	<button type="button" class="{primaryIconControlClass} ml-auto" aria-label={m['wordbooks.new']()} title={m['wordbooks.new']()} {disabled} onclick={oncreate}>
		<svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v16M4 12h16" /></svg>
	</button>
	{/if}
</div>
