<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { fieldErrorKey, validateShelfDraft, type ShelfFormValue } from './form.js';
	import type { ShelfKind } from './types.js';

	let {
		idPrefix,
		submitLabel,
		busyLabel,
		allowShared = false,
		initialName = '',
		initialDescription = '',
		resetOnSuccess = false,
		onsave,
		oncancel
	}: {
		idPrefix: string;
		submitLabel: string;
		busyLabel: string;
		allowShared?: boolean;
		initialName?: string;
		initialDescription?: string;
		resetOnSuccess?: boolean;
		/** Returns an error message, or null when the save succeeded. */
		onsave: (value: ShelfFormValue) => Promise<string | null>;
		oncancel?: () => void;
	} = $props();

	let name = $state('');
	let description = $state('');
	let kind = $state<ShelfKind>('private');
	let busy = $state(false);
	let error = $state('');
	let nameError = $state('');
	let nameInput = $state<HTMLInputElement | null>(null);

	$effect.pre(() => {
		name = initialName;
		description = initialDescription;
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		error = '';
		nameError = '';
		const result = validateShelfDraft({ name, description });
		if (!result.ok) {
			const message = translate(fieldErrorKey(result.error));
			if (result.error === 'description_too_long') error = message;
			else {
				nameError = message;
				nameInput?.focus();
			}
			return;
		}
		busy = true;
		try {
			const failure = await onsave({ kind: allowShared ? kind : 'private', name: result.name, description: result.description });
			if (failure) error = failure;
			else if (resetOnSuccess) {
				name = '';
				description = '';
				kind = 'private';
			}
		} finally {
			busy = false;
		}
	}
</script>

<form class="grid gap-4" onsubmit={submit} novalidate>
	<label class="grid gap-1 text-sm font-medium" for={`${idPrefix}-name`}>
		<span>{m['shelves.form.name']()}</span>
		<input
			id={`${idPrefix}-name`}
			class="rounded-md border border-slate-300 bg-white px-3 py-2 text-base font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
			autocomplete="off"
			required
			aria-invalid={nameError ? 'true' : undefined}
			aria-describedby={nameError ? `${idPrefix}-name-error` : undefined}
			bind:value={name}
			bind:this={nameInput}
		/>
	</label>
	{#if nameError}<p id={`${idPrefix}-name-error`} class="-mt-2 text-sm text-red-700">{nameError}</p>{/if}
	<label class="grid gap-1 text-sm font-medium" for={`${idPrefix}-description`}>
		<span>{m['shelves.form.description']()}</span>
		<textarea
			id={`${idPrefix}-description`}
			class="min-h-20 rounded-md border border-slate-300 bg-white px-3 py-2 text-base font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
			bind:value={description}
		></textarea>
	</label>
	{#if allowShared}
		<fieldset class="grid gap-2 text-sm">
			<legend class="mb-1 font-medium">{m['shelves.form.kind']()}</legend>
			<label class="flex items-center gap-2">
				<input type="radio" name={`${idPrefix}-kind`} value="private" bind:group={kind} />
				<span>{m['shelves.form.kind_private']()}</span>
			</label>
			<label class="flex items-center gap-2">
				<input type="radio" name={`${idPrefix}-kind`} value="shared" bind:group={kind} />
				<span>{m['shelves.form.kind_shared']()}</span>
			</label>
		</fieldset>
	{/if}
	{#if error}<p class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>{/if}
	<div class="flex flex-wrap gap-3">
		<button
			type="submit"
			class="rounded-md bg-slate-900 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
			disabled={busy}
		>{busy ? busyLabel : submitLabel}</button>
		{#if oncancel}
			<button
				type="button"
				class="rounded-md border border-slate-300 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
				onclick={oncancel}
			>{m['shelves.edit.cancel']()}</button>
		{/if}
	</div>
</form>
