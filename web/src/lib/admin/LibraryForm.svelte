<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { libraryFieldErrorKey, suggestSlug, validateLibraryDraft } from './form.js';
	import { errorBox, inputClass, primaryButton, secondaryButton } from './ui.js';
	import IconPicker from '#lib/shelves/IconPicker.svelte';

	let {
		idPrefix,
		submitLabel,
		busyLabel,
		initialName = '',
		initialIcon = '',
		initialSlug = '',
		suggestSlugFromName = false,
		stacked = false,
		resetOnSuccess = false,
		onsave,
		oncancel
	}: {
		idPrefix: string;
		submitLabel: string;
		busyLabel: string;
		initialName?: string;
		initialIcon?: string;
		initialSlug?: string;
		/** Fills the slug from the name until the administrator edits the slug. */
		suggestSlugFromName?: boolean;
		stacked?: boolean;
		resetOnSuccess?: boolean;
		/** Returns an error message, or null when the save succeeded. Values are kept on error. */
		onsave: (name: string, slug: string, icon: string) => Promise<string | null>;
		oncancel?: () => void;
	} = $props();

	let name = $state('');
	let icon = $state('');
	let slug = $state('');
	let slugEdited = $state(false);
	let busy = $state(false);
	let error = $state('');
	let nameError = $state('');
	let slugError = $state('');
	let nameInput = $state<HTMLInputElement | null>(null);
	let slugInput = $state<HTMLInputElement | null>(null);

	$effect.pre(() => {
		name = initialName;
		icon = initialIcon;
		slug = initialSlug;
	});

	function nameChanged() {
		if (suggestSlugFromName && !slugEdited) slug = suggestSlug(name);
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		error = '';
		nameError = '';
		slugError = '';
		const result = validateLibraryDraft({ name, slug });
		if (!result.ok) {
			const message = translate(libraryFieldErrorKey(result.error));
			if (result.field === 'name') {
				nameError = message;
				nameInput?.focus();
			} else {
				slugError = message;
				slugInput?.focus();
			}
			return;
		}
		busy = true;
		try {
			const failure = await onsave(result.name, result.slug, icon);
			if (failure) error = failure;
			else if (resetOnSuccess) {
				name = '';
				icon = '';
				slug = '';
				slugEdited = false;
			}
		} finally {
			busy = false;
		}
	}
</script>

<form class={`grid gap-4 ${stacked ? '' : 'sm:grid-cols-2'}`} onsubmit={submit} novalidate>
	<div class="grid content-start gap-1">
		<label class="grid gap-1 text-sm font-medium" for={`${idPrefix}-name`}>
			<span>{m['admin.libraries.form.name']()}</span>
			<input
				id={`${idPrefix}-name`}
				class={inputClass}
				autocomplete="off"
				required
				aria-invalid={nameError ? 'true' : undefined}
				aria-describedby={nameError ? `${idPrefix}-name-error` : undefined}
				bind:value={name}
				bind:this={nameInput}
				oninput={nameChanged}
			/>
		</label>
		{#if nameError}<p id={`${idPrefix}-name-error`} class="-mt-2 text-sm text-red-700" role="alert">{nameError}</p>{/if}
	</div>
	<div class="grid content-start gap-1">
		<label class="grid gap-1 text-sm font-medium" for={`${idPrefix}-slug`}>
			<span>{m['admin.libraries.form.slug']()}</span>
			<input
				id={`${idPrefix}-slug`}
				class={`${inputClass} font-mono`}
				autocomplete="off"
				spellcheck="false"
				required
				aria-invalid={slugError ? 'true' : undefined}
				aria-describedby={`${idPrefix}-slug-hint${slugError ? ` ${idPrefix}-slug-error` : ''}`}
				bind:value={slug}
				bind:this={slugInput}
				oninput={() => (slugEdited = true)}
			/>
		</label>
		<p id={`${idPrefix}-slug-hint`} class="text-xs text-slate-500">{m['admin.libraries.form.slug_hint']()}</p>
		{#if slugError}<p id={`${idPrefix}-slug-error`} class="-mt-2 text-sm text-red-700" role="alert">{slugError}</p>{/if}
	</div>
	<div class={stacked ? '' : 'sm:col-span-2'}>
		<IconPicker {idPrefix} bind:value={icon} disabled={busy} />
	</div>
	{#if error}<p class={`${stacked ? '' : 'sm:col-span-2'} ${errorBox}`} role="alert">{error}</p>{/if}
	<div class={`flex flex-wrap gap-3 ${stacked ? '' : 'sm:col-span-2'}`}>
		<button type="submit" class={primaryButton} disabled={busy}>{busy ? busyLabel : submitLabel}</button>
		{#if oncancel}
			<button type="button" class={secondaryButton} onclick={oncancel}>{m['admin.cancel']()}</button>
		{/if}
	</div>
</form>
