<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { floatAt } from '#lib/reader/pdf/marks/float-at.js';
	import type { RectLike } from '#lib/reader/pdf/marks/floating.js';
	import '#lib/reader/pdf/marks/marks.css';
	import '#lib/reader/toolbar/toolbar.css';
	import {
		availableSources,
		availableTargets,
		detectLanguage,
		dictionaryErrorKey,
		fetchDictionaryStatus,
		lookupWord,
		pickTarget,
		rememberedTarget,
		rememberTarget,
		trimSelection
	} from './api.js';
	import type { DictionaryEntry, DictionaryLanguage, DictionaryStatus } from './types.js';

	let { text, anchor, bounds, bookLanguage = null, onclose }: {
		text: string;
		anchor: RectLike;
		bounds: RectLike;
		bookLanguage?: string | null;
		/** `restoreFocus` is false when the panel closes because the user interacted elsewhere. */
		onclose: (restoreFocus: boolean) => void;
	} = $props();

	const languageName: Record<DictionaryLanguage, () => string> = {
		en: () => m['dict.lang.en'](),
		zh: () => m['dict.lang.zh'](),
		ja: () => m['dict.lang.ja']()
	};

	const query = $derived(trimSelection(text));
	let panel = $state<HTMLDivElement>();
	let status = $state.raw<DictionaryStatus | null>(null);
	let statusError = $state<unknown>(null);
	let from = $state<DictionaryLanguage | null>(null);
	let to = $state<DictionaryLanguage | null>(null);
	let entries = $state.raw<DictionaryEntry[]>([]);
	let lookupError = $state<unknown>(null);
	let loading = $state(false);
	let attempt = $state(0);

	const sources = $derived(availableSources(status));
	const fromOptions = $derived(from && !sources.includes(from) ? [from, ...sources] : sources);
	const targets = $derived(from ? availableTargets(status, from) : []);
	const error = $derived(statusError ?? lookupError);

	async function loadStatus() {
		statusError = null;
		try {
			const loaded = await fetchDictionaryStatus();
			status = loaded;
			const sourceLanguages = availableSources(loaded);
			const detected = detectLanguage(query, bookLanguage);
			from = detected ?? sourceLanguages[0] ?? null;
			to = from ? pickTarget(loaded, from, rememberedTarget(from)) : null;
		} catch (failure) {
			statusError = failure;
		}
	}

	function changeFrom(next: DictionaryLanguage) {
		from = next;
		to = pickTarget(status, next, rememberedTarget(next));
	}

	function changeTo(next: DictionaryLanguage) {
		to = next;
		if (from) rememberTarget(from, next);
	}

	function retry() {
		if (statusError) void loadStatus();
		else attempt += 1;
	}

	$effect(() => {
		const q = query;
		const source = from;
		const target = to;
		void attempt;
		entries = [];
		lookupError = null;
		if (!status || !q || !source || !target) {
			loading = false;
			return;
		}
		const controller = new AbortController();
		loading = true;
		lookupWord(q, source, target, { signal: controller.signal }).then(
			(result) => {
				if (controller.signal.aborted) return;
				entries = result.entries;
				loading = false;
			},
			(failure) => {
				if (controller.signal.aborted) return;
				lookupError = failure;
				loading = false;
			}
		);
		return () => controller.abort();
	});

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		onclose(true);
	}

	onMount(() => {
		void loadStatus();
		panel?.focus({ preventScroll: true });
		const outside = (event: Event) => {
			if (panel && !event.composedPath().includes(panel)) onclose(false);
		};
		document.addEventListener('pointerdown', outside, true);
		return () => document.removeEventListener('pointerdown', outside, true);
	});
</script>

<div
	bind:this={panel}
	use:floatAt={{ anchor, bounds }}
	class="pv8-floating dict-panel"
	role="dialog"
	tabindex="-1"
	aria-label={m['dict.panel_label']({ query })}
	data-testid="dict-panel"
	{onkeydown}
