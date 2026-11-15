<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import type { Wordbook } from './api.js';

	let { book, books, onclose, ondelete }: {
		book: Wordbook;
		books: Wordbook[];
		onclose: () => void;
		ondelete: (mergeIntoId?: number) => Promise<void>;
	} = $props();
	let dialog = $state<HTMLDialogElement | null>(null);
	let choice = $state<'trash' | 'merge'>('trash');
	const targets = $derived(books.filter((item) => item.id !== book.id && !item.archived));
	let targetId = $state(untrack(() => String(books.find((item) => item.id !== book.id && !item.archived)?.id ?? '')));
	let confirmed = $state(false);
	let busy = $state(false);
	let error = $state('');
	const canDelete = $derived(books.length > 1);

	$effect(() => {
		if (!dialog) return;
		const element = dialog;
		const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		element.showModal();
		element.querySelector<HTMLButtonElement>('button[type="button"]')?.focus();
		return () => {
			if (element.open) element.close();
			if (originalFocus?.isConnected) originalFocus.focus();
		};
	});
	function cancel(event?: Event) {
		event?.preventDefault();
		if (!busy) onclose();
	}
	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const next = nextTrappedFocus(focusableWithin(dialog), document.activeElement, event.shiftKey);
		if (next) { event.preventDefault(); next.focus(); }
	}
	async function remove(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !canDelete || !confirmed || (choice === 'merge' && !targets.some((item) => String(item.id) === targetId))) return;
		busy = true;
		error = '';
		try { await ondelete(choice === 'merge' ? Number(targetId) : undefined); }
		catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		finally { busy = false; }
	}
</script>

<dialog bind:this={dialog} class="fixed inset-0 m-auto max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-6 text-slate-950 shadow-lg" aria-label={m['wordbooks.deleteBook']()} aria-describedby="wordbook-delete-description" aria-busy={busy} oncancel={cancel} {onkeydown}>
	<h2 class="mb-4 text-lg font-semibold">{m['wordbooks.deleteBook']()}</h2>
	<p id="wordbook-delete-description" class="mb-4 break-words">{m['wordbooks.deleteBookPrompt']({ name: book.name })}</p>
	<form class="space-y-4" onsubmit={remove}>
		<fieldset class="space-y-3" disabled={busy || !canDelete}>
			<legend class="mb-2 font-medium">{m['wordbooks.deleteChoice']()}</legend>
			<label class="flex items-start gap-2"><input type="radio" name="delete-choice" value="trash" bind:group={choice} onchange={() => confirmed = false} /><span>{m['wordbooks.deleteWithEntries']()}</span></label>
			<p class="text-sm text-slate-600">{m['wordbooks.deleteTrashExplanation']()}</p>
			<label class="flex items-start gap-2"><input type="radio" name="delete-choice" value="merge" bind:group={choice} disabled={!targets.length} onchange={() => confirmed = false} /><span>{m['wordbooks.mergeEntries']()}</span></label>
			<p class="text-sm text-slate-600">{m['wordbooks.mergeTrashExplanation']()}</p>
			{#if !targets.length}<p class="text-sm text-slate-600">{m['wordbooks.noMergeTargets']()}</p>{/if}
			{#if choice === 'merge'}
				<label class="grid gap-2"><span class="text-sm font-medium">{m['wordbooks.mergeTarget']()}</span><select class="field" aria-label={m['wordbooks.mergeTarget']()} bind:value={targetId} onchange={() => confirmed = false}>
					{#each targets as target}<option value={String(target.id)}>{target.name}</option>{/each}
				</select></label>
			{/if}
		</fieldset>
		{#if book.is_default}<p class="text-sm text-slate-600">{m['wordbooks.deleteDefaultExplanation']()}</p>{/if}
		{#if !canDelete}<p class="text-sm text-slate-600">{m['wordbooks.lastBookDelete']()}</p>{/if}
		<label class="flex items-start gap-2"><input type="checkbox" bind:checked={confirmed} disabled={busy || !canDelete} /><span>{m['wordbooks.confirmBookDeletion']()}</span></label>
		{#if error}<p role="alert" class="whitespace-pre-wrap break-words text-sm text-red-800">{error}</p>{/if}
		<div class="flex gap-3">
			<button class="button" type="button" disabled={busy} onclick={() => cancel()}>{m['wordbooks.cancel']()}</button>
			<button class="button text-red-800" type="submit" disabled={busy || !canDelete || !confirmed || (choice === 'merge' && !targetId)}>{m['wordbooks.deleteBook']()}</button>
		</div>
	</form>
</dialog>
