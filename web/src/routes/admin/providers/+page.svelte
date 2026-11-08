<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import { listProviders, updateProvider } from '#lib/admin/api.js';
	import {
		adminErrorKey,
		buildProviderPatch,
		providerCapabilities,
		providerDraft,
		providerFieldErrorKey,
		type ProviderDraft
	} from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { ProviderSettings } from '#lib/admin/types.js';
	import { errorBox, focusRing, inputClass, panelClass, primaryButton, secondaryButton, warningBox } from '#lib/admin/ui.js';
	import { translate } from '#lib/paging/translate.js';

	interface Row {
		settings: ProviderSettings;
		draft: ProviderDraft;
		saving: boolean;
		fieldError: { field: string; message: string } | null;
		error: string;
		saved: boolean;
	}

	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let loadError = $state<unknown>(null);
	let rows = $state<Row[]>([]);
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
			const providers = await listProviders(current.signal);
			if (current.signal.aborted) return;
			rows = [...providers]
				.sort((a, b) => a.priority - b.priority || a.provider.localeCompare(b.provider))
				.map((settings) => ({ settings, draft: providerDraft(settings), saving: false, fieldError: null, error: '', saved: false }));
			status = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			loadError = cause;
			status = 'error';
		}
	}

	function providerName(provider: string): string {
		switch (provider) {
			case 'openlibrary':
				return m['admin.providers.name.openlibrary']();
			case 'googlebooks':
				return m['admin.providers.name.googlebooks']();
			case 'neodb':
				return m['admin.providers.name.neodb']();
			case 'hardcover':
				return m['admin.providers.name.hardcover']();
			default:
				return provider;
		}
	}

	function tokenRule(provider: string): string {
		const token = providerCapabilities(provider).token;
		if (token === 'none') return m['admin.providers.token_none']();
		if (token === 'required') return m['admin.providers.token_required_rule']();
		return m['admin.providers.token_optional']();
	}

	function edited(row: Row) {
		row.saved = false;
		row.error = '';
		row.fieldError = null;
	}

	function reset(row: Row) {
		row.draft = providerDraft(row.settings);
		edited(row);
	}

	async function save(row: Row, event: SubmitEvent) {
		event.preventDefault();
		if (row.saving) return;
		edited(row);
		const result = buildProviderPatch(row.settings, row.draft);
		if (!result.ok) {
			row.fieldError = { field: result.field, message: translate(providerFieldErrorKey(result.error)) };
			return;
		}
		const name = providerName(row.settings.provider);
		if (result.removesToken && !window.confirm(m['admin.providers.remove_token_confirm']({ name }))) return;
		if (result.disablesCredentialProvider && !window.confirm(m['admin.providers.disable_confirm']({ name }))) return;

		row.saving = true;
		try {
			const settings = await updateProvider(row.settings.provider, result.patch);
			row.settings = settings;
			row.draft = providerDraft(settings);
			row.saved = true;
		} catch (cause) {
			// The draft is kept so the administrator can correct it; the token is never shown or logged.
			row.error = translate(adminErrorKey(cause, 'save_provider'));
		} finally {
			row.saving = false;
		}
	}

	function fieldError(row: Row, field: string): string {
		return row.fieldError?.field === field ? row.fieldError.message : '';
	}
</script>

