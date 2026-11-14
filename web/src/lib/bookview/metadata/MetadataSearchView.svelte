<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { candidateKey, candidateOffers, candidateValues } from '#lib/metadata/merge.js';
	import { MERGE_FIELDS, type MergeField } from '#lib/metadata/types.js';
	import MetadataSaveBar from './MetadataSaveBar.svelte';
	import ProvenanceBadge from './ProvenanceBadge.svelte';
	import type { MetadataEditorState } from './editor-state.svelte.js';
	import { displayValues, draftValues, fieldLabels, providerErrorCode, roleLabel } from './labels.js';

	let { editor, coverSource, onSave }: {
		editor: MetadataEditorState;
		coverSource: string | null;
		onSave: () => Promise<void>;
	} = $props();

	const disabled = $derived(editor.busy || editor.lookupPending);

	onMount(() => {
		if (editor.providers.length) return;
		const controller = new AbortController();
		void editor.loadProviders(controller.signal);
		return () => controller.abort();
	});

	function sourceKeydown(event: KeyboardEvent, index: number) {
		const count = editor.sources.length;
		let next: number;
		if (event.key === 'ArrowRight') next = (index + 1) % count;
		else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = count - 1;
		else return;
		event.preventDefault();
		editor.activeSource = editor.sources[next]!.provider;
		document.getElementById(`source-tab-${next}`)?.focus();
	}
</script>

