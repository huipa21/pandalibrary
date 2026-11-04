<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { parsePositiveID } from './form.js';
	import { errorBox, inputClass, primaryButton } from './ui.js';

	let {
		idPrefix,
		label,
		hint,
		submitLabel,
		busyLabel,
		initialValue = '',
		resetOnSuccess = false,
		onsubmit
	}: {
		idPrefix: string;
		label: string;
		hint?: string;
		submitLabel: string;
		busyLabel: string;
		initialValue?: string;
		resetOnSuccess?: boolean;
		/** Receives a validated positive ID. Returns an error message, or null on success. */
		onsubmit: (id: number) => Promise<string | null>;
	} = $props();

	let value = $state('');
	let busy = $state(false);
	let fieldError = $state('');
	let error = $state('');
	let input = $state<HTMLInputElement | null>(null);

	$effect.pre(() => {
		value = initialValue;
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		fieldError = '';
		error = '';
		const id = parsePositiveID(value);
		if (id === null) {
			fieldError = m['admin.id.invalid']();
			input?.focus();
			return;
		}
		busy = true;
		try {
			const failure = await onsubmit(id);
			if (failure) error = failure;
			else if (resetOnSuccess) value = '';
		} finally {
			busy = false;
		}
	}

	const describedBy = $derived(
		[hint ? `${idPrefix}-hint` : '', fieldError ? `${idPrefix}-error` : ''].filter(Boolean).join(' ') || undefined
	);
</script>

<form class="grid gap-2" onsubmit={submit} novalidate>
	<label class="text-sm font-medium" for={`${idPrefix}-input`}>{label}</label>
	<div class="flex flex-wrap items-start gap-3">
		<input
			id={`${idPrefix}-input`}
			class={`${inputClass} w-40`}
			inputmode="numeric"
			autocomplete="off"
			required
			aria-invalid={fieldError ? 'true' : undefined}
			aria-describedby={describedBy}
			bind:value
			bind:this={input}
		/>
		<button type="submit" class={primaryButton} disabled={busy}>{busy ? busyLabel : submitLabel}</button>
	</div>
	{#if hint}<p id={`${idPrefix}-hint`} class="text-xs text-slate-500">{hint}</p>{/if}
	{#if fieldError}<p id={`${idPrefix}-error`} class="text-sm text-red-700">{fieldError}</p>{/if}
	{#if error}<p class={errorBox} role="alert">{error}</p>{/if}
</form>
