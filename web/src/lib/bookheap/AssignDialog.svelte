<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { focusRing, inputClass, primaryButton, secondaryButton, errorBox } from '#lib/admin/ui.js';
	import type { Library } from '#lib/admin/types.js';
	import type { Shelf } from '#lib/shelves/types.js';
	import { assignHeapItems, MAX_ASSIGN_SHELVES } from './api.js';
	import HeapDialog from './HeapDialog.svelte';
	import BulkResults from './BulkResults.svelte';
	import { heapErrorKey, summarizeResults, type BulkOutcome } from './results.js';
	import { partitionAssignable } from './selection.svelte.js';
	import { loadAssignTargets, shelfLabel } from './targets.js';
	import type { HeapItem } from './types.js';

	interface Props {
		open: boolean;
		/** Selected items, captured when the dialog opened. */
		items: readonly HeapItem[];
		onclose: () => void;
		/** Called after the server accepted the request, with per-item outcomes. */
		onassigned: (outcome: BulkOutcome, shelfIds: number[]) => void;
	}

	let { open, items, onclose, onassigned }: Props = $props();

	let targetsStatus = $state<'loading' | 'ready' | 'error'>('loading');
	let targetsError = $state('');
	let libraries = $state<Library[]>([]);
	let shelves = $state<Shelf[]>([]);
	let libraryId = $state('');
	let shelfIds = $state<number[]>([]);
	let submitting = $state(false);
	let error = $state('');
	let libraryError = $state('');
	let outcome = $state<BulkOutcome | null>(null);
	let controller: AbortController | null = null;

	const partition = $derived(partitionAssignable(items));
	const titles = $derived(new Map(items.map((item) => [item.id, item.title])));
	const shelvesFull = $derived(shelfIds.length >= MAX_ASSIGN_SHELVES);

	$effect(() => {
		if (!open) return;
		libraryId = '';
		shelfIds = [];
		error = '';
		libraryError = '';
		outcome = null;
		submitting = false;
		void loadTargets();
		return () => controller?.abort();
	});

	async function loadTargets() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		targetsStatus = 'loading';
		targetsError = '';
		try {
			const targets = await loadAssignTargets(current.signal);
			if (current.signal.aborted) return;
			libraries = targets.libraries;
			shelves = targets.shelves;
			if (libraries.length === 1) libraryId = String(libraries[0].id);
			targetsStatus = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			targetsError = translate(heapErrorKey(cause, 'load_targets'));
			targetsStatus = 'error';
		}
	}

	function toggleShelf(id: number, checked: boolean) {
		if (checked && !shelfIds.includes(id) && !shelvesFull) shelfIds = [...shelfIds, id];
		else if (!checked) shelfIds = shelfIds.filter((shelf) => shelf !== id);
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (submitting || targetsStatus !== 'ready') return;
		const library = Number(libraryId);
		if (!Number.isInteger(library) || library <= 0) {
			libraryError = m['bh4.assign.library_required']();
			document.getElementById('bh4-assign-library')?.focus();
			return;
		}
		libraryError = '';
		const ids = partition.assignable.map((item) => item.id);
		if (ids.length === 0) return;
		const sentShelves = [...shelfIds];
		submitting = true;
		error = '';
		try {
			const results = await assignHeapItems({ ids, library_id: library, shelf_ids: sentShelves });
			const summary = summarizeResults('assign', ids, results, (id) => titles.get(id) ?? `#${id}`);
			onassigned(summary, sentShelves);
			if (summary.failures.length === 0) onclose();
			else {
				outcome = summary;
				await tick();
				document.getElementById('bh4-assign-done')?.focus();
			}
		} catch (cause) {
			error = translate(heapErrorKey(cause, 'assign'));
		} finally {
			submitting = false;
		}
	}
</script>