{#snippet values(items: string[], field: MergeField)}
	{#if items.length === 0}
		<span class="text-slate-500">{m['metadata.field.empty']()}</span>
	{:else if field === 'description'}
		<span class="block max-h-56 overflow-y-auto whitespace-pre-wrap">{items[0]}</span>
	{:else if items.length === 1}
		<span>{items[0]}</span>
	{:else}
		<ol class="list-inside list-decimal space-y-1">
			{#each items as item, index (index)}<li>{item}</li>{/each}
		</ol>
	{/if}
{/snippet}

<form aria-label={m['metadata.search.heading']()} class="search-card" onsubmit={(event) => { event.preventDefault(); void editor.searchProviders(); }}>
	<p class="text-sm text-slate-600">{m['metadata.search.help']()}</p>
	<div class="query-grid">
		<fieldset class="providers" disabled={disabled}>
			<legend>{m['metadata.search.providers']()}</legend>
			{#if editor.providerChoices.length}
				<div class="provider-options">
					{#each editor.providerChoices as provider (provider)}
						<label class="provider-option">
							<input type="checkbox" checked={!editor.excludedProviders.includes(provider)}
								onchange={(event) => editor.toggleProvider(provider, event.currentTarget.checked)} />
							<span>{provider}</span>
						</label>
					{/each}
				</div>
			{:else}
				<p class="text-sm text-slate-600">{m['metadata.search.all_providers']()}</p>
			{/if}
		</fieldset>
		<div>
			<label for="metadata-search-isbn">{m['metadata.search.isbn']()}</label>
			<input id="metadata-search-isbn" bind:value={editor.search.isbn} disabled={disabled} />
		</div>
		<div>
			<label for="metadata-search-title">{m['metadata.search.title']()}</label>
			<input id="metadata-search-title" bind:value={editor.search.title} disabled={disabled} />
		</div>
		<div>
			<label for="metadata-search-author">{m['metadata.search.author']()}</label>
			<input id="metadata-search-author" bind:value={editor.search.author} disabled={disabled} />
		</div>
		<div class="search-action">
			<button type="submit" class="primary-button" disabled={disabled}>{m['metadata.search.submit']()}</button>
		</div>
	</div>
	{#if editor.searchError}<p class="text-sm text-red-800" role="alert">{editor.searchError}</p>{/if}
</form>

<div aria-live="polite" role="status" class="space-y-2 text-sm">
	{#if editor.lookupPending}<p>{m['metadata.lookup.loading']()}</p>
	{:else if editor.lookup && !editor.candidateTotal}<p>{m['metadata.lookup.empty']()}</p>
	{:else if editor.lookup}<p>{m['metadata.lookup.ready']({ count: editor.candidateTotal })}</p>{/if}
</div>
{#if editor.lookupError}<p class="rounded-md bg-red-50 p-3 text-red-800" role="alert">{editor.lookupError}</p>{/if}
{#if editor.partialFailure}<p class="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{m['metadata.lookup.partial']()}</p>{/if}
{#each editor.lookup?.providers.filter((provider) => provider.error) ?? [] as provider (provider.provider)}
	<p class="text-sm text-amber-900">{m['metadata.provider.failed']({ provider: provider.provider, code: providerErrorCode(provider.error!.code) })}</p>
{/each}

{#if editor.lookup}
	{@const candidate = editor.candidate}
	{@const source = editor.source}
	<form aria-label={m['metadata.form.name']()} class="compare-form" onsubmit={(event) => { event.preventDefault(); void onSave(); }}>
		{#if editor.sources.length && source}
			<div class="source-controls">
				<div role="tablist" aria-label={m['metadata.lookup.heading']()} class="source-tabs">
					{#each editor.sources as provider, index (provider.provider)}
						<button type="button" role="tab" id={`source-tab-${index}`} aria-controls={`source-panel-${index}`}
							aria-selected={source.provider === provider.provider} tabindex={source.provider === provider.provider ? 0 : -1}
							disabled={disabled} onclick={() => { editor.activeSource = provider.provider; }}
							onkeydown={(event) => sourceKeydown(event, index)}>{provider.provider}</button>
					{/each}
				</div>
				{#each editor.sources as provider, index (provider.provider)}
					<div role="tabpanel" id={`source-panel-${index}`} aria-labelledby={`source-tab-${index}`} hidden={source.provider !== provider.provider}>
						{#if source.provider === provider.provider}
							{#if provider.candidates.length > 1 && candidate}
								<label for="candidate-alternative">{m['metadata.candidate.alternative']()}</label>
								<select id="candidate-alternative" value={candidate.reference} disabled={disabled}
									onchange={(event) => { editor.alternatives = { ...editor.alternatives, [provider.provider]: event.currentTarget.value }; }}>
									{#each provider.candidates as item (candidateKey(item))}
										<option value={item.reference}>{item.title}</option>
									{/each}
								</select>
							{:else if candidate}
								<p class="break-words text-sm text-slate-600">{candidate.title}</p>
							{/if}
						{/if}
					</div>
				{/each}
				<button type="button" class="secondary-button" disabled={disabled || !candidate} onclick={() => editor.useAll()}>{m['metadata.candidate.use_available']()}</button>
			</div>
		{/if}
		{#if candidate}
			<div class="comparison-heading" aria-hidden="true">
				<span>{m['metadata.column.draft']()}</span><span></span>
				<span>{m['metadata.column.found']()}</span>
			</div>
			{#each MERGE_FIELDS as field (field)}
				<fieldset class="metadata-row" data-field={field} disabled={editor.busy}>
					<legend>{fieldLabels[field]()}</legend>
					<ProvenanceBadge {editor} {field} />
					<div class="comparison-grid">
						<div class="draft-value">
							{#if field === 'cover'}
								{#if editor.selections.cover}
									{#if editor.chosenCoverPending}<p role="status">{m['metadata.cover.previewing']()}</p>
									{:else if editor.chosenCoverUrl}<img class="cover-image" src={editor.chosenCoverUrl} alt={m['metadata.cover.preview_alt']({ provider: editor.selections.cover.provider })} />
									{:else if editor.chosenCoverError}
										<p role="alert" class="text-red-800">{editor.chosenCoverError}</p>
										<button type="button" class="secondary-button" disabled={disabled}
											onclick={() => editor.loadCover(editor.selections.cover, editor.lookup?.request_key, true)}>{m['catalog.retry']()}</button>
									{/if}
								{:else if coverSource}<img class="cover-image" src={coverSource} alt={m['metadata.cover.current_alt']()} />
								{:else}<p class="text-slate-500">{m['metadata.cover.none']()}</p>{/if}
							{:else}
								{@render values(draftValues(editor.draft, field), field)}
							{/if}
						</div>
						<div class="copy-controls">
							<button type="button" class="secondary-button" aria-label={m['metadata.field.use_found']({ field: fieldLabels[field]() })}
								title={m['metadata.field.use_found']({ field: fieldLabels[field]() })} disabled={editor.lookupPending || !candidateOffers(candidate, field)}
								onclick={() => editor.useFound(field)}>←</button>
							<button type="button" class="secondary-button" aria-label={m['metadata.field.restore']({ field: fieldLabels[field]() })}
								title={m['metadata.field.restore']({ field: fieldLabels[field]() })} onclick={() => editor.restore(field)}>↶</button>
						</div>
						<div class="found-value">
							{#if field === 'cover'}
								{#if !candidate.cover_url}<p class="text-slate-500">{m['metadata.cover.none']()}</p>
								{:else if editor.previewPending}<p role="status">{m['metadata.cover.previewing']()}</p>
								{:else if editor.previewUrl}<img class="cover-image" src={editor.previewUrl} alt={m['metadata.cover.preview_alt']({ provider: candidate.provider })} />
								{:else if editor.previewError}
									<p class="text-red-800" role="alert">{editor.previewError}</p>
									<button type="button" class="secondary-button" disabled={disabled}
										onclick={() => editor.loadCover(candidate, editor.lookup?.request_key, false)}>{m['catalog.retry']()}</button>
								{/if}
							{:else}
								{@render values(displayValues(field, candidateValues(candidate, field, roleLabel)), field)}
							{/if}
						</div>
					</div>
				</fieldset>
			{/each}
		{/if}
		<MetadataSaveBar {editor} />
	</form>
{/if}

<style>
	.search-card, .compare-form { min-width: 0; border: 1px solid #e2e8f0; border-radius: 0.5rem; padding: 1rem; }
	.search-card { display: grid; gap: 0.75rem; }
	.query-grid { display: grid; grid-template-columns: minmax(0, 2fr) repeat(3, minmax(0, 1fr)) auto; gap: 0.75rem; align-items: end; }
	.providers { min-width: 0; }
	.providers legend, label { display: block; margin-bottom: 0.25rem; font-size: 0.8125rem; font-weight: 600; color: #334155; }
	.provider-options { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; }
	.provider-option { display: inline-flex; align-items: center; gap: 0.375rem; margin: 0; font-weight: 400; font-size: 0.875rem; }
	.provider-option input { width: auto; }
	input, select { width: 100%; min-width: 0; max-width: 100%; border: 1px solid #cbd5e1; border-radius: 0.375rem; padding: 0.375rem 0.625rem; background: white; }
	.primary-button, .secondary-button { border-radius: 0.375rem; padding: 0.5rem 0.75rem; font-size: 0.875rem; font-weight: 500; }
	.primary-button { background: #0f172a; color: white; white-space: nowrap; }
	.secondary-button { border: 1px solid #cbd5e1; }
	button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #334155; outline-offset: 2px; }
	button:disabled { opacity: 0.5; cursor: not-allowed; }
	.source-controls { display: grid; gap: 0.75rem; margin-bottom: 1.25rem; min-width: 0; }
	.source-controls > button { justify-self: start; }
	.source-tabs { display: flex; flex-wrap: wrap; gap: 0.5rem; }
	.source-tabs button { border: 1px solid #cbd5e1; border-radius: 0.375rem; padding: 0.5rem 0.75rem; overflow-wrap: anywhere; }
	.source-tabs button[aria-selected="true"] { border-color: #0f172a; background: #f1f5f9; font-weight: 600; }
	.metadata-row { position: relative; min-width: 0; margin-top: 0.75rem; border-top: 1px solid #e2e8f0; padding-top: 0.625rem; }
	.metadata-row legend { padding-right: 0.5rem; font-weight: 600; }
	.metadata-row > :global(.provenance) { position: absolute; top: 0.625rem; right: 0; }
	.comparison-grid, .comparison-heading { display: grid; grid-template-columns: minmax(0, 1fr) 6rem minmax(0, 1fr); gap: 0.75rem; }
	.comparison-heading { font-size: 0.875rem; font-weight: 600; color: #475569; }
	.draft-value, .found-value { min-width: 0; overflow-wrap: anywhere; font-size: 0.875rem; }
	.copy-controls { display: flex; justify-content: center; gap: 0.5rem; }
	.copy-controls button { width: 2.75rem; min-height: 2.75rem; padding: 0.25rem; font-size: 1.25rem; }
	fieldset:disabled .draft-value { opacity: 0.6; }
	.cover-image { max-width: 100%; max-height: 12rem; border-radius: 0.375rem; object-fit: contain; background: #f1f5f9; }
	@media (max-width: 1023px) {
		.query-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.providers { grid-column: 1 / -1; }
	}
	@media (max-width: 639px) {
		.query-grid { grid-template-columns: minmax(0, 1fr); }
		.comparison-heading { display: none; }
		.comparison-grid { grid-template-columns: minmax(0, 1fr); }
		.copy-controls { justify-content: flex-start; }
		.found-value { border-left: 2px solid #e2e8f0; padding-left: 0.75rem; }
		.search-card, .compare-form { padding: 0.75rem; }
	}
</style>
