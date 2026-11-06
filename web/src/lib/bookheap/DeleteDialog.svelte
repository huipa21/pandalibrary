<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { dangerButton, errorBox, primaryButton, secondaryButton } from '#lib/admin/ui.js';
	import { deleteHeapItems } from './api.js';
	import HeapDialog from './HeapDialog.svelte';
	import BulkResults from './BulkResults.svelte';
	import { heapErrorKey, summarizeResults, type BulkOutcome } from './results.js';
	import type { HeapItem } from './types.js';

	interface Props {
		open: boolean;
		/** Selected items, captured when the dialog opened. */
		items: readonly HeapItem[];
		onclose: () => void;
		ondeleted: (outcome: BulkOutcome) => void;
	}

	let { open, items, onclose, ondeleted }: Props = $props();

	let submitting = $state(false);
	let error = $state('');
	let outcome = $state<BulkOutcome | null>(null);

	const titles = $derived(new Map(items.map((item) => [item.id, item.title])));

	$effect(() => {
		if (!open) return;
		error = '';
		outcome = null;
		submitting = false;
	});

	async function confirm() {
		if (submitting || items.length === 0) return;
		const ids = items.map((item) => item.id);
		submitting = true;
		error = '';
		try {
			const results = await deleteHeapItems(ids);
			const summary = summarizeResults('delete', ids, results, (id) => titles.get(id) ?? `#${id}`);
			ondeleted(summary);
			if (summary.failures.length === 0) onclose();
			else {
				outcome = summary;
				await tick();
				document.getElementById('bh4-delete-done')?.focus();
			}
		} catch (cause) {
			error = translate(heapErrorKey(cause, 'delete'));
		} finally {
			submitting = false;
		}
	}
</script>

<HeapDialog {open} id="bh4-delete" title={m['bh4.delete.title']()} busy={submitting} {onclose} initialFocus="[data-autofocus]">
	{#if outcome}
		<BulkResults kind="delete" {outcome} />
		<div class="mt-6 flex justify-end">
			<button type="button" class={primaryButton} id="bh4-delete-done" onclick={onclose} data-autofocus>{m['bh4.dialog.close']()}</button>
		</div>
	{:else}
		<p class="mt-2 text-sm text-slate-700">{m['bh4.delete.confirm']({ count: items.length })}</p>
		{#if error}
			<p class={`mt-4 ${errorBox}`} role="alert">{error}</p>
		{/if}
		<div class="mt-6 flex flex-wrap justify-end gap-3">
			<button type="button" class={secondaryButton} disabled={submitting} onclick={onclose} data-autofocus>{m['bh4.dialog.cancel']()}</button>
			<button type="button" class={dangerButton} disabled={submitting} onclick={confirm}>
				{submitting ? m['bh4.delete.submitting']() : m['bh4.delete.submit']({ count: items.length })}
			</button>
		</div>
	{/if}
</HeapDialog>
