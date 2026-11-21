<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { controlIconClass, iconControlClass } from '#lib/catalog/filter-styles.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import type { DictionaryDirection, DictionaryLanguage, DictionaryStatus } from '#lib/dictionary/types.js';
	import type { DictionaryFieldFailure, DictionaryProviderDraft } from './form.js';
	import type { DictionaryProvider } from './types.js';
	import { dangerButton, errorBox, inputClass, linkClass, primaryButton, secondaryButton } from './ui.js';

	type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok'; status: DictionaryStatus } | { kind: 'error'; message: string };
	type FieldError = { field: DictionaryFieldFailure['field']; message: string };
	interface RowState {
		provider: DictionaryProvider;
		draft: DictionaryProviderDraft;
		busy: '' | 'save' | 'toggle' | 'remove_key' | 'delete';
		error: string;
		fieldError: FieldError | null;
		test: TestState;
	}

	let { open, row, scope, onclose, onsave, ontoggle, onremovekey, ondelete, ontest, onchange }: {
		open: boolean;
		row: RowState;
		scope: string;
		onclose: () => void;
		onsave: () => Promise<boolean>;
		ontoggle: () => Promise<void>;
		onremovekey: () => void;
		ondelete: () => void;
		ontest: () => void;
		onchange: () => void;
	} = $props();

	let dialogElement = $state<HTMLDialogElement | null>(null);
	const prefix = $derived(`dictionary-dialog-${row.provider.id}`);
	const enabled = $derived(row.provider.enabled && (!row.provider.preset || row.provider.has_api_key));
	const canToggle = $derived(row.provider.has_api_key || !row.provider.preset);
	const busy = $derived(row.busy !== '');
	const testing = $derived(row.test.kind === 'testing');

	$effect(() => {
		if (!open || !dialogElement) return;
		const dialog = dialogElement;
		const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		const focusID = row.provider.preset ? `#${prefix}-api-key` : `#${prefix}-name`;
		dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(focusID)?.focus();
		return () => {
			if (dialog.open) dialog.close();
			if (originalFocus?.isConnected) originalFocus.focus();
		};
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		if (await onsave()) onclose();
	}

	function close() {
		if (!busy && !testing) onclose();
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

	function fieldMessage(field: FieldError['field']): string {
		return row.fieldError?.field === field ? row.fieldError.message : '';
	}

	function directionLabel(direction: DictionaryDirection): string {
		return m['admin.dictionaries.test_direction']({ from: direction.from, to: direction.to, sources: direction.sources.join(', ') });
	}
</script>

{#if open}
	<dialog
		bind:this={dialogElement}
		class="fixed inset-0 m-auto max-h-[90vh] w-[min(94vw,40rem)] overflow-y-auto rounded-lg bg-white p-6 text-slate-950 shadow-lg"
		aria-labelledby={`${prefix}-heading`}
		aria-busy={busy || testing}
		oncancel={cancel}
		{onkeydown}
		data-testid={prefix}
	>
		<div class="mb-4 flex items-start justify-between gap-4">
			<div class="space-y-1">
				<h2 id={`${prefix}-heading`} class="text-lg font-semibold">{m['admin.dictionaries.edit_title']()}</h2>
				<p class="text-sm text-slate-600">{row.provider.name}</p>
			</div>
			<button type="button" class={iconControlClass} aria-label={m['admin.dictionaries.close_editor']()} title={m['admin.dictionaries.close_editor']()} disabled={busy} onclick={close}>
				<Icon name="x" class={controlIconClass} />
			</button>
		</div>

		<form class="space-y-4" onsubmit={submit} novalidate>
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="grid gap-1">
					<label class="text-sm font-medium" for={`${prefix}-name`}>{m['admin.dictionaries.name']()}</label>
					<input
						id={`${prefix}-name`}
						class={inputClass}
						type="text"
						autocomplete="off"
						disabled={row.provider.preset || busy}
						bind:value={row.draft.name}
						oninput={onchange}
						aria-invalid={fieldMessage('name') ? 'true' : undefined}
						aria-describedby={fieldMessage('name') ? `${prefix}-name-error` : undefined}
					/>
					{#if fieldMessage('name')}<p id={`${prefix}-name-error`} class="text-sm text-red-700">{fieldMessage('name')}</p>{/if}
				</div>

				<div class="grid content-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
					<div class="flex items-center justify-between gap-3">
						<span class="text-sm font-medium">{m['admin.dictionaries.status_label']()}</span>
						<span class={`rounded-full border px-2 py-0.5 text-xs font-medium ${enabled ? 'border-green-200 bg-green-50 text-green-800' : 'border-slate-200 bg-slate-100 text-slate-700'}`}>
							{enabled ? m['admin.dictionaries.status.enabled']() : m['admin.dictionaries.status.disabled']()}
						</span>
					</div>
					<div class="space-y-1">
						<span class="text-sm font-medium">{m['admin.dictionaries.scope_label']()}</span>
						<p class="text-sm text-slate-700">{scope}</p>
					</div>
				</div>
			</div>

			{#if !row.provider.preset}
				<div class="grid gap-1">
					<label class="text-sm font-medium" for={`${prefix}-base-url`}>{m['admin.dictionaries.base_url']()}</label>
					<input
						id={`${prefix}-base-url`}
						class={inputClass}
						type="url"
						autocomplete="off"
						spellcheck="false"
						disabled={busy}
						bind:value={row.draft.baseURL}
						oninput={onchange}
						aria-invalid={fieldMessage('base_url') ? 'true' : undefined}
						aria-describedby={`${prefix}-base-url-hint${fieldMessage('base_url') ? ` ${prefix}-base-url-error` : ''}`}
					/>
					<p id={`${prefix}-base-url-hint`} class="text-xs text-slate-500">{m['admin.dictionaries.base_url_hint']()}</p>
					{#if fieldMessage('base_url')}<p id={`${prefix}-base-url-error`} class="text-sm text-red-700">{fieldMessage('base_url')}</p>{/if}
				</div>
			{:else if row.provider.signup_url}
				<p class="text-sm">
					<a class={linkClass} href={row.provider.signup_url} target="_blank" rel="noopener noreferrer">
						{m['admin.dictionaries.signup']()}<span class="sr-only"> {m['admin.dictionaries.new_tab']()}</span>
					</a>
				</p>
			{/if}

			<div class="grid gap-1">
				<label class="text-sm font-medium" for={`${prefix}-api-key`}>{m['admin.dictionaries.api_key']()}</label>
				<div class="relative">
					<textarea
						id={`${prefix}-api-key`}
						class={`${inputClass} min-h-24 w-full resize-y pr-11 font-mono`}
						rows="3"
						autocomplete="new-password"
						spellcheck="false"
						disabled={busy}
						placeholder={row.provider.has_api_key ? m['admin.dictionaries.api_key_saved_placeholder']() : ''}
						bind:value={row.draft.apiKey}
						oninput={onchange}
						aria-invalid={fieldMessage('api_key') ? 'true' : undefined}
						aria-describedby={`${prefix}-api-key-hint${fieldMessage('api_key') ? ` ${prefix}-api-key-error` : ''}`}
					></textarea>
					{#if row.draft.apiKey}
						<button
							type="button"
							class="absolute right-1 top-1 inline-flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 app-focus-ring"
							aria-label={m['admin.dictionaries.clear_api_key']()}
							title={m['admin.dictionaries.clear_api_key']()}
							disabled={busy}
							onclick={() => {
								row.draft.apiKey = '';
								onchange();
							}}
						>
							<Icon name="x" class="size-4" />
						</button>
					{/if}
				</div>
				<p id={`${prefix}-api-key-hint`} class="text-xs text-slate-500">
					{row.provider.preset ? m['admin.dictionaries.api_key_hint']() : m['admin.dictionaries.api_key_optional_hint']()}
				</p>
				{#if row.provider.has_api_key}
					<div>
						<button type="button" class="rounded-sm text-sm text-red-800 underline underline-offset-4 app-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2" disabled={busy} onclick={onremovekey}>
							{m['admin.dictionaries.remove_key']()}
						</button>
					</div>
				{/if}
				{#if fieldMessage('api_key')}<p id={`${prefix}-api-key-error`} class="text-sm text-red-700">{fieldMessage('api_key')}</p>{/if}
			</div>

			<div class="grid gap-1">
				<label class="text-sm font-medium" for={`${prefix}-priority`}>{m['admin.dictionaries.priority']()}</label>
				<input
					id={`${prefix}-priority`}
					class={`${inputClass} sm:max-w-40`}
					type="text"
					inputmode="numeric"
					autocomplete="off"
					disabled={busy}
					bind:value={row.draft.priority}
					oninput={onchange}
					aria-invalid={fieldMessage('priority') ? 'true' : undefined}
					aria-describedby={`${prefix}-priority-hint${fieldMessage('priority') ? ` ${prefix}-priority-error` : ''}`}
				/>
				<p id={`${prefix}-priority-hint`} class="text-xs text-slate-500">{m['admin.dictionaries.priority_hint']()}</p>
				{#if fieldMessage('priority')}<p id={`${prefix}-priority-error`} class="text-sm text-red-700">{fieldMessage('priority')}</p>{/if}
			</div>

			{#if fieldMessage('form')}<p class="text-sm text-slate-700" role="status">{fieldMessage('form')}</p>{/if}
			{#if row.error}<p class={errorBox} role="alert">{row.error}</p>{/if}

			<div aria-live="polite">
				{#if row.test.kind === 'error'}
					<p class={errorBox} role="alert">{row.test.message}</p>
				{:else if row.test.kind === 'ok'}
					<div class="space-y-2">
						<p class="text-sm text-green-700">{m['admin.dictionaries.test_ok']({ count: row.test.status.sources.length })}</p>
						{#if row.test.status.directions.length === 0}
							<p class="text-sm text-slate-600">{m['admin.dictionaries.test_no_directions']()}</p>
						{:else}
							<ul class="list-disc space-y-1 pl-5 text-sm text-slate-700">
								{#each row.test.status.directions as direction (`${direction.from}-${direction.to}`)}
									<li>{directionLabel(direction)}</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
			</div>

			<div class="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
				<button type="submit" class={primaryButton} disabled={busy}>
					{row.busy === 'save' ? m['admin.dictionaries.saving']() : m['admin.dictionaries.save']()}
				</button>
				<button type="button" class={secondaryButton} disabled={busy || testing} onclick={ontest}>
					{testing ? m['admin.dictionaries.testing']() : m['admin.dictionaries.test']()}
				</button>
				<button type="button" class={secondaryButton} disabled={busy || !canToggle} onclick={ontoggle}>
					{enabled ? m['admin.dictionaries.disable']() : m['admin.dictionaries.enable']()}
				</button>
				<button
					type="button"
					class={dangerButton}
					disabled={busy || row.provider.preset}
					title={row.provider.preset ? m['admin.dictionaries.delete_preset_hint']() : undefined}
					onclick={ondelete}
				>{m['admin.dictionaries.delete']()}</button>
			</div>
		</form>
	</dialog>
{/if}

<style>
	dialog::backdrop {
		background: rgb(15 23 42 / 0.6);
	}
</style>
