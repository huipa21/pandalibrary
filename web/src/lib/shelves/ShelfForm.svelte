<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { fieldErrorKey, validateShelfDraft, type ShelfFormValue } from './form.js';
	import type { RuleGroup, ShelfKind } from './types.js';
	import RuleGroupsEditor from './RuleGroupsEditor.svelte';
	import { removedRuleGroups, validRuleGroups } from './rules.js';

	let {
		idPrefix,
		submitLabel,
		busyLabel,
		allowShared = false,
		initialName = '',
		initialDescription = '',
		initialRuleGroups = [],
		nameLabel,
		compactKindLabels = false,
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
		initialRuleGroups?: RuleGroup[];
		nameLabel?: string;
		compactKindLabels?: boolean;
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
	let groups = $state<RuleGroup[]>([]);
	let removeRuleBooks = $state<boolean | undefined>(undefined);
	const hasRemovedRules = $derived(removedRuleGroups(initialRuleGroups, groups));

	$effect.pre(() => {
		name = initialName;
		description = initialDescription;
		groups = initialRuleGroups.map((group) => ({ ...group, rules: { ...group.rules, conditions: group.rules.conditions.map((condition) => ({ ...condition })) } }));
		removeRuleBooks = undefined;
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
		if (!validRuleGroups(groups)) {
			error = m['ux3.shelves.rules_invalid']();
			return;
		}
		if (hasRemovedRules && removeRuleBooks === undefined) {
			error = m['collections.rules.removal_required']();
			return;
		}
		busy = true;
		try {
			const failure = await onsave({
				kind: allowShared ? kind : 'private', name: result.name, description: result.description,
				rule_groups: groups, ...(hasRemovedRules ? { remove_rule_books: removeRuleBooks } : {})
			});
			if (failure) error = failure;
			else if (resetOnSuccess) {
				name = '';
				description = '';
				kind = 'private';
				groups = [];
			}
		} finally {
			busy = false;
		}
	}
</script>

<form class="grid gap-4" onsubmit={submit} novalidate>
	<label class="grid gap-1 text-sm font-medium" for={`${idPrefix}-name`}>
		<span>{nameLabel ?? m['shelves.form.name']()}</span>
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
	{#if nameError}<p id={`${idPrefix}-name-error`} class="-mt-2 text-sm text-red-700" role="alert">{nameError}</p>{/if}
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
				<span>{compactKindLabels ? m['ux3.shelves.kind_private']() : m['shelves.form.kind_private']()}</span>
			</label>
			<label class="flex items-center gap-2">
				<input type="radio" name={`${idPrefix}-kind`} value="shared" bind:group={kind} />
				<span>{compactKindLabels ? m['ux3.shelves.kind_shared']() : m['shelves.form.kind_shared']()}</span>
			</label>
		</fieldset>
	{/if}
	<RuleGroupsEditor idPrefix={`${idPrefix}-rules`} bind:groups disabled={busy} />
	{#if hasRemovedRules}
		<fieldset class="grid gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" disabled={busy}>
			<legend class="font-medium">{m['collections.rules.removal_heading']()}</legend>
			<p>{m['collections.rules.removal_help']()}</p>
			<label class="flex items-start gap-2">
				<input type="radio" name={`${idPrefix}-removed-books`} value={false} bind:group={removeRuleBooks} required />
				{m['collections.rules.retain_books']()}
			</label>
			<label class="flex items-start gap-2">
				<input type="radio" name={`${idPrefix}-removed-books`} value={true} bind:group={removeRuleBooks} required />
				{m['collections.rules.remove_books']()}
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
