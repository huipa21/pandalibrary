<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '../Icon.svelte';
	import { colorTone, MARK_SORTS, type ColorCount, type MarkSort } from './highlights-model.js';
	import { colorName } from './labels.js';
	import type { HighlightStyle } from '#lib/reader/types.js';
	import { styleLabel } from '#lib/reader/pdf/panel/labels.js';

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
	const iconButton = `inline-flex size-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
	const pressedClass = 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800';
</script>

<div class="flex flex-wrap items-center gap-2">
	<label class="relative min-w-48 flex-1">
		<span class="sr-only">{m['bv9.search_label']()}</span>
		<Icon name="search" class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
		<input
			type="search"
			class="w-full rounded-md border border-slate-300 bg-white py-2 pr-3 pl-9 text-sm {focusRing}"
			placeholder={m['bv9.search_placeholder']()}
			autocomplete="off"
			bind:value={draft}
			oninput={onInput}
		/>
	</label>

	<button
		type="button"
		class="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium {notesOnly ? pressedClass : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'} {focusRing}"
		aria-pressed={notesOnly}
		title={m['bv9.notes_toggle_label']()}
		onclick={() => (notesOnly = !notesOnly)}
	>
		{m['bv9.notes_toggle']({ count: notesCount })}
	</button>

	<label class="sr-only" for="highlights-sort">{m['bv9.sort_label']()}</label>
	<select
		id="highlights-sort"
		class="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm {focusRing}"
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
			class="{iconButton} {filterCount > 0 ? pressedClass : ''}"
			aria-expanded={filtersOpen}
			aria-controls="highlights-filters"
			aria-label={filterCount > 0 ? m['bv9.filters_active']({ count: filterCount }) : m['bv9.filters']()}
			title={m['bv9.filters']()}
			onclick={() => (filtersOpen = !filtersOpen)}
		>
			<svg aria-hidden="true" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16l-6 7.5V19l-4 1v-7.5z" /></svg>
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
					{#each colorOptions as option (option.color)}
						<label class="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
							<input type="checkbox" class="size-4 {focusRing}" checked={colors.has(option.color)} onchange={() => onToggleColor(option.color)} />
							<span class="size-3 rounded-full {colorTone(option.color).bar}" aria-hidden="true"></span>
							<span>{m['bv9.color_option']({ color: colorName(option.color), count: option.count })}</span>
						</label>
					{/each}
				</fieldset>
			</div>
		{/if}
	</div>

	<button
		type="button"
		class="{iconButton} {compact ? pressedClass : ''}"
		aria-pressed={compact}
		aria-label={m['bv9.compact']()}
		title={m['bv9.compact']()}
		onclick={() => (compact = !compact)}
	>
		<svg aria-hidden="true" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
	</button>

	<span class="inline-flex" title={offline ? m['bv9.export_offline']() : m['bv9.export_label']()}>
		<button
			type="button"
			class="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 {focusRing}"
			disabled={offline || exporting}
			aria-describedby={offline ? 'highlights-export-offline' : undefined}
			onclick={onExport}
		>
			<Icon name="download" class="size-4" />
			{exporting ? m['bv9.exporting']() : m['bv9.export']()}
		</button>
	</span>
	{#if offline}
		<span id="highlights-export-offline" class="sr-only">{m['bv9.export_offline']()}</span>
	{/if}
</div>
