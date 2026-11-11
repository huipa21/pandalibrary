<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '../Icon.svelte';
	import { controlButtonClass, controlIconClass, filterControlClass, iconControlClass } from '#lib/catalog/filter-styles.js';
	import SearchField from '#lib/search/SearchField.svelte';
	import { colorTone, MARK_SORTS, sortColorOptions, type ColorCount, type MarkSort } from './highlights-model.js';
	import { colorName } from './labels.js';
	import type { HighlightStyle } from '#lib/reader/types.js';
	import { styleLabel } from '#lib/reader/pdf/sidebar/annotations/labels.js';

	let {
		query,
		onQuery,
		notesCount,
		notesOnly = $bindable(),
		sort,
		onSort,
		colorOptions,
		colors,
		onToggleColor,
		styles,
		onToggleStyle,
		compact = $bindable(),
		offline,
		exporting,
		onExport
	}: {
		query: string;
		onQuery: (query: string) => void;
		notesCount: number;
		notesOnly: boolean;
		sort: MarkSort;
		onSort: (sort: MarkSort) => void;
		colorOptions: ColorCount[];
		colors: ReadonlySet<string>;
		onToggleColor: (color: string) => void;
		styles: ReadonlySet<HighlightStyle>;
		onToggleStyle: (style: HighlightStyle) => void;
		compact: boolean;
		offline: boolean;
		exporting: boolean;
		onExport: () => void;
	} = $props();

	const SEARCH_DELAY_MS = 200;
	const styleOptions: HighlightStyle[] = ['highlight', 'underline', 'strikeout'];
	const filterCount = $derived(colors.size + styles.size);
	const sortedColors = $derived(sortColorOptions(colorOptions));
	let draft = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let filtersOpen = $state(false);
	let filtersButton = $state<HTMLButtonElement | null>(null);
	let filtersPanel = $state<HTMLDivElement | null>(null);

	const sortLabels: Record<MarkSort, () => string> = {
		reading: m['bv9.sort_reading'],
		newest: m['bv9.sort_newest'],
		oldest: m['bv9.sort_oldest']
	};

	// External query changes (back/forward, clear filters) replace the draft.
	$effect(() => {
		const current = query;
		untrack(() => {
			if (current !== draft.trim()) {
				clearTimeout(timer);
				draft = current;
			}
		});
	});

	onDestroy(() => clearTimeout(timer));

	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(() => onQuery(draft.trim()), SEARCH_DELAY_MS);
	}

	function searchNow() {
		clearTimeout(timer);
		onQuery(draft.trim());
	}

	function closeFilters(restoreFocus: boolean) {
		filtersOpen = false;
		if (restoreFocus) filtersButton?.focus();
	}

	$effect(() => {
		if (!filtersOpen) return;
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && !filtersPanel?.contains(target) && !filtersButton?.contains(target)) closeFilters(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				closeFilters(true);
			}
		};
		window.addEventListener('pointerdown', onPointer);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('pointerdown', onPointer);
			window.removeEventListener('keydown', onKey);
		};
	});

	const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';
</script>

<div class="flex flex-wrap items-center gap-2">
	<form class="min-w-48 flex-1" role="search" onsubmit={(event) => { event.preventDefault(); searchNow(); }}>
		<SearchField
			label={m['bv9.search_label']()}
			placeholder={m['bv9.search_placeholder']()}
			bind:value={draft}
			oninput={onInput}
			clear={draft.trim() !== '' && draft.trim() === query}
			onclear={searchNow}
		/>
	</form>

	<button
		type="button"
		class={controlButtonClass}
		aria-pressed={notesOnly}
		title={m['bv9.notes_toggle_label']()}
		onclick={() => (notesOnly = !notesOnly)}
	>
		{m['bv9.notes_toggle']({ count: notesCount })}
	</button>

	<label class="sr-only" for="highlights-sort">{m['bv9.sort_label']()}</label>
	<select
		id="highlights-sort"
		class={filterControlClass}
		value={sort}
		onchange={(event) => onSort(event.currentTarget.value as MarkSort)}
	>
		{#each MARK_SORTS as option (option)}
			<option value={option}>{sortLabels[option]()}</option>
		{/each}
	</select>

	<div class="relative">
		<button
			bind:this={filtersButton}
			type="button"
			class={iconControlClass}
			data-active={filterCount > 0 ? '' : undefined}
			aria-expanded={filtersOpen}
			aria-controls="highlights-filters"
			aria-label={filterCount > 0 ? m['bv9.filters_active']({ count: filterCount }) : m['bv9.filters']()}
			title={m['bv9.filters']()}
			onclick={() => (filtersOpen = !filtersOpen)}
		>
			<svg aria-hidden="true" class={controlIconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16l-6 7.5V19l-4 1v-7.5z" /></svg>
		</button>
		{#if filtersOpen}
			<div
				bind:this={filtersPanel}
				id="highlights-filters"
				class="absolute right-0 z-20 mt-2 w-56 rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
			>
				<fieldset class="space-y-1">
					<legend class="mb-1 text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['pv10.styles']()}</legend>
					{#each styleOptions as style (style)}
						<label class="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm">
							<input type="checkbox" checked={styles.has(style)} onchange={() => onToggleStyle(style)} />
							{styleLabel(style)}
						</label>
					{/each}
				</fieldset>
				<fieldset class="mt-3 space-y-1">
					<legend class="mb-1 text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['bv9.filters_colors']()}</legend>
					{#each sortedColors as option (option.color)}
						<label class="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
							<input type="checkbox" class="size-4 {focusRing}" checked={colors.has(option.color)} onchange={() => onToggleColor(option.color)} />
							<span class="size-3 rounded-full {colorTone(option.color).bar}" style:background-color={colorTone(option.color).hex} aria-hidden="true"></span>
							<span>{m['bv9.color_option']({ color: colorName(option.color), count: option.count })}</span>
						</label>
					{/each}
				</fieldset>
			</div>
		{/if}
	</div>

	<button
		type="button"
		class={iconControlClass}
		aria-pressed={compact}
		aria-label={m['bv9.compact']()}
		title={m['bv9.compact']()}
		onclick={() => (compact = !compact)}
	>
		<svg aria-hidden="true" class={controlIconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
	</button>

	<span class="inline-flex" title={offline ? m['bv9.export_offline']() : m['bv9.export_label']()}>
		<button
			type="button"
			class={controlButtonClass}
			disabled={offline || exporting}
			aria-describedby={offline ? 'highlights-export-offline' : undefined}
			onclick={onExport}
		>
			<Icon name="download" class={controlIconClass} />
			{exporting ? m['bv9.exporting']() : m['bv9.export']()}
		</button>
	</span>
	{#if offline}
		<span id="highlights-export-offline" class="sr-only">{m['bv9.export_offline']()}</span>
	{/if}
</div>
