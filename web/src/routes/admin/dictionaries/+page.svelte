<script lang="ts">
	import { confirmAction } from '#lib/shell/confirmation.js';
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import {
		clearDictionaryCache,
		createDictionaryProvider,
		deleteDictionaryProvider,
		listDictionaryProviders,
		testDictionaryProvider,
		updateDictionaryProvider
	} from '#lib/admin/api.js';
	import {
		adminErrorKey,
		buildDictionaryProviderInput,
		buildDictionaryProviderPatch,
		dictionaryFieldErrorKey,
		dictionaryProviderDraft,
		dictionaryProviderState,
		type DictionaryFieldFailure,
		type DictionaryProviderDraft,
		type DictionaryProviderState
	} from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { DictionaryProvider, DictionaryProviderKind, DictionaryProviderPatch } from '#lib/admin/types.js';
	import {
		dangerButton,
		errorBox,
		inputClass,
		linkClass,
		panelClass,
		primaryButton,
		secondaryButton
	} from '#lib/admin/ui.js';
	import type { DictionaryDirection, DictionaryStatus } from '#lib/dictionary/types.js';
	import { translate } from '#lib/paging/translate.js';

	type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok'; status: DictionaryStatus } | { kind: 'error'; message: string };
	type FieldError = { field: DictionaryFieldFailure['field']; message: string };
	type Row = {
		provider: DictionaryProvider;
		draft: DictionaryProviderDraft;
		busy: '' | 'save' | 'toggle' | 'remove_key' | 'delete';
		error: string;
		fieldError: FieldError | null;
		saved: boolean;
		test: TestState;
	};

	const presetOrder: DictionaryProviderKind[] = ['mw-collegiate', 'mw-thesaurus', 'custom'];
	const features: Partial<Record<DictionaryProviderKind, () => string>> = {
		'mw-collegiate': () => m['admin.dictionaries.features.mw_collegiate'](),
		'mw-thesaurus': () => m['admin.dictionaries.features.mw_thesaurus']()
	};
	const stateLabel: Record<DictionaryProviderState, () => string> = {
		enabled: () => m['admin.dictionaries.status.enabled'](),
		needs_key: () => m['admin.dictionaries.status.needs_key'](),
		disabled: () => m['admin.dictionaries.status.disabled']()
	};
	const stateClass: Record<DictionaryProviderState, string> = {
		enabled: 'border-green-200 bg-green-50 text-green-800',
		needs_key: 'border-amber-300 bg-amber-50 text-amber-900',
		disabled: 'border-slate-200 bg-slate-100 text-slate-700'
	};

	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let loadError = $state<unknown>(null);
	let rows = $state<Row[]>([]);
	let cacheEntries = $state(0);
	let clearing = $state(false);
	let cacheMessage = $state('');
	let cacheError = $state('');
	let addDraft = $state<DictionaryProviderDraft>(dictionaryProviderDraft());
	let adding = $state(false);
	let addError = $state('');
	let addFieldError = $state<FieldError | null>(null);
	let added = $state(false);
	let controller: AbortController | null = null;

	const presets = $derived(
		rows.filter((row) => row.provider.preset).sort((a, b) => presetOrder.indexOf(a.provider.kind) - presetOrder.indexOf(b.provider.kind))
	);
	const customs = $derived(
		rows.filter((row) => !row.provider.preset).sort((a, b) => a.provider.priority - b.provider.priority || a.provider.id - b.provider.id)
	);

	onMount(() => void load());
	onDestroy(() => controller?.abort());

	function toRow(provider: DictionaryProvider): Row {
		return { provider, draft: dictionaryProviderDraft(provider), busy: '', error: '', fieldError: null, saved: false, test: { kind: 'idle' } };
	}

	async function load() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		status = 'loading';
		loadError = null;
		try {
			const loaded = await listDictionaryProviders(current.signal);
			if (current.signal.aborted) return;
			rows = loaded.providers.map(toRow);
			cacheEntries = loaded.cache_entries;
			status = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			loadError = cause;
			status = 'error';
		}
	}

	function edited(row: Row) {
		row.saved = false;
		row.error = '';
		row.fieldError = null;
	}

	function fieldMessage(row: Row, field: FieldError['field']): string {
		return row.fieldError?.field === field ? row.fieldError.message : '';
	}

	function failure(result: DictionaryFieldFailure): FieldError {
		return { field: result.field, message: translate(dictionaryFieldErrorKey(result.error)) };
	}

	async function apply(row: Row, busy: Row['busy'], patch: DictionaryProviderPatch, keepDraft = false) {
		row.busy = busy;
		try {
			const updated = await updateDictionaryProvider(row.provider.id, patch);
			const draft = row.draft;
			row.provider = updated;
			row.draft = keepDraft ? { ...draft, apiKey: '' } : dictionaryProviderDraft(updated);
			row.saved = true;
			if (patch.api_key !== undefined || patch.base_url !== undefined) row.test = { kind: 'idle' };
		} catch (cause) {
			// The draft is kept so the administrator can correct it; the key is never shown or logged.
			row.error = translate(adminErrorKey(cause, 'save_dictionary'));
		} finally {
			row.busy = '';
		}
	}

	async function save(row: Row, event: SubmitEvent) {
		event.preventDefault();
		if (row.busy) return;
		edited(row);
		const result = buildDictionaryProviderPatch(row.provider, row.draft);
		if (!result.ok) {
			row.fieldError = failure(result);
			return;
		}
		await apply(row, 'save', result.patch);
	}

	async function toggle(row: Row) {
		if (row.busy) return;
		edited(row);
		await apply(row, 'toggle', { enabled: !row.provider.enabled }, true);
	}

	async function removeKey(row: Row) {
		if (row.busy) return;
		edited(row);
		if (!await confirmAction(m['admin.dictionaries.remove_key_confirm']({ name: row.provider.name }))) return;
		await apply(row, 'remove_key', { api_key: null }, true);
	}

	async function remove(row: Row) {
		if (row.busy) return;
		edited(row);
		if (!await confirmAction(m['admin.dictionaries.delete_confirm']({ name: row.provider.name }))) return;
		row.busy = 'delete';
		try {
			await deleteDictionaryProvider(row.provider.id);
			rows = rows.filter((candidate) => candidate.provider.id !== row.provider.id);
		} catch (cause) {
			row.error = translate(adminErrorKey(cause, 'delete_dictionary'));
			row.busy = '';
		}
	}

	async function runTest(row: Row) {
		if (row.test.kind === 'testing') return;
		row.test = { kind: 'testing' };
		try {
			const result = await testDictionaryProvider(row.provider.id);
			row.test = { kind: 'ok', status: result };
			row.provider = { ...row.provider, directions: result.directions };
		} catch (cause) {
			row.test = { kind: 'error', message: translate(adminErrorKey(cause, 'test_dictionary')) };
		}
	}

	function addEdited() {
		added = false;
		addError = '';
		addFieldError = null;
	}

	function addFieldMessage(field: FieldError['field']): string {
		return addFieldError?.field === field ? addFieldError.message : '';
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (adding) return;
		addEdited();
		const result = buildDictionaryProviderInput(addDraft);
		if (!result.ok) {
			addFieldError = failure(result);
			return;
		}
		adding = true;
		try {
			const created = await createDictionaryProvider(result.input);
			rows = [...rows, toRow(created)];
			addDraft = dictionaryProviderDraft();
			added = true;
		} catch (cause) {
			addError = translate(adminErrorKey(cause, 'save_dictionary'));
		} finally {
			adding = false;
		}
	}

	async function clearCache() {
		if (clearing) return;
		cacheMessage = '';
		cacheError = '';
		if (!await confirmAction(m['admin.dictionaries.clear_cache_confirm']())) return;
		clearing = true;
		try {
			const deleted = await clearDictionaryCache();
			cacheEntries = 0;
			cacheMessage = m['admin.dictionaries.cache_cleared']({ count: deleted });
		} catch (cause) {
			cacheError = translate(adminErrorKey(cause, 'clear_dictionary_cache'));
		} finally {
			clearing = false;
		}
	}

	function directionLabel(direction: DictionaryDirection): string {
		return m['admin.dictionaries.test_direction']({ from: direction.from, to: direction.to, sources: direction.sources.join(', ') });
	}