>
	<header class="dict-header">
		<h2 class="dict-query" lang={from ?? undefined}>{query}</h2>
		<button type="button" class="pv4-button" aria-label={m['dict.close']()} title={m['dict.close']()} onclick={() => onclose(true)}>
			<Icon name="x" />
		</button>
	</header>
	{#if status && sources.length}
		<div class="dict-langs">
			<label>
				<span>{m['dict.from']()}</span>
				<select value={from} onchange={(event) => changeFrom(event.currentTarget.value as DictionaryLanguage)}>
					{#each fromOptions as lang (lang)}
						<option value={lang}>{languageName[lang]()}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>{m['dict.to']()}</span>
				<select value={to} disabled={!targets.length} onchange={(event) => changeTo(event.currentTarget.value as DictionaryLanguage)}>
					{#each targets as lang (lang)}
						<option value={lang}>{languageName[lang]()}</option>
					{/each}
				</select>
			</label>
		</div>
	{/if}
	<div class="dict-body" aria-live="polite" aria-busy={loading || (!status && !statusError)}>
		{#if error}
			<p class="dict-message" role="alert">{m[dictionaryErrorKey(error)]()}</p>
			<button type="button" class="pv8-text-button" onclick={retry}>{m['dict.retry']()}</button>
		{:else if !status || loading}
			<p class="dict-message">{m['dict.loading']()}</p>
		{:else if !sources.length}
			<p class="dict-message">{m['dict.none_installed']()}</p>
		{:else if !to}
			<p class="dict-message">{m['dict.pair_missing']()}</p>
		{:else if !entries.length}
			<p class="dict-message">{m['dict.no_results']({ query })}</p>
		{:else}
			<ol class="dict-entries">
				{#each entries as entry, index (index)}
					<li class="dict-entry">
						<div class="dict-entry-head">
							<span class="dict-headword" lang={from ?? undefined}>{entry.headword}</span>
							{#if entry.reading && entry.reading !== entry.headword}
								<span class="dict-reading" lang={from ?? undefined}>{entry.reading}</span>
							{/if}
							{#if entry.partOfSpeech}<span class="dict-pos">{entry.partOfSpeech}</span>{/if}
							{#if entry.match === 'lemma'}
								<span class="dict-tag">{m['dict.match.lemma']()}</span>
							{:else if entry.match === 'prefix'}
								<span class="dict-tag">{m['dict.match.prefix']()}</span>
							{/if}
						</div>
						<ol class="dict-definitions" lang={to ?? undefined}>
							{#each entry.definitions as definition, number (number)}
								<li>{definition}</li>
							{/each}
						</ol>
						<p class="dict-source" title={m['dict.source']({ name: entry.sourceName })}>{entry.sourceName}</p>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</div>

<style>
	.dict-panel {
		display: flex;
		flex-direction: column;
		width: min(24rem, calc(100vw - 16px));
		max-height: min(28rem, calc(100vh - 16px));
		padding: 8px 10px 10px;
	}
	.dict-header { display: flex; align-items: center; gap: 8px; }
	.dict-query {
		flex: 1;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		font-size: 16px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dict-langs { display: flex; gap: 8px; margin: 6px 0 4px; }
	.dict-langs label { display: flex; flex: 1; align-items: center; gap: 4px; font-size: 12px; color: #4b5563; }
	.dict-langs select {
		flex: 1;
		min-width: 0;
		padding: 2px 4px;
		border: 1px solid rgb(0 0 0 / 20%);
		border-radius: 6px;
		background: white;
		color: inherit;
		font: inherit;
		font-size: 13px;
	}
	.dict-body { min-height: 0; overflow-y: auto; margin-top: 4px; }
	.dict-message { margin: 8px 0; color: #4b5563; }
	.dict-entries { margin: 0; padding: 0; list-style: none; }
	.dict-entry { padding: 6px 0; border-top: 1px solid rgb(0 0 0 / 8%); }
	.dict-entry:first-child { border-top: 0; }
	.dict-entry-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
	.dict-headword { font-size: 15px; font-weight: 600; }
	.dict-reading { color: #4b5563; }
	.dict-pos { color: #6b7280; font-size: 12px; font-style: italic; }
	.dict-tag {
		padding: 0 6px;
		border-radius: 999px;
		background: rgb(16 185 129 / 12%);
		color: #047857;
		font-size: 11px;
	}
	.dict-definitions { margin: 2px 0 0; padding-left: 1.4em; list-style: decimal; }
	.dict-source { margin: 2px 0 0; color: #9ca3af; font-size: 11px; text-align: right; }
</style>
