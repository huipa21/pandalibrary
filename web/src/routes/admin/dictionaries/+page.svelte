<script lang="ts">
	import { confirmAction } from '#lib/shell/confirmation.js';
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import { getDictionarySettings, testDictionaryConnection, updateDictionarySettings } from '#lib/admin/api.js';
	import { adminErrorKey, buildDictionaryPatch, dictionaryDraft, dictionaryFieldErrorKey, type DictionaryDraft } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { DictionarySettings } from '#lib/admin/types.js';
	import { errorBox, inputClass, panelClass, primaryButton, secondaryButton, warningBox } from '#lib/admin/ui.js';
	import type { DictionaryStatus } from '#lib/dictionary/types.js';
	import { translate } from '#lib/paging/translate.js';

	type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok'; status: DictionaryStatus } | { kind: 'error'; message: string };

	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let loadError = $state<unknown>(null);
	let settings = $state<DictionarySettings | null>(null);
	let draft = $state<DictionaryDraft>({ baseURL: '', apiKey: '', removeKey: false });
	let saving = $state(false);
	let saved = $state(false);
	let error = $state('');
	let fieldError = $state<{ field: string; message: string } | null>(null);
	let test = $state<TestState>({ kind: 'idle' });
	let controller: AbortController | null = null;

	onMount(() => void load());
	onDestroy(() => controller?.abort());

	async function load() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		status = 'loading';
		loadError = null;
		try {
			const loaded = await getDictionarySettings(current.signal);
			if (current.signal.aborted) return;
			settings = loaded;
			draft = dictionaryDraft(loaded);
			status = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			loadError = cause;
			status = 'error';
		}
	}

	function edited() {
		saved = false;
		error = '';
		fieldError = null;
	}

	function reset() {
		if (!settings) return;
		draft = dictionaryDraft(settings);
		edited();
	}

	function toggleRemoveKey() {
		draft.removeKey = !draft.removeKey;
		if (draft.removeKey) draft.apiKey = '';
		edited();
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (saving || !settings) return;
		edited();
		const result = buildDictionaryPatch(settings, draft);
		if (!result.ok) {
			fieldError = { field: result.field, message: translate(dictionaryFieldErrorKey(result.error)) };
			return;
		}
		if (result.removesKey && !await confirmAction(m['admin.dictionaries.remove_key_confirm']())) return;

		saving = true;
		try {
			const updated = await updateDictionarySettings(result.patch);
			settings = updated;
			draft = dictionaryDraft(updated);
			saved = true;
			test = { kind: 'idle' };
		} catch (cause) {
			// The draft is kept so the administrator can correct it; the key is never shown or logged.
			error = translate(adminErrorKey(cause, 'save_dictionary'));
		} finally {
			saving = false;
		}
	}

	async function runTest() {
		if (test.kind === 'testing') return;
		test = { kind: 'testing' };
		try {
			test = { kind: 'ok', status: await testDictionaryConnection() };
		} catch (cause) {
			test = { kind: 'error', message: translate(adminErrorKey(cause, 'test_dictionary')) };
		}
	}

	function fieldMessage(field: string): string {
		return fieldError?.field === field ? fieldError.message : '';
	}
</script>