</script>

<svelte:head>
	<title>{m['admin.dictionaries.title']()} · {m['common.app_name']()}</title>
</svelte:head>

{#snippet directionList(directions: readonly DictionaryDirection[])}
	<ul class="list-disc space-y-1 pl-5 text-sm text-slate-700">
		{#each directions as direction (`${direction.from}-${direction.to}`)}
			<li>{directionLabel(direction)}</li>
		{/each}
	</ul>
{/snippet}

{#snippet card(row: Row)}
	{@const provider = row.provider}
	{@const prefix = `dictionary-${provider.id}`}
	{@const state = dictionaryProviderState(provider)}
	{@const featureText = features[provider.kind]}
	<form class={panelClass} aria-labelledby={`${prefix}-heading`} onsubmit={(event) => save(row, event)} novalidate data-testid={prefix}>
		<div class="space-y-1">
			<div class="flex flex-wrap items-center gap-2">
				<h3 id={`${prefix}-heading`} class="text-lg font-semibold">{provider.name}</h3>
				<span class={`rounded-full border px-2 py-0.5 text-xs font-medium ${stateClass[state]}`}>{stateLabel[state]()}</span>
			</div>
			{#if provider.preset}
				<p class="text-sm text-slate-600">{m['admin.dictionaries.direction_en_en']()}</p>
				{#if featureText}<p class="text-sm text-slate-700">{featureText()}</p>{/if}
				{#if provider.signup_url}
					<p class="text-sm">
						<a class={linkClass} href={provider.signup_url} target="_blank" rel="noopener noreferrer">
							{m['admin.dictionaries.signup']()}<span class="sr-only"> {m['admin.dictionaries.new_tab']()}</span>
						</a>
					</p>
				{/if}
			{:else}
				<p class="break-all text-sm text-slate-600">{provider.base_url}</p>
			{/if}
			<p class="text-xs text-slate-500">{m['admin.dictionaries.updated']({ time: formatTimestamp(provider.updated_at) })}</p>
		</div>

		{#if !provider.preset}
			<div class="space-y-1">
				<h4 class="text-sm font-medium">{m['admin.dictionaries.directions']()}</h4>
				{#if provider.directions.length}
					{@render directionList(provider.directions)}
				{:else}
					<p class="text-sm text-slate-600">{m['admin.dictionaries.directions_none']()}</p>
				{/if}
			</div>

			<div class="grid gap-1">
				<label class="text-sm font-medium" for={`${prefix}-name`}>{m['admin.dictionaries.name']()}</label>
				<input
					id={`${prefix}-name`}
					class={`${inputClass} sm:max-w-md`}
					type="text"
					autocomplete="off"
					bind:value={row.draft.name}
					oninput={() => edited(row)}
					aria-invalid={fieldMessage(row, 'name') ? 'true' : undefined}
					aria-describedby={fieldMessage(row, 'name') ? `${prefix}-name-error` : undefined}
				/>
				{#if fieldMessage(row, 'name')}<p id={`${prefix}-name-error`} class="text-sm text-red-700">{fieldMessage(row, 'name')}</p>{/if}
			</div>

			<div class="grid gap-1">
				<label class="text-sm font-medium" for={`${prefix}-base-url`}>{m['admin.dictionaries.base_url']()}</label>
				<input
					id={`${prefix}-base-url`}
					class={`${inputClass} sm:max-w-md`}
					type="url"
					autocomplete="off"
					spellcheck="false"
					bind:value={row.draft.baseURL}
					oninput={() => edited(row)}
					aria-invalid={fieldMessage(row, 'base_url') ? 'true' : undefined}
					aria-describedby={`${prefix}-base-url-hint${fieldMessage(row, 'base_url') ? ` ${prefix}-base-url-error` : ''}`}
				/>
				<p id={`${prefix}-base-url-hint`} class="text-xs text-slate-500">{m['admin.dictionaries.base_url_hint']()}</p>
				{#if fieldMessage(row, 'base_url')}<p id={`${prefix}-base-url-error`} class="text-sm text-red-700">{fieldMessage(row, 'base_url')}</p>{/if}
			</div>
		{/if}

		<div class="grid gap-1">
			<label class="text-sm font-medium" for={`${prefix}-api-key`}>{m['admin.dictionaries.api_key']()}</label>
			<input
				id={`${prefix}-api-key`}
				class={`${inputClass} sm:max-w-md`}
				type="password"
				autocomplete="new-password"
				spellcheck="false"
				placeholder={provider.has_api_key ? m['admin.dictionaries.api_key_saved_placeholder']() : ''}
				bind:value={row.draft.apiKey}
				oninput={() => edited(row)}
				aria-invalid={fieldMessage(row, 'api_key') ? 'true' : undefined}
				aria-describedby={`${prefix}-api-key-hint${fieldMessage(row, 'api_key') ? ` ${prefix}-api-key-error` : ''}`}
			/>
			<p id={`${prefix}-api-key-hint`} class="text-xs text-slate-500">
				{provider.preset ? m['admin.dictionaries.api_key_hint']() : m['admin.dictionaries.api_key_optional_hint']()}
			</p>
			{#if fieldMessage(row, 'api_key')}<p id={`${prefix}-api-key-error`} class="text-sm text-red-700">{fieldMessage(row, 'api_key')}</p>{/if}
		</div>

		<div class="grid gap-1">
			<label class="text-sm font-medium" for={`${prefix}-priority`}>{m['admin.dictionaries.priority']()}</label>
			<input
				id={`${prefix}-priority`}
				class={`${inputClass} sm:max-w-40`}
				type="text"
				inputmode="numeric"
				autocomplete="off"
				bind:value={row.draft.priority}
				oninput={() => edited(row)}
				aria-invalid={fieldMessage(row, 'priority') ? 'true' : undefined}
				aria-describedby={`${prefix}-priority-hint${fieldMessage(row, 'priority') ? ` ${prefix}-priority-error` : ''}`}
			/>
			<p id={`${prefix}-priority-hint`} class="text-xs text-slate-500">{m['admin.dictionaries.priority_hint']()}</p>
			{#if fieldMessage(row, 'priority')}<p id={`${prefix}-priority-error`} class="text-sm text-red-700">{fieldMessage(row, 'priority')}</p>{/if}
		</div>

		{#if fieldMessage(row, 'form')}<p class="text-sm text-slate-700" role="status">{fieldMessage(row, 'form')}</p>{/if}
		{#if row.error}<p class={errorBox} role="alert">{row.error}</p>{/if}
		{#if row.saved}<p class="text-sm text-green-700" role="status">{m['admin.dictionaries.saved']()}</p>{/if}

		<div class="flex flex-wrap gap-2">
			<button type="submit" class={primaryButton} disabled={!!row.busy}>
				{row.busy === 'save' ? m['admin.dictionaries.saving']() : m['admin.dictionaries.save']()}
			</button>
			{#if provider.has_api_key || !provider.preset}
				<button type="button" class={secondaryButton} disabled={!!row.busy} onclick={() => toggle(row)}>
					{provider.enabled ? m['admin.dictionaries.disable']() : m['admin.dictionaries.enable']()}
				</button>
			{/if}
			{#if provider.has_api_key}
				<button type="button" class={secondaryButton} disabled={!!row.busy} onclick={() => removeKey(row)}>{m['admin.dictionaries.remove_key']()}</button>
			{/if}
			<button type="button" class={secondaryButton} disabled={!!row.busy || row.test.kind === 'testing'} onclick={() => runTest(row)}>
				{row.test.kind === 'testing' ? m['admin.dictionaries.testing']() : m['admin.dictionaries.test']()}
			</button>
			{#if !provider.preset}
				<button type="button" class={dangerButton} disabled={!!row.busy} onclick={() => remove(row)}>{m['admin.dictionaries.delete']()}</button>
			{/if}
		</div>

		<div aria-live="polite">
			{#if row.test.kind === 'error'}
				<p class={errorBox} role="alert">{row.test.message}</p>
			{:else if row.test.kind === 'ok'}
				<div class="space-y-2">
					<p class="text-sm text-green-700">{m['admin.dictionaries.test_ok']({ count: row.test.status.sources.length })}</p>
					{#if row.test.status.directions.length === 0}
						<p class="text-sm text-slate-600">{m['admin.dictionaries.test_no_directions']()}</p>
					{:else}
						{@render directionList(row.test.status.directions)}
					{/if}
				</div>
			{/if}
		</div>
	</form>
{/snippet}

<section class="space-y-8" aria-labelledby="dictionaries-heading">
	<h1 id="dictionaries-heading" class="sr-only">{m['admin.dictionaries.title']()}</h1>

	{#if status === 'error'}
		<AdminAlert message={translate(adminErrorKey(loadError, 'load'))} error={loadError} onretry={load} />
	{:else if status === 'loading'}
		<p class="text-slate-600" role="status">{m['admin.dictionaries.loading']()}</p>
	{:else}
		<section class="space-y-4" aria-labelledby="dictionary-builtin-heading">
			<div class="space-y-1">
				<h2 id="dictionary-builtin-heading" class="text-xl font-semibold">{m['admin.dictionaries.builtin_heading']()}</h2>
				<p class="text-sm text-slate-600">{m['admin.dictionaries.builtin_description']()}</p>
			</div>
			<div class="space-y-6">
				{#each presets as row (row.provider.id)}
					{@render card(row)}
				{/each}
			</div>
		</section>

		<section class="space-y-4" aria-labelledby="dictionary-custom-heading">
			<div class="space-y-1">
				<h2 id="dictionary-custom-heading" class="text-xl font-semibold">{m['admin.dictionaries.custom_heading']()}</h2>
				<p class="text-sm text-slate-600">{m['admin.dictionaries.custom_description']()}</p>
			</div>
			{#if customs.length === 0}
				<p class="text-sm text-slate-600">{m['admin.dictionaries.custom_empty']()}</p>
			{:else}
				<div class="space-y-6">
					{#each customs as row (row.provider.id)}
						{@render card(row)}
					{/each}
				</div>
			{/if}

			<form class={panelClass} aria-labelledby="dictionary-add-heading" onsubmit={add} novalidate>
				<h3 id="dictionary-add-heading" class="text-lg font-semibold">{m['admin.dictionaries.add_heading']()}</h3>
				<div class="grid gap-1">
					<label class="text-sm font-medium" for="dictionary-add-name">{m['admin.dictionaries.name']()}</label>
					<input
						id="dictionary-add-name"
						class={`${inputClass} sm:max-w-md`}
						type="text"
						autocomplete="off"
						bind:value={addDraft.name}
						oninput={addEdited}
						aria-invalid={addFieldMessage('name') ? 'true' : undefined}
						aria-describedby={addFieldMessage('name') ? 'dictionary-add-name-error' : undefined}
					/>
					{#if addFieldMessage('name')}<p id="dictionary-add-name-error" class="text-sm text-red-700">{addFieldMessage('name')}</p>{/if}
				</div>
				<div class="grid gap-1">
					<label class="text-sm font-medium" for="dictionary-add-base-url">{m['admin.dictionaries.base_url']()}</label>
					<input
						id="dictionary-add-base-url"
						class={`${inputClass} sm:max-w-md`}
						type="url"
						autocomplete="off"
						spellcheck="false"
						placeholder="https://dict.example.com"
						bind:value={addDraft.baseURL}
						oninput={addEdited}
						aria-invalid={addFieldMessage('base_url') ? 'true' : undefined}
						aria-describedby={`dictionary-add-base-url-hint${addFieldMessage('base_url') ? ' dictionary-add-base-url-error' : ''}`}
					/>
					<p id="dictionary-add-base-url-hint" class="text-xs text-slate-500">{m['admin.dictionaries.base_url_hint']()}</p>
					{#if addFieldMessage('base_url')}<p id="dictionary-add-base-url-error" class="text-sm text-red-700">{addFieldMessage('base_url')}</p>{/if}
				</div>
				<div class="grid gap-1">
					<label class="text-sm font-medium" for="dictionary-add-api-key">{m['admin.dictionaries.api_key']()}</label>
					<input
						id="dictionary-add-api-key"
						class={`${inputClass} sm:max-w-md`}
						type="password"
						autocomplete="new-password"
						spellcheck="false"
						bind:value={addDraft.apiKey}
						oninput={addEdited}
						aria-invalid={addFieldMessage('api_key') ? 'true' : undefined}
						aria-describedby={`dictionary-add-api-key-hint${addFieldMessage('api_key') ? ' dictionary-add-api-key-error' : ''}`}
					/>
					<p id="dictionary-add-api-key-hint" class="text-xs text-slate-500">{m['admin.dictionaries.api_key_optional_hint']()}</p>
					{#if addFieldMessage('api_key')}<p id="dictionary-add-api-key-error" class="text-sm text-red-700">{addFieldMessage('api_key')}</p>{/if}
				</div>
				{#if addError}<p class={errorBox} role="alert">{addError}</p>{/if}
				{#if added}<p class="text-sm text-green-700" role="status">{m['admin.dictionaries.added']()}</p>{/if}
				<div>
					<button type="submit" class={primaryButton} disabled={adding}>
						{adding ? m['admin.dictionaries.adding']() : m['admin.dictionaries.add']()}
					</button>
				</div>
			</form>
		</section>

		<section class={panelClass} aria-labelledby="dictionary-cache-heading">
			<div class="space-y-1">
				<h2 id="dictionary-cache-heading" class="text-xl font-semibold">{m['admin.dictionaries.cache_heading']()}</h2>
				<p class="text-sm text-slate-600">{m['admin.dictionaries.cache_description']()}</p>
			</div>
			<p class="text-sm font-medium">{m['admin.dictionaries.cache_entries']({ count: cacheEntries })}</p>
			<div>
				<button type="button" class={dangerButton} disabled={clearing} onclick={clearCache}>
					{clearing ? m['admin.dictionaries.clearing_cache']() : m['admin.dictionaries.clear_cache']()}
				</button>
			</div>
			<div aria-live="polite">
				{#if cacheError}<p class={errorBox} role="alert">{cacheError}</p>{/if}
				{#if cacheMessage}<p class="text-sm text-green-700">{cacheMessage}</p>{/if}
			</div>
		</section>
	{/if}
</section>