<svelte:head>
	<title>{m['admin.providers.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="providers-heading">
	<header class="space-y-2">
		<h1 id="providers-heading" class="text-3xl font-semibold tracking-tight">{m['admin.providers.title']()}</h1>
		<p class="text-slate-600">{m['admin.providers.description']()}</p>
	</header>

	{#if status === 'error'}
		<AdminAlert message={translate(adminErrorKey(loadError, 'load'))} error={loadError} onretry={load} />
	{:else if status === 'loading'}
		<p class="text-slate-600" role="status">{m['admin.providers.loading']()}</p>
	{:else if rows.length === 0}
		<p class="card p-6 text-slate-600">{m['admin.providers.empty']()}</p>
	{:else}
		<div class="space-y-6">
			{#each rows as row (row.settings.provider)}
				{@const provider = row.settings.provider}
				{@const capabilities = providerCapabilities(provider)}
				{@const prefix = `provider-${provider}`}
				<form class={panelClass} aria-labelledby={`${prefix}-heading`} onsubmit={(event) => save(row, event)} novalidate>
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div class="space-y-1">
							<h2 id={`${prefix}-heading`} class="text-xl font-semibold">{providerName(provider)}</h2>
							<p class="text-sm text-slate-600">
								{row.settings.enabled ? m['admin.providers.state_enabled']() : m['admin.providers.state_disabled']()}
								·
								{capabilities.token === 'none'
									? m['admin.providers.token_not_used']()
									: row.settings.has_token
										? m['admin.providers.token_stored']()
										: m['admin.providers.token_missing']()}
							</p>
							<p class="text-xs text-slate-500">{m['admin.providers.updated']({ time: formatTimestamp(row.settings.updated_at) })}</p>
						</div>
					</div>

					<div class="grid gap-1">
						<label class="flex items-center gap-2 text-sm font-medium">
							<input
								type="checkbox"
								class={`h-4 w-4 ${focusRing}`}
								bind:checked={row.draft.enabled}
								onchange={() => edited(row)}
								aria-describedby={fieldError(row, 'enabled') ? `${prefix}-enabled-error` : undefined}
							/>
							{m['admin.providers.enabled']()}
						</label>
						{#if fieldError(row, 'enabled')}<p id={`${prefix}-enabled-error`} class="text-sm text-red-700">{fieldError(row, 'enabled')}</p>{/if}
					</div>

					<div class="grid gap-1">
						<label class="text-sm font-medium" for={`${prefix}-priority`}>{m['admin.providers.priority']()}</label>
						<input
							id={`${prefix}-priority`}
							class={`${inputClass} sm:max-w-40`}
							type="text"
							inputmode="numeric"
							autocomplete="off"
							bind:value={row.draft.priority}
							oninput={() => edited(row)}
							aria-invalid={fieldError(row, 'priority') ? 'true' : undefined}
							aria-describedby={`${prefix}-priority-hint${fieldError(row, 'priority') ? ` ${prefix}-priority-error` : ''}`}
						/>
						<p id={`${prefix}-priority-hint`} class="text-xs text-slate-500">{m['admin.providers.priority_hint']()}</p>
						{#if fieldError(row, 'priority')}<p id={`${prefix}-priority-error`} class="text-sm text-red-700">{fieldError(row, 'priority')}</p>{/if}
					</div>

					{#if capabilities.baseURL}
						<div class="grid gap-1">
							<label class="text-sm font-medium" for={`${prefix}-base-url`}>{m['admin.providers.base_url']()}</label>
							<input
								id={`${prefix}-base-url`}
								class={`${inputClass} sm:max-w-md`}
								type="url"
								autocomplete="off"
								spellcheck="false"
								placeholder={capabilities.defaultBaseURL ?? ''}
								bind:value={row.draft.baseURL}
								oninput={() => edited(row)}
								aria-invalid={fieldError(row, 'base_url') ? 'true' : undefined}
								aria-describedby={`${prefix}-base-url-hint${fieldError(row, 'base_url') ? ` ${prefix}-base-url-error` : ''}`}
							/>
							<p id={`${prefix}-base-url-hint`} class="text-xs text-slate-500">
								{m['admin.providers.base_url_hint']({ default: capabilities.defaultBaseURL ?? '' })}
							</p>
							{#if fieldError(row, 'base_url')}<p id={`${prefix}-base-url-error`} class="text-sm text-red-700">{fieldError(row, 'base_url')}</p>{/if}
						</div>
					{/if}

					<fieldset class="grid gap-2" aria-describedby={`${prefix}-token-rule`}>
						<legend class="text-sm font-medium">{m['admin.providers.token']()}</legend>
						<p id={`${prefix}-token-rule`} class="text-xs text-slate-500">{tokenRule(provider)}</p>
						{#if capabilities.token !== 'none' || row.settings.has_token}
							<label class="flex items-center gap-2 text-sm">
								<input type="radio" class={focusRing} name={`${prefix}-token-mode`} value="keep" bind:group={row.draft.tokenMode} onchange={() => edited(row)} />
								{row.settings.has_token ? m['admin.providers.token_keep']() : m['admin.providers.token_leave_empty']()}
							</label>
							{#if capabilities.token !== 'none'}
								<label class="flex items-center gap-2 text-sm">
									<input type="radio" class={focusRing} name={`${prefix}-token-mode`} value="replace" bind:group={row.draft.tokenMode} onchange={() => edited(row)} />
									{row.settings.has_token ? m['admin.providers.token_replace']() : m['admin.providers.token_set']()}
								</label>
							{/if}
							{#if row.settings.has_token}
								<label class="flex items-center gap-2 text-sm">
									<input type="radio" class={focusRing} name={`${prefix}-token-mode`} value="remove" bind:group={row.draft.tokenMode} onchange={() => edited(row)} />
									{m['admin.providers.token_remove']()}
								</label>
							{/if}
						{/if}
						{#if row.draft.tokenMode === 'replace'}
							<div class="grid gap-1">
								<label class="text-sm font-medium" for={`${prefix}-token`}>{m['admin.providers.token_value']()}</label>
								<input
									id={`${prefix}-token`}
									class={`${inputClass} sm:max-w-md`}
									type="password"
									autocomplete="new-password"
									spellcheck="false"
									bind:value={row.draft.token}
									oninput={() => edited(row)}
									aria-invalid={fieldError(row, 'token') ? 'true' : undefined}
									aria-describedby={`${prefix}-token-hint${fieldError(row, 'token') ? ` ${prefix}-token-error` : ''}`}
								/>
								<p id={`${prefix}-token-hint`} class="text-xs text-slate-500">{m['admin.providers.token_hint']()}</p>
							</div>
						{/if}
						{#if fieldError(row, 'token')}<p id={`${prefix}-token-error`} class="text-sm text-red-700">{fieldError(row, 'token')}</p>{/if}
						{#if row.draft.tokenMode === 'remove'}
							<p class={warningBox}>{m['admin.providers.remove_token_warning']()}</p>
						{/if}
					</fieldset>

					{#if fieldError(row, 'form')}<p class="text-sm text-slate-700" role="status">{fieldError(row, 'form')}</p>{/if}
					{#if row.error}<p class={errorBox} role="alert">{row.error}</p>{/if}
					{#if row.saved}<p class="text-sm text-green-700" role="status">{m['admin.providers.saved']({ name: providerName(provider) })}</p>{/if}

					<div class="flex flex-wrap gap-3">
						<button type="submit" class={primaryButton} disabled={row.saving}>
							{row.saving ? m['admin.providers.saving']() : m['admin.providers.save']()}
						</button>
						<button type="button" class={secondaryButton} disabled={row.saving} onclick={() => reset(row)}>{m['admin.providers.reset']()}</button>
					</div>
				</form>
			{/each}
		</div>
	{/if}
</section>