<HeapDialog {open} id="bh4-assign" title={m['bh4.assign.title']()} busy={submitting} {onclose} initialFocus="#bh4-assign-library">
	{#if outcome}
		<BulkResults kind="assign" {outcome} />
		<div class="mt-6 flex justify-end">
			<button type="button" id="bh4-assign-done" class={primaryButton} onclick={onclose}>{m['bh4.dialog.close']()}</button>
		</div>
	{:else}
		<p class="mt-1 text-sm text-slate-600">{m['bh4.assign.explanation']()}</p>
		<p class="mt-3 text-sm font-medium" data-testid="bh4-assign-count">
			{m['bh4.assign.count']({ count: partition.assignable.length })}
		</p>
		{#if partition.skipped.length > 0}
			<p class="mt-1 text-sm text-amber-900" data-testid="bh4-assign-skipped">
				{m['bh4.assign.skipped']({ count: partition.skipped.length })}
			</p>
		{/if}
		{#if error}
			<p class={`mt-4 ${errorBox}`} role="alert">{error}</p>
		{/if}

		{#if targetsStatus === 'loading'}
			<p class="mt-4 text-sm text-slate-600" role="status">{m['bh4.assign.loading']()}</p>
		{:else if targetsStatus === 'error'}
			<div class={`mt-4 flex flex-wrap items-center gap-3 ${errorBox}`} role="alert">
				<p>{targetsError}</p>
				<button type="button" class={`underline ${focusRing}`} onclick={loadTargets}>{m['admin.retry']()}</button>
			</div>
		{/if}

		<form class="mt-4 space-y-4" onsubmit={submit} novalidate>
			<div class="grid gap-1">
				<label for="bh4-assign-library" class="text-sm font-medium">{m['bh4.assign.library']()}</label>
				<select
					id="bh4-assign-library"
					class={inputClass}
					bind:value={libraryId}
					required
					disabled={submitting}
					aria-disabled={targetsStatus !== 'ready' ? 'true' : undefined}
					aria-busy={targetsStatus === 'loading' ? 'true' : undefined}
					aria-invalid={libraryError ? 'true' : undefined}
					aria-describedby={libraryError ? 'bh4-assign-library-error' : undefined}
				>
					<option value="">{m['bh4.assign.library_choose']()}</option>
					{#each libraries as library (library.id)}
						<option value={String(library.id)}>{library.name}</option>
					{/each}
				</select>
				{#if libraryError}
					<p id="bh4-assign-library-error" class="text-sm text-red-800">{libraryError}</p>
				{/if}
				{#if targetsStatus === 'ready' && libraries.length === 0}
					<p class="text-sm text-slate-600">
						{m['bh4.assign.no_libraries']()}
						<a class={`underline ${focusRing}`} href="/admin/libraries">{m['bh4.assign.manage_libraries']()}</a>
					</p>
				{/if}
			</div>

			<fieldset class="space-y-2" disabled={submitting || targetsStatus !== 'ready'}>
				<legend class="text-sm font-medium">{m['bh4.assign.shelves']()}</legend>
				<p class="text-xs text-slate-600">{m['bh4.assign.shelves_help']({ max: MAX_ASSIGN_SHELVES })}</p>
				{#if targetsStatus === 'ready' && shelves.length === 0}
					<p class="text-sm text-slate-600">{m['bh4.assign.no_shelves']()}</p>
				{:else}
					<ul class="max-h-48 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2">
						{#each shelves as shelf (shelf.id)}
							{@const checked = shelfIds.includes(shelf.id)}
							<li>
								<label class="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										{checked}
										disabled={!checked && shelvesFull}
										onchange={(event) => toggleShelf(shelf.id, event.currentTarget.checked)}
									/>
									<span>{shelfLabel(shelf)}</span>
									{#if shelf.kind === 'shared'}<span class="text-xs text-slate-500">({m['shelves.kind.shared']()})</span>{/if}
								</label>
							</li>
						{/each}
					</ul>
				{/if}
			</fieldset>

			<div class="flex flex-wrap justify-end gap-3 pt-2">
				<button type="button" class={secondaryButton} disabled={submitting} onclick={onclose}>{m['bh4.dialog.cancel']()}</button>
				<button
					type="submit"
					class={primaryButton}
					disabled={submitting || targetsStatus !== 'ready' || partition.assignable.length === 0}
				>{submitting ? m['bh4.assign.submitting']() : m['bh4.assign.submit']({ count: partition.assignable.length })}</button>
			</div>
		</form>
	{/if}
</HeapDialog>