<svelte:head>
	<title>{m['admin.dictionaries.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="dictionaries-heading">
	<header class="space-y-2">
		<h1 id="dictionaries-heading" class="text-3xl font-semibold tracking-tight">{m['admin.dictionaries.title']()}</h1>
		<p class="text-slate-600">{m['admin.dictionaries.description']()}</p>
	</header>

	{#if status === 'error'}
		<AdminAlert message={translate(adminErrorKey(loadError, 'load'))} error={loadError} onretry={load} />
	{:else if status === 'loading' || !settings}
		<p class="text-slate-600" role="status">{m['admin.dictionaries.loading']()}</p>
	{:else}
		<form class={panelClass} aria-labelledby="dictionary-settings-heading" onsubmit={save} novalidate>
			<div class="space-y-1">
				<h2 id="dictionary-settings-heading" class="text-xl font-semibold">{m['admin.dictionaries.title']()}</h2>
				<p class="text-sm text-slate-600">
					{settings.base_url ? m['admin.dictionaries.status_configured']() : m['admin.dictionaries.status_not_configured']()}
					·
					{settings.has_api_key ? m['admin.dictionaries.key_stored']() : m['admin.dictionaries.key_missing']()}
				</p>
				<p class="text-xs text-slate-500">{m['admin.dictionaries.updated']({ time: formatTimestamp(settings.updated_at) })}</p>
			</div>

			<div class="grid gap-1">
				<label class="text-sm font-medium" for="dictionary-base-url">{m['admin.dictionaries.base_url']()}</label>
				<input
					id="dictionary-base-url"
					class={`${inputClass} sm:max-w-md`}
					type="url"
					autocomplete="off"
					spellcheck="false"
					placeholder="https://dict.example.com"
					bind:value={draft.baseURL}
					oninput={edited}
					aria-invalid={fieldMessage('base_url') ? 'true' : undefined}
					aria-describedby={`dictionary-base-url-hint${fieldMessage('base_url') ? ' dictionary-base-url-error' : ''}`}
				/>
				<p id="dictionary-base-url-hint" class="text-xs text-slate-500">{m['admin.dictionaries.base_url_hint']()}</p>
				{#if fieldMessage('base_url')}<p id="dictionary-base-url-error" class="text-sm text-red-700">{fieldMessage('base_url')}</p>{/if}
			</div>

			<div class="grid gap-1">
				<label class="text-sm font-medium" for="dictionary-api-key">{m['admin.dictionaries.api_key']()}</label>
				<div class="flex flex-wrap items-center gap-3">
					<input
						id="dictionary-api-key"
						class={`${inputClass} sm:max-w-md`}
						type="password"
						autocomplete="new-password"
						spellcheck="false"
						placeholder={settings.has_api_key ? m['admin.dictionaries.api_key_saved_placeholder']() : ''}
						disabled={draft.removeKey}
						bind:value={draft.apiKey}
						oninput={edited}
						aria-invalid={fieldMessage('api_key') ? 'true' : undefined}
						aria-describedby={`dictionary-api-key-hint${fieldMessage('api_key') ? ' dictionary-api-key-error' : ''}`}
					/>
					{#if settings.has_api_key}
						<button type="button" class={secondaryButton} aria-pressed={draft.removeKey} disabled={saving} onclick={toggleRemoveKey}>
							{draft.removeKey ? m['admin.dictionaries.keep_key']() : m['admin.dictionaries.remove_key']()}
						</button>
					{/if}
				</div>
				<p id="dictionary-api-key-hint" class="text-xs text-slate-500">{m['admin.dictionaries.api_key_hint']()}</p>
				{#if fieldMessage('api_key')}<p id="dictionary-api-key-error" class="text-sm text-red-700">{fieldMessage('api_key')}</p>{/if}
				{#if draft.removeKey}<p class={warningBox}>{m['admin.dictionaries.remove_key_warning']()}</p>{/if}
			</div>

			{#if fieldMessage('form')}<p class="text-sm text-slate-700" role="status">{fieldMessage('form')}</p>{/if}
			{#if error}<p class={errorBox} role="alert">{error}</p>{/if}
			{#if saved}<p class="text-sm text-green-700" role="status">{m['admin.dictionaries.saved']()}</p>{/if}

			<div class="flex flex-wrap gap-3">
				<button type="submit" class={primaryButton} disabled={saving}>
					{saving ? m['admin.dictionaries.saving']() : m['admin.dictionaries.save']()}
				</button>
				<button type="button" class={secondaryButton} disabled={saving} onclick={reset}>{m['admin.dictionaries.reset']()}</button>
			</div>
		</form>

		<section class={panelClass} aria-labelledby="dictionary-test-heading">
			<div class="space-y-1">
				<h2 id="dictionary-test-heading" class="text-xl font-semibold">{m['admin.dictionaries.test_heading']()}</h2>
				<p class="text-xs text-slate-500">{m['admin.dictionaries.test_uses_saved']()}</p>
			</div>
			<div>
				<button type="button" class={secondaryButton} disabled={test.kind === 'testing'} onclick={runTest}>
					{test.kind === 'testing' ? m['admin.dictionaries.testing']() : m['admin.dictionaries.test']()}
				</button>
			</div>
			<div aria-live="polite">
				{#if test.kind === 'error'}
					<p class={errorBox} role="alert">{test.message}</p>
				{:else if test.kind === 'ok'}
					<div class="space-y-2">
						<p class="text-sm text-green-700">{m['admin.dictionaries.test_ok']({ count: test.status.sources.length })}</p>
						{#if test.status.directions.length === 0}
							<p class="text-sm text-slate-600">{m['admin.dictionaries.test_no_directions']()}</p>
						{:else}
							<h3 class="text-sm font-medium">{m['admin.dictionaries.test_directions']()}</h3>
							<ul class="list-disc space-y-1 pl-5 text-sm text-slate-700">
								{#each test.status.directions as direction (`${direction.from}-${direction.to}`)}
									<li>
										{m['admin.dictionaries.test_direction']({
											from: direction.from,
											to: direction.to,
											sources: direction.sources.join(', ')
										})}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
			</div>
		</section>
	{/if}
</section>
