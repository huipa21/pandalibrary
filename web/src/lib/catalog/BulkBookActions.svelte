<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { onDestroy } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import HeapDialog from '#lib/bookheap/HeapDialog.svelte';
	import Icon from '#lib/bookview/Icon.svelte';
	import { dangerButton, errorBox, primaryButton, secondaryButton } from '#lib/admin/ui.js';
	import { controlButtonClass, controlIconClass, filterControlClass } from './filter-styles.js';
	import { deleteBooks, listAllLibraries, moveBooks, type BulkBookOutcome } from './api.js';
	import type { Book, Library } from './types.js';
	import { notifyBooksChanged } from './events.js';

	type Action = 'move' | 'delete';

	let {
		selected,
		currentLibraryId,
		disabled = false,
		onfinished
	}: {
		selected: readonly Book[];
		currentLibraryId?: number;
		disabled?: boolean;
		onfinished: (action: Action, outcome: BulkBookOutcome) => void;
	} = $props();

	let dialog = $state<Action | null>(null);
	let libraries = $state<Library[]>([]);
	let destination = $state('');
	let loading = $state(false);
	let busy = $state(false);
	let error = $state('');
	let controller: AbortController | null = null;
	const ids = $derived([...new Set(selected.map((book) => book.id))]);
	const count = $derived(ids.length);

	onDestroy(() => controller?.abort());

	async function loadLibraries() {
		controller?.abort();
		const request = new AbortController();
		controller = request;
		loading = true;
		libraries = [];
		error = '';
		try {
			const items = await listAllLibraries(request.signal);
			if (request.signal.aborted) return;
			libraries = items.filter((library) => library.id !== currentLibraryId);
		} catch (cause) {
			if (request.signal.aborted) return;
			console.error('Could not load destination libraries', cause);
			error = m['catalog.selection.move_load_failure']();
		} finally {
			if (!request.signal.aborted) loading = false;
		}
	}

	function openMove() {
		if (disabled || count === 0) return;
		dialog = 'move';
		destination = '';
		error = '';
		void loadLibraries();
	}

	function openDelete() {
		if (disabled || count === 0) return;
		dialog = 'delete';
		error = '';
	}

	function close() {
		if (busy) return;
		dialog = null;
		controller?.abort();
	}

	function finish(action: Action, outcome: BulkBookOutcome) {
		if (outcome.succeeded.length > 0) {
			notifyBooksChanged();
			if (action === 'move') window.dispatchEvent(new Event('pandalibrary-libraries-changed'));
		}
		dialog = null;
		onfinished(action, outcome);
	}

	async function submitMove(event: SubmitEvent) {
		event.preventDefault();
		if (busy || loading || !destination || count === 0) return;
		const libraryId = Number(destination);
		const library = libraries.find((item) => item.id === libraryId);
		if (!library) {
			error = m['catalog.selection.move_choose']();
			return;
		}
		busy = true;
		error = '';
		try {
			finish('move', await moveBooks(ids, libraryId));
		} finally {
			busy = false;
		}
	}

	async function submitDelete() {
		if (busy || count === 0) return;
		busy = true;
		error = '';
		try {
			finish('delete', await deleteBooks(ids));
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-wrap items-center gap-2" role="group" aria-label={m['catalog.selection.actions']()}>
	<span class="text-sm text-slate-600" aria-live="polite">{m['catalog.books.selected']({ count })}</span>
	<button type="button" class={controlButtonClass} {disabled} onclick={openMove}>
		<Icon name="move" class={controlIconClass} />
		<span>{m['catalog.selection.move']()}</span>
	</button>
	<button type="button" class={`${controlButtonClass} text-red-800`} {disabled} onclick={openDelete}>
		<Icon name="trash" class={controlIconClass} />
		<span>{m['catalog.selection.delete']()}</span>
	</button>
</div>

<HeapDialog open={dialog === 'move'} id="catalog-bulk-move" title={m['catalog.selection.move_title']()} busy={busy} onclose={close}>
	<form onsubmit={submitMove} novalidate>
		<p class="mt-3 text-sm text-slate-600">{m['catalog.selection.move_description']({ count })}</p>
		{#if loading}
			<p use:showLoadingAfterDelay role="status" class="mt-3 text-sm text-slate-600">{m['catalog.loading']()}</p>
		{:else if !error && libraries.length === 0}
			<p role="status" class="mt-3 text-sm text-slate-600">{m['catalog.selection.move_empty']()}</p>
		{/if}
		<label class="mt-4 grid gap-2 text-sm font-medium">
			<span>{m['catalog.selection.destination']()}</span>
			<select class={filterControlClass} bind:value={destination} disabled={loading || busy}>
				<option value="">{m['catalog.selection.move_choose']()}</option>
				{#each libraries as library (library.id)}
					<option value={String(library.id)}>{library.name}</option>
				{/each}
			</select>
		</label>
		{#if error}
			<p role="alert" class={`mt-3 ${errorBox}`}>{error}</p>
			{#if libraries.length === 0}
				<button type="button" class="mt-2 text-sm underline" disabled={loading || busy} onclick={loadLibraries}>{m['catalog.retry']()}</button>
			{/if}
		{/if}
		<div class="mt-5 flex justify-end gap-3 border-t border-slate-200 pt-4">
			<button type="button" class={secondaryButton} disabled={busy} onclick={close}>{m['bh3.close']()}</button>
			<button type="submit" class={primaryButton} disabled={busy || loading || !destination}>
				{m['catalog.selection.move']()}
			</button>
		</div>
	</form>
</HeapDialog>

<HeapDialog open={dialog === 'delete'} id="catalog-bulk-delete" title={m['catalog.selection.delete_title']()} busy={busy} onclose={close}>
	<p class="mt-3 text-sm text-slate-700">{m['catalog.selection.delete_confirm']({ count })}</p>
	{#if error}<p role="alert" class={`mt-3 ${errorBox}`}>{error}</p>{/if}
	<div class="mt-5 flex flex-wrap justify-end gap-3 border-t border-slate-200 pt-4">
		<button type="button" class={secondaryButton} disabled={busy} onclick={close}>{m['bh3.close']()}</button>
		<button type="button" class={dangerButton} disabled={busy} onclick={submitDelete}>
			{m['catalog.selection.delete']()}
		</button>
	</div>
</HeapDialog>
