<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/shell/confirmation.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import { translate } from '#lib/paging/translate.js';
	import {
		buildProviderCreate,
		buildProviderPatch,
		providerCapabilities,
		providerCreateDraft,
		providerDraft,
		providerFieldErrorKey,
		type ProviderDraft
	} from './form.js';
	import { providerName } from './provider-name.js';
	import type { ProviderCatalogEntry, ProviderCreate, ProviderPatch, ProviderSettings } from './types.js';
	import { dangerButton, errorBox, focusRing, inputClass, primaryButton, secondaryButton, warningBox } from './ui.js';

	let {
		open,
		mode,
		settings,
		catalog,
		onclose,
		oncreate,
		onupdate,
		ondelete
	}: {
		open: boolean;
		mode: 'create' | 'edit';
		settings?: ProviderSettings;
		catalog?: ProviderCatalogEntry[];
		onclose: () => void;
		oncreate?: (input: ProviderCreate) => Promise<string | null>;
		onupdate?: (patch: ProviderPatch) => Promise<string | null>;
		ondelete?: () => Promise<string | null>;
	} = $props();

	// The dialog is mounted per open, so the initial props are intentionally read once.
	const initial = untrack(() => settings?.provider ?? catalog?.[0]?.provider ?? '');
	let selected = $state(initial);
	let draft = $state<ProviderDraft>(
		untrack(() =>
			settings
				? providerDraft(settings)
				: {
						...providerCreateDraft(catalog?.find((entry) => entry.provider === initial)?.default_priority ?? 100),
						tokenMode: 'keep'
					}
		)
	);
	let dialogElement = $state<HTMLDialogElement | null>(null);
	let busy = $state(false);
	let error = $state('');
	let fieldError = $state<{ field: string; message: string } | null>(null);

	const provider = $derived(mode === 'create' ? selected : (settings?.provider ?? ''));
	const capabilities = $derived(providerCapabilities(provider));
	const name = $derived(providerName(provider));
	const titleID = $derived(mode === 'create' ? 'create-provider-heading' : 'edit-provider-heading');
	const title = $derived(mode === 'create' ? m['admin.providers.add_title']() : m['admin.providers.edit_title']({ name }));

	$effect(() => {
		if (!open || !dialogElement) return;
		const dialog = dialogElement;
		const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		dialog.querySelector<HTMLElement>('select, input')?.focus();
		return () => {
			if (dialog.open) dialog.close();
			if (originalFocus?.isConnected) originalFocus.focus();
		};
	});

	function tokenRule(): string {
		if (capabilities.token === 'none') return m['admin.providers.token_none']();
		if (capabilities.token === 'required') return m['admin.providers.token_required_rule']();
		return m['admin.providers.token_optional']();
	}

	function edited() {
		error = '';
		fieldError = null;
	}

	function fieldErrorFor(field: string): string {
		return fieldError?.field === field ? fieldError.message : '';
	}

	function chooseProvider(event: Event) {
		selected = (event.currentTarget as HTMLSelectElement).value;
		const entry = catalog?.find((item) => item.provider === selected);
		draft = { ...providerCreateDraft(entry?.default_priority ?? 100), tokenMode: 'keep' };
		edited();
	}

	async function run(action: () => Promise<string | null> | undefined) {
		busy = true;
		try {
			const message = await action();
			if (message) error = message;
			else onclose();
		} finally {
			busy = false;
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		edited();
		if (mode === 'create') {
			const result = buildProviderCreate(selected, {
				enabled: draft.enabled,
				priority: draft.priority,
				baseURL: draft.baseURL,
				token: draft.token
			});
			if (!result.ok) {
				fieldError = { field: result.field, message: translate(providerFieldErrorKey(result.error)) };
				return;
			}
			await run(() => oncreate?.(result.input));
			return;
		}
		if (!settings) return;
		const result = buildProviderPatch(settings, draft);
		if (!result.ok) {
			fieldError = { field: result.field, message: translate(providerFieldErrorKey(result.error)) };
			return;
		}
		if (result.removesToken && !(await confirmAction(m['admin.providers.remove_token_confirm']({ name })))) return;
		if (result.disablesCredentialProvider && !(await confirmAction(m['admin.providers.disable_confirm']({ name })))) return;
		await run(() => onupdate?.(result.patch));
	}

	async function remove() {
		if (busy || !ondelete) return;
		if (!(await confirmAction(m['admin.providers.delete_confirm']({ name })))) return;
		await run(ondelete);
	}

	function close() {
		if (!busy) onclose();
	}

	function cancel(event: Event) {
		event.preventDefault();
		close();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const target = nextTrappedFocus(focusableWithin(dialogElement), document.activeElement, event.shiftKey);
		if (target) {
			event.preventDefault();
			target.focus();
		}
	}
</script>

{#if open}
	<dialog
		bind:this={dialogElement}
		class="fixed inset-0 m-auto max-h-[90vh] w-[min(94vw,36rem)] overflow-y-auto rounded-lg bg-white p-6 text-slate-950 shadow-lg"
		aria-labelledby={titleID}
		aria-busy={busy}
		oncancel={cancel}
		{onkeydown}
	>
		<h2 id={titleID} class="mb-4 text-lg font-semibold">{title}</h2>
		<form class="grid gap-4" onsubmit={save} novalidate>
			{#if mode === 'create'}
				<div class="grid gap-1">
					<label class="text-sm font-medium" for="provider-dialog-provider">{m['admin.providers.select']()}</label>
					<select
						id="provider-dialog-provider"
						class={inputClass}
						value={selected}
						onchange={chooseProvider}
						disabled={busy}
					>
						{#each catalog ?? [] as entry (entry.provider)}
							<option value={entry.provider}>{providerName(entry.provider)}</option>
						{/each}
					</select>
					{#if (catalog?.length ?? 0) === 0}
						<p class="text-sm text-slate-600">{m['admin.providers.none_available']()}</p>
					{/if}
				</div>
			{/if}

			<div class="grid gap-1">
				<label class="flex items-center gap-2 text-sm font-medium">
					<input
						type="checkbox"
						class={`h-4 w-4 ${focusRing}`}
						bind:checked={draft.enabled}
						onchange={edited}
						aria-describedby={fieldErrorFor('enabled') ? 'provider-dialog-enabled-error' : undefined}
					/>
					{m['admin.providers.enabled']()}
				</label>
				{#if fieldErrorFor('enabled')}
					<p id="provider-dialog-enabled-error" class="text-sm text-red-700">{fieldErrorFor('enabled')}</p>
				{/if}
			</div>

			<div class="grid gap-1">
				<label class="text-sm font-medium" for="provider-dialog-priority">{m['admin.providers.priority']()}</label>
				<input
					id="provider-dialog-priority"
					class={`${inputClass} sm:max-w-40`}
					type="text"
					inputmode="numeric"
					autocomplete="off"
					bind:value={draft.priority}
					oninput={edited}
					aria-invalid={fieldErrorFor('priority') ? 'true' : undefined}
					aria-describedby={`provider-dialog-priority-hint${fieldErrorFor('priority') ? ' provider-dialog-priority-error' : ''}`}
				/>
				<p id="provider-dialog-priority-hint" class="text-xs text-slate-500">{m['admin.providers.priority_hint']()}</p>
				{#if fieldErrorFor('priority')}
					<p id="provider-dialog-priority-error" class="text-sm text-red-700">{fieldErrorFor('priority')}</p>
				{/if}
			</div>

			{#if capabilities.baseURL}
				<div class="grid gap-1">
					<label class="text-sm font-medium" for="provider-dialog-base-url">{m['admin.providers.base_url']()}</label>
					<input
						id="provider-dialog-base-url"
						class={`${inputClass} sm:max-w-md`}
						type="url"
						autocomplete="off"
						spellcheck="false"
						placeholder={capabilities.defaultBaseURL ?? ''}
						bind:value={draft.baseURL}
						oninput={edited}
						aria-invalid={fieldErrorFor('base_url') ? 'true' : undefined}
						aria-describedby={`provider-dialog-base-url-hint${fieldErrorFor('base_url') ? ' provider-dialog-base-url-error' : ''}`}
					/>
					<p id="provider-dialog-base-url-hint" class="text-xs text-slate-500">
						{m['admin.providers.base_url_hint']({ default: capabilities.defaultBaseURL ?? '' })}
					</p>
					{#if fieldErrorFor('base_url')}
						<p id="provider-dialog-base-url-error" class="text-sm text-red-700">{fieldErrorFor('base_url')}</p>
					{/if}
				</div>
			{/if}

			{#if mode === 'create'}
				{#if capabilities.token !== 'none'}
					<div class="grid gap-1">
						<label class="text-sm font-medium" for="provider-dialog-token">{m['admin.providers.token_value']()}</label>
						<input
							id="provider-dialog-token"
							class={`${inputClass} sm:max-w-md`}
							type="password"
							autocomplete="new-password"
							spellcheck="false"
							bind:value={draft.token}
							oninput={edited}
							aria-invalid={fieldErrorFor('token') ? 'true' : undefined}
							aria-describedby={`provider-dialog-token-hint${fieldErrorFor('token') ? ' provider-dialog-token-error' : ''}`}
						/>
						<p id="provider-dialog-token-hint" class="text-xs text-slate-500">
							{tokenRule()} {m['admin.providers.token_hint']()}
						</p>
						{#if fieldErrorFor('token')}
							<p id="provider-dialog-token-error" class="text-sm text-red-700">{fieldErrorFor('token')}</p>
						{/if}
					</div>
				{/if}
			{:else if settings}
				<fieldset class="grid gap-2" aria-describedby="provider-dialog-token-rule">
					<legend class="text-sm font-medium">{m['admin.providers.token']()}</legend>
					<p id="provider-dialog-token-rule" class="text-xs text-slate-500">{tokenRule()}</p>
					{#if capabilities.token !== 'none' || settings.has_token}
						<label class="flex items-center gap-2 text-sm">
							<input type="radio" class={focusRing} name="provider-dialog-token-mode" value="keep" bind:group={draft.tokenMode} onchange={edited} />
							{settings.has_token ? m['admin.providers.token_keep']() : m['admin.providers.token_leave_empty']()}
						</label>
						{#if capabilities.token !== 'none'}
							<label class="flex items-center gap-2 text-sm">
								<input type="radio" class={focusRing} name="provider-dialog-token-mode" value="replace" bind:group={draft.tokenMode} onchange={edited} />
								{settings.has_token ? m['admin.providers.token_replace']() : m['admin.providers.token_set']()}
							</label>
						{/if}
						{#if settings.has_token}
							<label class="flex items-center gap-2 text-sm">
								<input type="radio" class={focusRing} name="provider-dialog-token-mode" value="remove" bind:group={draft.tokenMode} onchange={edited} />
								{m['admin.providers.token_remove']()}
							</label>
						{/if}
					{/if}
					{#if draft.tokenMode === 'replace'}
						<div class="grid gap-1">
							<label class="text-sm font-medium" for="provider-dialog-token">{m['admin.providers.token_value']()}</label>
							<input
								id="provider-dialog-token"
								class={`${inputClass} sm:max-w-md`}
								type="password"
								autocomplete="new-password"
								spellcheck="false"
								bind:value={draft.token}
								oninput={edited}
								aria-invalid={fieldErrorFor('token') ? 'true' : undefined}
								aria-describedby={`provider-dialog-token-hint${fieldErrorFor('token') ? ' provider-dialog-token-error' : ''}`}
							/>
							<p id="provider-dialog-token-hint" class="text-xs text-slate-500">{m['admin.providers.token_hint']()}</p>
						</div>
					{/if}
					{#if draft.tokenMode === 'remove'}
						<p class={warningBox}>{m['admin.providers.remove_token_warning']()}</p>
					{/if}
					{#if fieldErrorFor('token')}
						<p id="provider-dialog-token-error" class="text-sm text-red-700">{fieldErrorFor('token')}</p>
					{/if}
				</fieldset>
			{/if}

			{#if error}<p class={errorBox} role="alert">{error}</p>{/if}

			<div class="flex flex-wrap items-center gap-2">
				{#if mode === 'edit' && ondelete}
					<button type="button" class={dangerButton} disabled={busy} onclick={remove}>
						{m['admin.providers.delete']()}
					</button>
				{/if}
				<button type="button" class={`${secondaryButton} ml-auto`} disabled={busy} onclick={close}>
					{m['admin.cancel']()}
				</button>
				<button
					type="submit"
					class={primaryButton}
					disabled={busy || (mode === 'create' && (catalog?.length ?? 0) === 0)}
				>
					{mode === 'create' ? m['admin.providers.create']() : busy ? m['admin.providers.saving']() : m['admin.providers.save']()}
				</button>
			</div>
		</form>
	</dialog>
{/if}

<style>
	dialog::backdrop {
		background: rgb(15 23 42 / 0.6);
	}
</style>
